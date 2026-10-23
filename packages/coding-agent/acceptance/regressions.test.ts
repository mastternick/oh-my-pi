import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type Evidence,
	CMD,
	callBash,
	flatten,
	getMnemopiSessionState,
	installExtractor,
	Lab,
	lessonReply,
	parserSession,
	parserSolution,
	ref,
	say,
	startEmbeddingStub,
	turn,
} from "./support.ts";

const PROMPT = "Fix the parser empty input crash so sh verify.sh passes.";
const PARSER_TITLE = "Parser empty input crash";
const REV2 = "rev2-guard-marker";
const FILLER = "context detail ".repeat(20);

/** Deterministic row identity for cross-bank immutability checks: db, table, id and content hashed together. */
function rowHash(row: { db: string; table: string; id: string; content: string }): string {
	return new Bun.CryptoHasher("sha256").update(`${row.db}\0${row.table}\0${row.id}\0${row.content}`).digest("hex");
}

/** Fresh probe session in `repo`; returns the context the model saw on its first call. */
async function probeContext(lab: Lab, repo: string, prompt = PROMPT): Promise<string> {
	const probe = await lab.session({ cwd: repo, responses: ["ok"] });
	await turn(probe.session, prompt);
	return flatten(probe.mock.calls[0]!.context);
}

