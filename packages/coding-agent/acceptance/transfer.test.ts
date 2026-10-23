/**
 * Experience transfer (A, B, G, H): a lesson learned in one session is recalled in a later session of the same
 * repo, stays out of unrelated tasks, is not written when nothing useful was learned, and is dropped once the
 * check that proved it changes.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	callBash,
	CMD,
	flatten,
	git,
	installExtractor,
	Lab,
	LESSON_PREFIX,
	learnParser,
	NO_LESSONS,
	parserSolution,
	say,
	turn,
} from "./support.ts";

const TRANSFER_PROMPT = "Fix the parser empty input crash so sh verify.sh passes.";
const RECALL_HEADER = "Relevant verified experience";

const SOLUTION = parserSolution([]);
const TITLE = String(SOLUTION.title);
const SOLUTION_TEXT = String(SOLUTION.solution);

// Same shape as the fixture's verify.sh, but it also requires the token "validate" in src/parser.txt.
const STRICT_VERIFY_SCRIPT = [
	"#!/bin/sh",
	'if grep -q guard src/parser.txt && grep -q validate src/parser.txt; then echo "PASS parser: guard and validate present"; else echo "FAIL parser: guard or validate missing"; exit 1; fi',
	"",
].join("\n");

describe("experience transfer", () => {
	let lab: Lab;

	beforeEach(() => {
		lab = new Lab();
	});

	afterEach(() => lab.close());

	it("A: a lesson learned in one session is injected into a later session of the same repo", async () => {
		const repo = lab.fixture("parser");
		await learnParser(lab, repo);

		const later = await lab.session({ cwd: repo, responses: ["ok"] });
		await turn(later.session, TRANSFER_PROMPT);

		const current = lab.currentLessons(lab.dbPaths(later.session));
		expect(current).toHaveLength(1);
		expect(current[0]!.content).toContain(LESSON_PREFIX);

		const context = flatten(later.mock.calls[0]!.context);
		expect(context).toContain(TITLE);
		expect(context).toContain(SOLUTION_TEXT);
	});

	it("B: a lesson is not injected into an unrelated task", async () => {
		const repo = lab.fixture("parser");
		await learnParser(lab, repo);

		const unrelated = await lab.session({ cwd: repo, responses: ["ok"] });
		await turn(unrelated.session, "Rename the README heading to Overview.");

		const context = flatten(unrelated.mock.calls[0]!.context);
		expect(context).not.toContain(TITLE);
		expect(context).not.toContain(SOLUTION_TEXT);
		expect(context).not.toContain(RECALL_HEADER);
	});

	it("G: routine work with no lesson writes nothing and never calls the extractor", async () => {
		const repo = lab.fixture("parser");
		const { spy } = installExtractor(() => NO_LESSONS);

		const { session } = await lab.session({
			cwd: repo,
			responses: [callBash(CMD.routine), say("listed")],
		});
		await turn(session, "List the files in the repository.");

		const dbPaths = lab.dbPaths(session);
		expect(lab.allRows(dbPaths)).toEqual([]);
		expect(lab.currentLessons(dbPaths)).toEqual([]);
		expect(spy).toHaveBeenCalledTimes(0);
	});

	it("H: a lesson whose proving check has changed is not injected", async () => {
		const repo = lab.fixture("parser");
		git(repo, "init");
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "parser fixture");
		await learnParser(lab, repo);

		const control = await lab.session({ cwd: repo, responses: ["ok"] });
		await turn(control.session, TRANSFER_PROMPT);
		expect(flatten(control.mock.calls[0]!.context)).toContain(TITLE);

		fs.writeFileSync(path.join(repo, "verify.sh"), STRICT_VERIFY_SCRIPT);
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "require validate token");

		const stale = await lab.session({ cwd: repo, responses: ["ok"] });
		await turn(stale.session, TRANSFER_PROMPT);

		const context = flatten(stale.mock.calls[0]!.context);
		expect(context).not.toContain(TITLE);
		expect(context).not.toContain(SOLUTION_TEXT);
	});
});
