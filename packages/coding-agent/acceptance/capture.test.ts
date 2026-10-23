import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ExperienceLesson, verifyEvidenceGate } from "@oh-my-pi/pi-coding-agent/mnemopi/experience";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	callBash,
	CMD,
	installExtractor,
	Lab,
	LESSON_PREFIX,
	lessonReply,
	parserSession,
	parserSolution,
	ref,
	say,
	turn,
} from "./support.ts";

const PROMPT = "Fix the parser empty input crash so sh verify.sh passes.";

/** Pitfall lesson: cites only the observed failure, so it claims no working solution. */
const PITFALL: Readonly<Record<string, unknown>> = {
	kind: "pitfall",
	title: "Guard-less parser keeps verify failing",
	problem: "sh verify.sh fails on empty input",
	solution: "",
	pitfall: "Parser input without the guard token keeps sh verify.sh failing on empty input.",
	evidence: "sh verify.sh failed: empty input crashes length check",
};

/** Failing verify, wrong edit, failing verify, wrong edit, fix, passing verify, then a text reply. */
async function runFailedAttempts(lab: Lab, repo: string) {
	const { session } = await lab.session({
		cwd: repo,
		responses: [
			callBash(CMD.verify),
			callBash(CMD.wrong),
			callBash(CMD.verify),
			callBash(CMD.wrong),
			callBash(CMD.fix),
			callBash(CMD.verify),
			say("done"),
		],
	});
	const extractor = installExtractor(evidence =>
		lessonReply(
			parserSolution([ref(evidence, CMD.verify, true)]),
			parserSolution([ref(evidence, CMD.verify, false)], PITFALL),
		),
	);
	await turn(session, PROMPT);
	return { session, extractor };
}

/** One parser session: failing verify, fix, passing verify, text. Same steps as learnParser, without its extractor. */
async function runParserSession(lab: Lab, repo: string): Promise<AgentSession> {
	const session = await parserSession(lab, repo);
	await turn(session, PROMPT);
	return session;
}

describe("D", () => {
	let lab: Lab;
	beforeEach(() => {
		lab = new Lab();
	});
	afterEach(() => lab.close());

	it("D: stores the proven lesson and the pitfall, not the attempt history", async () => {
		const repo = lab.fixture("parser");
		const { session } = await runFailedAttempts(lab, repo);
		const dbPaths = lab.dbPaths(session);

		const rows = lab.currentLessons(dbPaths);
		expect(rows.length).toBeGreaterThanOrEqual(1);
		expect(rows.length).toBeLessThanOrEqual(2);
		expect(lab.allRows(dbPaths).filter(row => row.content.includes(CMD.wrong))).toEqual([]);
	});

	it("D unit: failed-only proof is rejected; passing proof with a pitfall is admitted", async () => {
		const repo = lab.fixture("parser");
		const { extractor } = await runFailedAttempts(lab, repo);
		expect(extractor.seen).toHaveLength(1);
		const evidence = extractor.seen[0]!.evidence;
		const pass = ref(evidence, CMD.verify, true);
		const fail = ref(evidence, CMD.verify, false);

		// Cast: the gate reads only the string fields of the lesson, which parserSolution provides.
		const failedOnly = parserSolution([fail]) as unknown as ExperienceLesson;
		// A failed attempt is negative evidence, so it rides along as the pitfall next to the passing proof.
		const passAndFail = parserSolution([pass, fail], { pitfall: PITFALL.pitfall }) as unknown as ExperienceLesson;
		const passOnly = parserSolution([pass]) as unknown as ExperienceLesson;

		expect(verifyEvidenceGate(failedOnly, evidence, "success").ok).toBe(false);
		expect(verifyEvidenceGate(passAndFail, evidence, "success").ok).toBe(true);
		expect(verifyEvidenceGate(passOnly, evidence, "success").ok).toBe(true);
	});
});

describe("E", () => {
	let lab: Lab;
	beforeEach(() => {
		lab = new Lab();
	});
	afterEach(() => lab.close());

	it("E: repeated discoveries of the same lesson leave one current lesson", async () => {
		const repo = lab.fixture("parser");
		let decision: "new" | "duplicate" = "new";
		const extractor = installExtractor(evidence =>
			lessonReply(parserSolution([ref(evidence, CMD.verify, true)], { decision })),
		);

		await runParserSession(lab, repo);

		await runParserSession(lab, repo);

		decision = "duplicate";
		const third = await runParserSession(lab, repo);

		expect(extractor.seen).toHaveLength(3);
		const rows = lab.currentLessons(lab.dbPaths(third));
		expect(rows).toHaveLength(1);
		expect(rows[0]!.content).toContain(LESSON_PREFIX);
	});
});
