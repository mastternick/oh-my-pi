import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { type Built, flatten, git, Lab, LESSON_PREFIX, learnParser, turn } from "./support.ts";

const TITLE = "Parser empty input crash";
const PROMPT = "Fix the parser empty input crash so sh verify.sh passes.";
const ORIGIN_URL = "https://github.com/acme/widgets.git";
const CLONE_URL = "git@github.com:acme/widgets.git";
const OTHER_URL = "https://github.com/other/unrelated.git";

let lab: Lab;

beforeEach(() => {
	lab = new Lab();
});

afterEach(() => lab.close());

/** Fixture repo with one commit; `remote` becomes origin when given. The message names the repo so identical trees never share a hash. */
function committedRepo(name: string, remote?: string): string {
	const dir = lab.fixture(name);
	git(dir, "init");
	if (remote) git(dir, "remote", "add", "origin", remote);
	git(dir, "add", "-A");
	git(dir, "commit", "-m", `init ${name}`);
	return dir;
}

/**
 * Learns the parser lesson in `repo`, then commits the fix. Clones and worktrees check out HEAD, and the lesson's
 * fingerprints read the checked-out files, so an uncommitted fix would never reach them.
 */
async function learnCommitted(repo: string): Promise<string[]> {
	const dbPaths = await learnParser(lab, repo);
	git(repo, "add", "-A");
	git(repo, "commit", "-m", "fix parser empty input");
	return dbPaths;
}

/**
 * Fresh session in `cwd` runs the A prompt once; with `parent`, the session is a worker child under it.
 * Returns the session and the first model call's context.
 */
async function promptContext(cwd: string, parent?: Built): Promise<{ built: Built; context: string }> {
	const built = parent
		? await lab.child(parent.session, { cwd, responses: ["ok"] })
		: await lab.session({ cwd, responses: ["ok"] });
	await turn(built.session, PROMPT);
	return { built, context: flatten(built.mock.calls[0]!.context) };
}

describe("F: project identity across clones, worktrees, and remote-less repos", () => {
	it("F: origin repo learns the lesson", async () => {
		const origin = committedRepo("widgets", ORIGIN_URL);
		const lessons = lab.currentLessons(await learnCommitted(origin));
		expect(lessons).toHaveLength(1);
		expect(lessons[0]!.content).toContain(LESSON_PREFIX);
	});

	it("F: clone with an ssh remote for the same project sees the lesson", async () => {
		const origin = committedRepo("widgets", ORIGIN_URL);
		await learnCommitted(origin);
		const clone = lab.repo("widgets-clone");
		git(lab.root, "clone", origin, clone);
		git(clone, "remote", "set-url", "origin", CLONE_URL);

		const { built, context } = await promptContext(clone);

		expect(context).toContain(TITLE);
		expect(lab.currentLessons(lab.dbPaths(built.session))).toHaveLength(1);
	});

	it("F: worktree of the origin repo sees the lesson", async () => {
		const origin = committedRepo("widgets", ORIGIN_URL);
		await learnCommitted(origin);
		const worktree = lab.repo("widgets-worktree");
		git(origin, "worktree", "add", "--detach", worktree);

		const { built, context } = await promptContext(worktree);

		expect(context).toContain(TITLE);
		expect(lab.currentLessons(lab.dbPaths(built.session))).toHaveLength(1);
	});

	it("F: worker child in a worktree uses its own repo root and the parent's bank", async () => {
		const origin = committedRepo("widgets", ORIGIN_URL);
		await learnCommitted(origin);
		const parent = await lab.session({ cwd: origin, responses: ["ok"] });
		const worktree = lab.repo("widgets-child");
		git(origin, "worktree", "add", "--detach", worktree);

		const { built, context } = await promptContext(worktree, parent);

		expect(getMnemopiSessionState(built.session)?.config.repoRoot).toBe(fs.realpathSync(worktree));
		expect(getMnemopiSessionState(built.session)?.config.projectIdentity).toEqual(
			getMnemopiSessionState(parent.session)?.config.projectIdentity,
		);
		expect(lab.dbPaths(built.session)).toEqual(lab.dbPaths(parent.session));
		expect(context).toContain(TITLE);
	});

	it("F: worker child whose worktree files differ from the lesson's fingerprints does not see it", async () => {
		const origin = committedRepo("widgets", ORIGIN_URL);
		await learnCommitted(origin);
		const parent = await lab.session({ cwd: origin, responses: ["ok"] });
		const base = lab.repo("widgets-base");
		git(origin, "worktree", "add", "--detach", base, "HEAD~1");

		const { built, context } = await promptContext(base, parent);

		expect(getMnemopiSessionState(built.session)?.config.repoRoot).toBe(fs.realpathSync(base));
		expect(lab.dbPaths(built.session)).toEqual(lab.dbPaths(parent.session));
		expect(lab.currentLessons(lab.dbPaths(built.session))).toHaveLength(1);
		expect(context).not.toContain(TITLE);
	});

	it("F: unrelated project does not see the lesson", async () => {
		const origin = committedRepo("widgets", ORIGIN_URL);
		await learnCommitted(origin);
		const other = committedRepo("other", OTHER_URL);

		const { built, context } = await promptContext(other);

		expect(context).not.toContain(TITLE);
		expect(lab.currentLessons(lab.dbPaths(built.session))).toEqual([]);
	});

	it("F: remote-less worktree of a learned repo sees the lesson", async () => {
		const localA = committedRepo("local-a");
		const lessons = lab.currentLessons(await learnCommitted(localA));
		expect(lessons).toHaveLength(1);
		const worktree = lab.repo("local-a-worktree");
		git(localA, "worktree", "add", "--detach", worktree);

		const { built, context } = await promptContext(worktree);

		expect(context).toContain(TITLE);
		expect(lab.currentLessons(lab.dbPaths(built.session))).toHaveLength(1);
	});

	it("F: remote-less unrelated repo does not see the lesson", async () => {
		const localA = committedRepo("local-a");
		await learnCommitted(localA);
		const localB = committedRepo("local-b");

		const { built, context } = await promptContext(localB);

		expect(context).not.toContain(TITLE);
		expect(lab.currentLessons(lab.dbPaths(built.session))).toEqual([]);
	});
});