describe("AdmissionReview regressions", () => {
	let lab: Lab;
	beforeEach(() => {
		lab = new Lab();
	});
	afterEach(() => lab.close());

	it("R1: a check that never touches the lesson's evidence does not admit the lesson", async () => {
		const repo = lab.repo("login", { "src/login.txt": "" });
		const session = await lab.session({
			cwd: repo,
			responses: [callBash("printf login > src/login.txt"), callBash('echo "widget test: PASS"'), say("done")],
		});
		installExtractor((evidence) =>
			lessonReply(
				parserSolution([ref(evidence, "widget test", true)], {
					title: "Login session edit",
					situation: "login session",
					problem: "login session fails without a login value",
					rootCause: "src/login.txt lacks the login value",
					solution: "Write login to src/login.txt so the login session works",
					evidence: "login edit applied to src/login.txt",
					scope: "login module",
					conditions: ["src/login.txt"],
				}),
			),
		);
		await turn(session.session, "Make the login session work.");

		expect(lab.currentLessons(lab.dbPaths(session.session)).map(row => row.content)).toEqual([]);
	});

	it("R1 adversarial: a relevant edit plus an unrelated passing check does not admit the lesson", async () => {
		// Attack: relevance comes from the cited edit (token overlap with the claim), the check class from a
		// different cited command on an unrelated path. No passing check is relevant to the solution claim.
		const repo = lab.repo("login", { "src/login.txt": "" });
		const session = await lab.session({
			cwd: repo,
			responses: [
				callBash("printf login > src/login.txt"),
				callBash("sh docs-lint.sh"),
				say("done"),
			],
		});
		fs.writeFileSync(path.join(repo, "docs-lint.sh"), "#!/bin/sh\necho 'docs lint: PASS'\n");
		installExtractor((evidence) =>
			lessonReply(
				parserSolution(
					[ref(evidence, "src/login.txt", true), ref(evidence, "docs-lint", true)],
					{
						title: "Login session edit",
						situation: "login session",
						problem: "login session fails without a login value",
						rootCause: "src/login.txt lacks the login value",
						solution: "Write login to src/login.txt so the login session works",
						evidence: "login edit applied to src/login.txt",
						scope: "login module",
						conditions: ["src/login.txt"],
					},
				),
			),
		);
		await turn(session.session, "Make the login session work.");

		expect(lab.currentLessons(lab.dbPaths(session.session)).map(row => row.content)).toEqual([]);
	});

	it("R2: a merged body with an unsupported procedure is rejected", async () => {
		const repo = lab.fixture("parser");
		let update: Record<string, unknown> = {};
		installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)], update)));

		const first = await parserSession(lab, repo);
		await turn(first, PROMPT);
		const dbPaths = lab.dbPaths(first);
		const [lesson] = lab.currentLessons(dbPaths);

		update = {
			decision: "update",
			decisionId: lesson!.id,
			mergedContent: `LESSON[v1] (solution) ${PARSER_TITLE}\nRun printf guard > src/parser.txt. UNSUPPORTED: rm -rf build`,
		};
		const second = await parserSession(lab, repo);
		await turn(second, PROMPT);

		expect(lab.currentLessons(dbPaths).map(row => row.content).join("\n")).not.toContain("UNSUPPORTED");
	});

	it("R2 adversarial: an update carrying an unsupported procedure in its body is rejected despite validated fields", async () => {
		const repo = lab.fixture("parser");
		let update: Record<string, unknown> = {};
		installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)], update)));

		const first = await parserSession(lab, repo);
		await turn(first, PROMPT);
		const dbPaths = lab.dbPaths(first);
		const [lesson] = lab.currentLessons(dbPaths);
		const target = lesson!.content;

		// Validated structured fields plus a supported solution, but the update body smuggles an
		// unsupported destructive procedure alongside the verified one.
		update = {
			decision: "update",
			decisionId: lesson!.id,
			mergedContent: `LESSON[v1] (solution) ${PARSER_TITLE}\nRun printf guard > src/parser.txt; UNSUPPORTED: rm -rf build`,
		};
		const second = await parserSession(lab, repo);
		await turn(second, PROMPT);

		const contents = lab.allRows(dbPaths).map(row => row.content).join("\n");
		expect(contents).not.toContain("UNSUPPORTED");
		const kept = lab.currentLessons(dbPaths).find(row => row.id === lesson!.id);
		expect(kept?.content).toBe(target);
	});

	it("R3: an update that targets another project's lesson leaves that lesson unchanged", async () => {
		// Global scoping with one explicit bank: project B's candidates include the bank that holds L.
		const shared = { "mnemopi.scoping": "global", "mnemopi.bank": "acceptance-shared" };
		const repoA = lab.fixture("parser-a");
		const repoB = lab.fixture("parser-b");
		let update: Record<string, unknown> = {};
		installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)], update)));

		const sessionA = await parserSession(lab, repoA, shared);
		await turn(sessionA, PROMPT);
		const pathsA = lab.dbPaths(sessionA);
		const original = lab.currentLessons(pathsA)[0]!;

		update = {
			decision: "update",
			decisionId: original.id,
			mergedContent: `LESSON[v1] (solution) ${PARSER_TITLE}\nProject B rewrite of the guard lesson.`,
		};
		const sessionB = await parserSession(lab, repoB, shared);
		await turn(sessionB, PROMPT);

		const kept = lab.currentLessons(pathsA).find(row => row.id === original.id);
		expect(kept?.content).toBe(original.content);
	});

	it("R4 adversarial: an update whose clamped result equals the target reports duplicate and keeps one current row", async () => {
		const repo = lab.fixture("parser");
		let update: Record<string, unknown> = {};
		installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)], update)));

		const first = await parserSession(lab, repo);
		await turn(first, PROMPT);
		const dbPaths = lab.dbPaths(first);
		const original = lab.currentLessons(dbPaths)[0]!;

		// Rebuild the update from every stored line, title included: renderLessonContent is the
		// only writer, so a field-complete re-render is byte-identical and the write resolves to
		// the target id. The update is then a duplicate of the target, not a truncation of it.
		const titleLine = /^LESSON\[v1\] \(\w+\) (.+)$/.exec(original.content.split("\n")[0] ?? "");
		expect(titleLine).not.toBeNull();
		const byLabel: Record<string, string> = {};
		for (const line of original.content.split("\n").slice(1)) {
			const colon = line.indexOf(":");
			if (colon > 0) byLabel[line.slice(0, colon)] = line.slice(colon + 2);
		}
		update = {
			decision: "update",
			decisionId: original.id,
			title: titleLine?.[1] ?? PARSER_TITLE,
			situation: byLabel["Situation"] ?? "",
			problem: byLabel["Problem"] ?? "",
			rootCause: byLabel["Root cause"] ?? "",
			solution: byLabel["Proven solution"] ?? "",
			pitfall: byLabel["Pitfall"] ?? "",
			evidence: byLabel["Evidence"] ?? "",
			scope: byLabel["Scope"] ?? "",
			conditions: (byLabel["Conditions"] ?? "").split(", ").filter(Boolean),
		};
		const second = await parserSession(lab, repo);
		await turn(second, PROMPT);

		expect(lab.currentLessons(dbPaths).map(row => ({ id: row.id, content: row.content }))).toEqual([
			{ id: original.id, content: original.content },
		]);
		const probe = await probeContext(lab, repo);
		expect(probe).toContain(PARSER_TITLE);
	});

	it("R4: an unchanged update does not retire the lesson it targets", async () => {
		const repo = lab.fixture("parser");
		let update: Record<string, unknown> = {};
		installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)], update)));

		const first = await parserSession(lab, repo);
		await turn(first, PROMPT);
		const dbPaths = lab.dbPaths(first);
		const original = lab.currentLessons(dbPaths)[0]!;

		update = { decision: "update", decisionId: original.id, mergedContent: original.content };
		const second = await parserSession(lab, repo);
		await turn(second, PROMPT);

		expect(lab.currentLessons(dbPaths).map(row => row.id)).toEqual([original.id]);
		expect(await probeContext(lab, repo)).toContain(PARSER_TITLE);
	});

	it("R5: embeddings are written before the capture is reported done", async () => {
		const repo = lab.fixture("parser");
		const EMBED_MODEL = "acceptance-embed";
		const stub = startEmbeddingStub(EMBED_MODEL);
		try {
			const session = await parserSession(lab, repo, {
				"mnemopi.noEmbeddings": false,
				"mnemopi.embeddingApiUrl": stub.url,
				"mnemopi.embeddingModel": EMBED_MODEL,
				"mnemopi.embeddingApiKey": "test-key",
			});
			installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)])));
			await session.prompt(PROMPT);
			await getMnemopiSessionState(session)?.pendingExperienceCapture();

			const lesson = lab.currentLessons(lab.dbPaths(session))[0]!;
			expect(lesson.db.startsWith(lab.root + path.sep)).toBe(true);
			const db = new Database(lesson.db, { readonly: true });
			try {
				const row = db.query("SELECT COUNT(*) AS count FROM memory_embeddings WHERE memory_id = ?").get(lesson.id) as {
					count: number;
				};
				expect(row.count).toBeGreaterThan(0);
			} finally {
				db.close();
			}
		} finally {
			stub.stop();
		}
	});

	it("R6: a failed check alone admits a negative lesson", async () => {
		const repo = lab.fixture("parser");
		const session = await lab.session({ cwd: repo, responses: [callBash(CMD.verify), say("done")] });
		installExtractor(evidence =>
			lessonReply(
				parserSolution([ref(evidence, CMD.verify, false)], {
					kind: "negative",
					title: "Avoid skipping the guard",
					solution: "",
					pitfall: "Avoid skipping the guard token in src/parser.txt; sh verify.sh fails without it.",
				}),
			),
		);
		await turn(session.session, PROMPT);

		const contents = lab.currentLessons(lab.dbPaths(session.session)).map(row => row.content).join("\n");
		expect(contents).toContain("Avoid skipping the guard");
	});

	it("R6: a solution with a passing check and a failed attempt is admitted", async () => {
		const repo = lab.fixture("parser");
		const TITLE = "Guard fix after failed empty input check";
		installExtractor(evidence =>
			lessonReply(
				parserSolution([ref(evidence, CMD.verify, true), ref(evidence, CMD.verify, false)], {
					title: TITLE,
					pitfall: "The first sh verify.sh run fails until the guard token is written.",
				}),
			),
		);
		const session = await parserSession(lab, repo);
		await turn(session, PROMPT);

		const contents = lab.currentLessons(lab.dbPaths(session)).map(row => row.content).join("\n");
		expect(contents).toContain(TITLE);
	});

	it("R7: a legacy-style update keeps the conditions it was given", async () => {
		const repo = lab.fixture("parser");
		let update: Record<string, unknown> = {};
		installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)], update)));

		const first = await parserSession(lab, repo);
		await turn(first, PROMPT);
		const dbPaths = lab.dbPaths(first);
		const original = lab.currentLessons(dbPaths)[0]!;

		fs.writeFileSync(path.join(repo, "src", "extra.txt"), "v1");
		update = {
			decision: "update",
			decisionId: original.id,
			solution: `Run printf guard > src/parser.txt so sh verify.sh passes; ${REV2}`,
			mergedContent: `LESSON[v1] (solution) ${PARSER_TITLE}\nRun printf guard > src/parser.txt so sh verify.sh passes; ${REV2}`,
			conditions: ["src/parser.txt", "src/extra.txt"],
		};
		const second = await parserSession(lab, repo);
		await turn(second, PROMPT);

		expect(lab.currentLessons(dbPaths).map(row => row.content).join("\n")).toContain(REV2);
		expect(await probeContext(lab, repo)).toContain(REV2);

		fs.writeFileSync(path.join(repo, "src", "extra.txt"), "v2");
		expect(await probeContext(lab, repo)).not.toContain(REV2);
	});

	it("R8: lessons whose conditions cannot be verified are not stored", async () => {
		const repo = lab.fixture("parser");
		const XTITLE = "Hostname config lesson";
		const YTITLE = "Outside file lesson";
		const ZTITLE = "Parser guard lesson";
		let batch: (evidence: Evidence[]) => Record<string, unknown>[] = () => [];
		installExtractor(evidence => lessonReply(...batch(evidence)));

		const first = await parserSession(lab, repo);
		batch = evidence => [
			parserSolution([ref(evidence, CMD.verify, true)], { title: XTITLE, conditions: ["/etc/hostname"] }),
			parserSolution([ref(evidence, CMD.verify, true)], { title: YTITLE, conditions: ["../outside.txt"] }),
		];
		await turn(first, PROMPT);
		expect(lab.currentLessons(lab.dbPaths(first))).toEqual([]);

		const second = await parserSession(lab, repo);
		batch = evidence => [
			parserSolution([ref(evidence, CMD.verify, true)], { title: ZTITLE, conditions: ["src/parser.txt"] }),
		];
		await turn(second, PROMPT);

		const contents = lab.currentLessons(lab.dbPaths(second)).map(row => row.content).join("\n");
		expect(contents).toContain(ZTITLE);
		expect(contents).not.toContain(XTITLE);
		expect(contents).not.toContain(YTITLE);
	});

	it("R10: schema labels do not make a lesson relevant to an unrelated probe", async () => {
		const repo = lab.repo("styles", {
			"verify-css.sh": "#!/bin/sh\nif grep -q card styles.css; then echo 'PASS .card selector specificity ok in styles.css'; else echo 'FAIL .card selector specificity'; exit 1; fi\n",
			"styles.css": ".card{}",
		});
		const TITLE = "Stylesheet specificity fix";
		const session = await lab.session({ cwd: repo, responses: [callBash("sh verify-css.sh"), say("done")] });
		installExtractor(evidence =>
			lessonReply(
				parserSolution([ref(evidence, "verify-css", true)], {
					title: TITLE,
					situation: "stylesheet selector overridden",
					problem: "sh verify-css.sh fails: .card stylesheet specificity",
					rootCause: "Root cause: later rule overrides .card selector specificity",
					solution: "Raise .card selector specificity in styles.css so sh verify-css.sh passes",
					evidence: "sh verify-css.sh passed with .card selector specificity ok in styles.css",
					scope: "styles",
					conditions: ["styles.css"],
				}),
			),
		);
		await turn(session.session, "Fix stylesheet specificity so sh verify-css.sh passes.");
		expect(lab.currentLessons(lab.dbPaths(session.session)).map(row => row.content).join("\n")).toContain(TITLE);

		expect(await probeContext(lab, repo, "Investigate root cause of database migration failure.")).not.toContain(TITLE);
	});

	it("R11: a failed invalidation leaves the old lesson current and adds no replacement", async () => {
		const repo = lab.fixture("parser");
		let update: Record<string, unknown> = {};
		installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)], update)));

		const first = await parserSession(lab, repo);
		await turn(first, PROMPT);
		const dbPaths = lab.dbPaths(first);
		const original = lab.currentLessons(dbPaths)[0]!;
		expect(original.db.startsWith(lab.root + path.sep)).toBe(true);

		const db = new Database(original.db);
		db.run(
			`CREATE TRIGGER block_invalidation BEFORE UPDATE OF valid_until ON ${original.table} ` +
				"WHEN NEW.valid_until IS NOT NULL BEGIN SELECT RAISE(ABORT, 'invalidation blocked'); END",
		);
		try {
			update = {
				decision: "update",
				decisionId: original.id,
				solution: "Run printf guard > src/parser.txt; sh verify.sh passes after the replacement",
				mergedContent: `LESSON[v1] (solution) ${PARSER_TITLE}\nReplacement body with new steps.`,
			};
			const second = await parserSession(lab, repo);
			await turn(second, PROMPT);
		} finally {
			db.run("DROP TRIGGER IF EXISTS block_invalidation");
			db.close();
		}

		const current = lab.currentLessons(dbPaths);
		expect(current.map(row => ({ id: row.id, content: row.content }))).toEqual([
			{ id: original.id, content: original.content },
		]);
	});

	it("R13: an over-budget lesson is rejected, never truncated into storage", async () => {
		const repo = lab.fixture("parser");
		const OVERSIZE = FILLER.repeat(3); // 900 chars per field, above MAX_FIELD_CHARS (600)
		installExtractor(evidence =>
			lessonReply(
				parserSolution([ref(evidence, CMD.verify, true)], {
					situation: OVERSIZE,
					problem: OVERSIZE,
					rootCause: OVERSIZE,
				}),
			),
		);
		const session = await parserSession(lab, repo);
		await turn(session, PROMPT);

		// experience.ts budgetViolation: over-budget lessons are rejected, never truncated.
		expect(lab.currentLessons(lab.dbPaths(session))).toEqual([]);
	});

	it("R13 control: the same lesson within budget is stored", async () => {
		const repo = lab.fixture("parser");
		installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)])));
		const session = await parserSession(lab, repo);
		await turn(session, PROMPT);
		expect(lab.currentLessons(lab.dbPaths(session))).toHaveLength(1);
	});

	it("R3 adversarial: an update resolving to another bank's row leaves that row untouched", async () => {
		const SHARED_BANK = "acceptance-shared-legacy";
		const LEGACY_TITLE = "Shared legacy guard lesson";
		const REWRITE = "Live re-verification rewrite of the shared guard lesson";
		const shared = { "mnemopi.scoping": "global", "mnemopi.bank": SHARED_BANK };
		const repoA = lab.fixture("parser-legacy");
		const repoB = lab.fixture("parser-legacy-b");

		// Session A stores the lesson into the shared bank, in legacy-style content.
		installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)], { title: LEGACY_TITLE })));
		const sessionA = await parserSession(lab, repoA, shared);
		await turn(sessionA, PROMPT);
		const dbPaths = lab.dbPaths(sessionA);
		const legacy = lab.currentLessons(dbPaths).find(row => row.content.includes(LEGACY_TITLE));
		if (!legacy) throw new Error(`no lesson row found in ${SHARED_BANK}`);

		// Hash of the seeded row: unchanged when session B's update is correctly rejected.
		const before = rowHash(legacy);

		// Session B: same shared bank, different project. Its update names the row found above.
		const sessionB = await lab.session({
			cwd: repoB,
			responses: [
				callBash(CMD.verify),
				callBash(CMD.fix),
				callBash(CMD.verify),
				say("done"),
			],
			overrides: shared,
		});
		installExtractor(evidence =>
			lessonReply(
				parserSolution([ref(evidence, CMD.verify, true)], {
					decision: "update",
					decisionId: legacy.id,
					mergedContent: `LESSON[v1] (solution) ${LEGACY_TITLE}\n${REWRITE}`,
				}),
			),
		);
		await turn(sessionB.session, PROMPT);

		const after = rowHash(legacy);
		expect(after).toBe(before);
		expect(lab.currentLessons(dbPaths).map(row => row.content).join("\n")).not.toContain(REWRITE);
		expect(lab.currentLessons(dbPaths).some(row => row.id === legacy.id)).toBe(true);
	});
});
