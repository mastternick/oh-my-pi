import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { captureSubagentExperienceOnSettle } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import {
	type Built,
	CMD,
	callBash,
	flatten,
	installExtractor,
	Lab,
	learnParser,
	lessonReply,
	parserSolution,
	ref,
	say,
	settle,
	startEmbeddingStub,
	startEmbeddingStubProcess,
	turn,
} from "./support.ts";

const Count = type({ count: "number" });

const PROMPT = "Fix the parser empty input crash so sh verify.sh passes.";
const PARSER_TITLE = "Parser empty input crash";

/**
 * Three workers learn three different lessons. Each one fixes parser.txt with its own token, so the extractor
 * can route on the evidence it receives. Titles and fields share no words with the probe prompt except in
 * the lesson it targets.
 */
const VARIANTS = [
	{
		title: PARSER_TITLE,
		fix: "printf guard_1 > src/parser.txt",
		lesson: { solution: "Run printf guard_1 > src/parser.txt so sh verify.sh passes", scope: "parser module" },
	},
	{
		title: "Tokenizer quotation flaw",
		fix: "printf guard_2 > src/parser.txt",
		lesson: {
			situation: "tokenizer quoting check",
			problem: "sh verify.sh fails: unbalanced quotes reach the tokenizer",
			rootCause: "src/parser.txt lacks guard_2 marker",
			solution: "Run printf guard_2 > src/parser.txt so sh verify.sh passes",
			scope: "tokenizer module",
		},
	},
	{
		title: "Config loader cache staleness",
		fix: "printf guard_3 > src/parser.txt",
		lesson: {
			situation: "config loader reload check",
			problem: "sh verify.sh fails: cached configuration survives reload",
			rootCause: "src/parser.txt lacks guard_3 marker",
			solution: "Run printf guard_3 > src/parser.txt so sh verify.sh passes",
			scope: "config loader",
		},
	},
];

