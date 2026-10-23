import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	type Evidence,
	CMD,
	flatten,
	installExtractor,
	Lab,
	lessonReply,
	NO_LESSONS,
	parserSession,
	parserSolution,
	ref,
	turn,
	VERIFY_SCRIPT,
} from "./support.ts";

const PROMPT = "Fix the parser empty input crash so sh verify.sh passes.";
const TITLE_A = "Parser empty input crash";
const TITLE_B = "Parser guard token rewrite";

/** Same check, different bytes: the guard logic is unchanged but the verify.sh fingerprint moves. */
const DRIFTED_VERIFY = `${VERIFY_SCRIPT}# guard check drift v2\n`;

/** Fresh probe session in `repo`; returns the context the model saw on its first call. */
async function probeContext(lab: Lab, repo: string): Promise<string> {
	const probe = await lab.session({ cwd: repo, responses: ["ok"] });
	await turn(probe.session, PROMPT);
	return flatten(probe.mock.calls[0]!.context);
}

/**
 * Installs the extraction with a mutable lesson builder. Probe sessions collect no check evidence,
 * so their capture answers NO_LESSONS and never writes; scripted fix sessions cite the passing verify.
 */
function installScriptedExtractor(lab: Lab, build: { current: (evidence: Evidence[]) => Record<string, unknown> }) {
	return installExtractor(evidence => {
		if (!evidence.some(entry => entry.ok && entry.request.includes(CMD.verify))) return NO_LESSONS;
		return lessonReply(build.current(evidence));
	});
}

describe("canonical updates", () => {
	let lab: Lab;
	beforeEach(() => {
		lab = new Lab();
	});
	afterEach(() => lab.close());

	it("a re-verified identical lesson refreshes drifted condition fingerprints", async () => {
		const repo = lab.fixture("refresh");
		const build = { current: (evidence: Evidence[]) => parserSolution([ref(evidence, CMD.verify, true)]) };
		installScriptedExtractor(lab, build);

		// Learn the verified lesson conditioned on verify.sh and src/parser.txt.
		const first = await parserSession(lab, repo);
		await turn(first, PROMPT);
		const dbPaths = lab.dbPaths(first);
		const learned = lab.currentLessons(dbPaths);
		expect(learned.map(row => row.content)).toHaveLength(1);
		expect(learned[0]!.content).toContain(TITLE_A);
		expect(await probeContext(lab, repo)).toContain(TITLE_A);

		// Drift a conditioned file: the lesson stays live in the bank but recall suppresses it.
		fs.writeFileSync(path.join(repo, "verify.sh"), DRIFTED_VERIFY);
		expect(lab.currentLessons(dbPaths).map(row => row.content)).toEqual(learned.map(row => row.content));
		expect(await probeContext(lab, repo)).not.toContain(TITLE_A);

		// Re-verify the identical content: the capture refreshes the stored fingerprints in place.
		const second = await parserSession(lab, repo);
		await turn(second, PROMPT);
		const refreshed = lab.currentLessons(dbPaths);
		expect(refreshed).toHaveLength(1);
		expect(refreshed[0]!.content).toBe(learned[0]!.content);

		// The row now fingerprints the drifted bytes: reverting verify.sh suppresses it again,
		// which only a rewritten fingerprint (not the original one) can produce.
		fs.writeFileSync(path.join(repo, "verify.sh"), VERIFY_SCRIPT);
		expect(await probeContext(lab, repo)).not.toContain(TITLE_A);

		// Restoring the verified drift makes a fresh-session model request receive the lesson again.
		fs.writeFileSync(path.join(repo, "verify.sh"), DRIFTED_VERIFY);
		expect(await probeContext(lab, repo)).toContain(TITLE_A);
	});

	it("an A→B→A revert keeps exactly one live canonical row and recalls A", async () => {
		const repo = lab.fixture("revert");
		const build = { current: (evidence: Evidence[]) => parserSolution([ref(evidence, CMD.verify, true)]) };
		installScriptedExtractor(lab, build);

		// Learn A.
		const first = await parserSession(lab, repo);
		await turn(first, PROMPT);
		const dbPaths = lab.dbPaths(first);
		const [lessonA] = lab.currentLessons(dbPaths);
		expect(lessonA!.content).toContain(TITLE_A);

		// B supersedes A through an intentional update: a distinct wording of the same fix.
		build.current = evidence =>
			parserSolution([ref(evidence, CMD.verify, true)], {
				title: TITLE_B,
				situation: "parser guard maintenance",
				problem: "guard token missing from src/parser.txt after edits",
				rootCause: "later edits clobber src/parser.txt",
				solution: "Re-run printf guard > src/parser.txt after edits so sh verify.sh passes the guard check",
				evidence: "sh verify.sh passed with guard present in src/parser.txt",
				decision: "update",
				decisionId: lessonA!.id,
			});
		const second = await parserSession(lab, repo);
		await turn(second, PROMPT);
		const afterB = lab.currentLessons(dbPaths);
		expect(afterB).toHaveLength(1);
		expect(afterB[0]!.content).toContain(TITLE_B);
		expect(afterB[0]!.content).not.toContain(TITLE_A);
		const contextB = await probeContext(lab, repo);
		expect(contextB).toContain(TITLE_B);
		expect(contextB).not.toContain(TITLE_A);

		// Revert: the identical A content is re-verified. The native write resolves to the hidden
		// A id, so the capture repairs it: exactly one live canonical row, and it is A.
		build.current = evidence => parserSolution([ref(evidence, CMD.verify, true)]);
		const third = await parserSession(lab, repo);
		await turn(third, PROMPT);
		const afterRevert = lab.currentLessons(dbPaths);
		expect(afterRevert).toHaveLength(1);
		expect(afterRevert[0]!.content).toContain(TITLE_A);
		expect(afterRevert[0]!.content).not.toContain(TITLE_B);

		// A fresh session's model request sees A, not the retired B.
		const contextA = await probeContext(lab, repo);
		expect(contextA).toContain(TITLE_A);
		expect(contextA).not.toContain(TITLE_B);
	});
});