describe("I: persistence and safety", () => {
	let lab: Lab;
	beforeEach(() => {
		lab = new Lab();
	});
	afterEach(() => lab.close());

	it("I: a", async () => {
		const repo = lab.fixture("parser");
		const dbPaths = await learnParser(lab, repo);

		resetMemoryForTests();

		const restarted = await lab.session({ cwd: repo, responses: ["ok"] });
		await turn(restarted.session, PROMPT);

		expect(flatten(restarted.mock.calls[0]!.context)).toContain(PARSER_TITLE);
		expect(lab.integrityOk(dbPaths)).toBe(true);
	});

	it("I: b", async () => {
		const repo = lab.fixture("parser");
		const parent = await lab.session({ cwd: repo, responses: ["ok"] });
		const children: Built[] = [];
		for (const variant of VARIANTS) {
			children.push(
				await lab.child(parent.session, {
					cwd: repo,
					responses: [callBash(CMD.verify), callBash(variant.fix), callBash(CMD.verify), say("done")],
				}),
			);
		}

		installExtractor(evidence => {
			const variant = VARIANTS.find(entry => evidence.some(item => item.request.includes(entry.fix)));
			if (!variant) throw new Error("no lesson variant matches the captured evidence");
			return lessonReply(
				parserSolution([ref(evidence, CMD.verify, true)], { title: variant.title, ...variant.lesson }),
			);
		});

		// Children run one at a time; each starts from an empty parser.txt.
		for (const child of children) {
			fs.writeFileSync(path.join(repo, "src/parser.txt"), "");
			await turn(child.session, PROMPT);
		}

		await Promise.all(
			children.map((child, index) =>
				captureSubagentExperienceOnSettle({
					session: child.session,
					assignment: PROMPT,
					agentName: `worker-${index + 1}`,
				}),
			),
		);

		const dbPaths = lab.dbPaths(parent.session);
		const lessons = lab.currentLessons(dbPaths);
		expect(lessons).toHaveLength(3);
		expect(new Set(lessons.map(row => row.content)).size).toBe(3);
		for (const variant of VARIANTS) {
			expect(lessons.some(row => row.content.includes(variant.title))).toBe(true);
		}
		expect(lab.integrityOk(dbPaths)).toBe(true);

		const probe = await lab.session({ cwd: repo, responses: ["ok"] });
		await turn(probe.session, "Investigate the tokenizer quotation flaw.");
		const context = flatten(probe.mock.calls[0]!.context);

		expect(context).toContain(VARIANTS[1]!.title);
		expect(context).not.toContain(VARIANTS[0]!.title);
		expect(context).not.toContain(VARIANTS[2]!.title);
		expect(context).not.toContain("guard_1");
		expect(context).not.toContain("guard_3");
	});

	it("I: c", async () => {
		const repo = lab.fixture("parser");
		const EMBED_MODEL = "acceptance-embed";
		const stub = startEmbeddingStub(EMBED_MODEL);
		try {
			const overrides = {
				"mnemopi.noEmbeddings": false,
				"mnemopi.embeddingApiUrl": stub.url,
				"mnemopi.embeddingModel": EMBED_MODEL,
				"mnemopi.embeddingApiKey": "test-key",
			};
			const learner = await lab.session({
				cwd: repo,
				responses: [callBash(CMD.verify), callBash(CMD.fix), callBash(CMD.verify), say("fixed")],
				overrides,
			});
			installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)])));
			await turn(learner.session, PROMPT);

			const dbPaths = lab.dbPaths(learner.session);
			expect(stub.posts).toBeGreaterThan(0);

			let embeddingRows = 0;
			for (const file of dbPaths) {
				if (!fs.existsSync(file)) continue;
				expect(file.startsWith(lab.root + path.sep)).toBe(true);
				const db = new Database(file, { readonly: true });
				try {
					embeddingRows += Count.assert(db.query("SELECT COUNT(*) AS count FROM memory_embeddings").get()).count;
				} finally {
					db.close();
				}
			}
			expect(embeddingRows).toBeGreaterThan(0);

			const probe = await lab.session({ cwd: repo, responses: ["ok"], overrides });
			await turn(probe.session, PROMPT);
			expect(flatten(probe.mock.calls[0]!.context)).toContain(PARSER_TITLE);
		} finally {
			stub.stop();
		}
	});

	it("I: d", async () => {
		const repo = lab.fixture("parser");
		const dbPaths = await learnParser(lab, repo);

		expect(dbPaths.length).toBeGreaterThan(0);
		for (const file of dbPaths) {
			expect(file.startsWith(lab.root + path.sep)).toBe(true);
		}
	});

	it("I adversarial: a paraphrase duplicate arriving while embeddings flush yields one current lesson", async () => {
		const repo = lab.fixture("parser");
		const EMBED_MODEL = "acceptance-embed";
		const stub = startEmbeddingStub(EMBED_MODEL);
		try {
			const overrides = {
				"mnemopi.noEmbeddings": false,
				"mnemopi.embeddingApiUrl": stub.url,
				"mnemopi.embeddingModel": EMBED_MODEL,
				"mnemopi.embeddingApiKey": "test-key",
			};
			// Two runs, one bank: identical capture steps, so capture A's flush can still be in
			// flight when capture B's dedupe surface is collected. B's lesson is a paraphrase.
			const responses = [
				callBash(CMD.verify),
				callBash(CMD.fix),
				callBash(CMD.verify),
				say("fixed"),
			];
			const captureA = await lab.session({ cwd: repo, responses, overrides });
			installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)])));
			await captureA.session.prompt(PROMPT);

			const captureB = await lab.session({ cwd: repo, responses, overrides });
			const PARAPHRASE = "Configured the parser guard token so the verify script passes";
			// P1-5 acceptance: capture A's lesson row exists while its embedding flush may still be
			// in flight, and the deterministic scan must put it in B's dedupe surface anyway. An
			// honest extractor then reports the paraphrase as a duplicate of it; the run must reject
			// the duplicate and keep exactly one current lesson.
			const extractorB = installExtractor((evidence, candidates) => {
				const fields = {
					solution: PARAPHRASE,
					evidence: "sh verify.sh passes after the parser guard token is configured",
				};
				const known = candidates.find(candidate => candidate.content.includes(PARSER_TITLE));
				if (known === undefined) return lessonReply(parserSolution([ref(evidence, CMD.verify, true)], fields));
				return lessonReply({
					...parserSolution([ref(evidence, CMD.verify, true)], fields),
					decision: "duplicate",
					decisionId: known.id,
				});
			});
			await captureB.session.prompt(PROMPT);

			await settle(captureA.session);
			await settle(captureB.session);

			expect(extractorB.seen[0]?.candidates.some(candidate => candidate.content.includes(PARSER_TITLE))).toBe(true);
			const lessons = lab.currentLessons(lab.dbPaths(captureB.session));
			expect(lessons).toHaveLength(1);
			expect(lessons[0]!.content).toContain(PARSER_TITLE);
			expect(lab.integrityOk(lab.dbPaths(captureB.session))).toBe(true);
		} finally {
			stub.stop();
		}
	});

	it("I:e: the embeddings endpoint runs in a separate OS process", async () => {
		const repo = lab.fixture("parser");
		const EMBED_MODEL = "acceptance-embed";
		const counter = path.join(lab.root, "embed-stub-posts.txt");
		const stub = await startEmbeddingStubProcess(EMBED_MODEL, counter);
		try {
			const learner = await lab.session({
				cwd: repo,
				responses: [callBash(CMD.verify), callBash(CMD.fix), callBash(CMD.verify), say("fixed")],
				overrides: {
					"mnemopi.noEmbeddings": false,
					"mnemopi.embeddingApiUrl": stub.url,
					"mnemopi.embeddingModel": EMBED_MODEL,
					"mnemopi.embeddingApiKey": "test-key",
				},
			});
			installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)])));
			await turn(learner.session, PROMPT);

			let embeddingRows = 0;
			for (const file of lab.dbPaths(learner.session)) {
				if (!fs.existsSync(file)) continue;
				expect(file.startsWith(lab.root + path.sep)).toBe(true);
				const db = new Database(file, { readonly: true });
				try {
					embeddingRows += Count.assert(db.query("SELECT COUNT(*) AS count FROM memory_embeddings").get()).count;
				} finally {
					db.close();
				}
			}
			expect(embeddingRows).toBeGreaterThan(0);

		// The endpoint ran in a separate OS process: different pid, and it served the POSTs.
		expect(stub.childPid).toBeGreaterThan(0);
		expect(stub.childPid).not.toBe(process.pid);
		const { served } = await stub.stop();
		expect(served).toBeGreaterThan(0);
		} finally {
			await stub.stop();
		}
	});
});
