/**
 * Isolation guard: a writable `task` spawn whose implicit worktree isolation
 * falls back to the parent tree (cwd is not a git checkout) must be loud —
 * a `logger.warn` and a model-facing note on the spawn's mergeSummary channel —
 * while the same spawn from a real git checkout runs isolated in a worktree
 * under the `~/.omp/wt` base of the (temp) HOME and leaves the parent untouched.
 *
 * Drives the real `runStructuredSubagent` seam with a mock model the way
 * worker.test.ts drives `runSubprocess`. `Lab` supplies the harness guards
 * (refuses to run outside bin/harness.sh's temp HOME), the temp root, and the
 * fixed-identity `git` helper.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	type StructuredSubagentRequest,
	type StructuredSubagentResult,
	runStructuredSubagent,
} from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { formatTaskResultSummary } from "@oh-my-pi/pi-coding-agent/task/result-summary";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { getWorktreesDir, logger } from "@oh-my-pi/pi-utils";
import { Database } from "bun:sqlite";
import { callBash, git, Lab, say } from "./support.ts";

const SKIP_REASON = "not a git checkout; worktree isolation unavailable";
const WORKER_CMD = "pwd > guard-cwd.txt; echo touched > guard-new.txt";

/** Minimal ToolSession for the runStructuredSubagent seam: everything it reads, nothing more. */
function toolSession(cwd: string, settings: Settings, modelRegistry: ModelRegistry): ToolSession {
	return {
		cwd,
		hasUI: false,
		settings,
		modelRegistry,
		enableMCP: false,
		enableLsp: false,
		enableIrc: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		getActiveModelString: () => "openai/mock",
		getModelString: () => "openai/mock",
	} as unknown as ToolSession;
}

describe("isolation guard: loud skip outside git, real isolation inside", () => {
	let lab: Lab;
	let auth: AuthStorage;
	let registry: ModelRegistry;
	let settings: Settings;
	let warnCalls: unknown[][];

	beforeEach(() => {
		lab = new Lab();
		auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		auth.keys.setRuntime(lab.model.provider, "test-key");
		registry = new ModelRegistry(auth, path.join(lab.root, "models.yml"));
		spyOn(registry, "getAvailable").mockReturnValue([lab.model]);
		spyOn(registry, "getApiKeyForProvider").mockResolvedValue(undefined);
		// apply=false mirrors the operator's real config and keeps direction 2's
		// "parent tree untouched" assertion about isolation, not merge policy.
		settings = Settings.isolated({ "task.isolation.enabled": true, "task.isolation.apply": false });
		warnCalls = [];
		spyOn(logger, "warn").mockImplementation((...args: unknown[]) => {
			warnCalls.push(args);
		});
	});

	afterEach(async () => {
		auth.close();
		await lab.close();
	});

	/** One real subagent spawn of the bundled `task` agent with a scripted mock model. */
	async function spawnWorker(cwd: string): Promise<StructuredSubagentResult> {
		const mock = createMockModel({ responses: [callBash(WORKER_CMD), say("done")] });
		spyOn(ai, "streamSimple").mockImplementation(mock.stream);
		return runStructuredSubagent({
			session: toolSession(cwd, settings, registry),
			invocationKind: "task",
			agent: "task",
			assignment: "Record your working directory, then write one file.",
			structured: false,
			enableLsp: false,
			enableIrc: false,
			keepAlive: false,
		} satisfies StructuredSubagentRequest);
	}

	function listWorktreeBase(): string[] {
		const base = getWorktreesDir();
		return fs.existsSync(base) ? fs.readdirSync(base).sort() : [];
	}

	it("1: a writable task spawn from a NON-git cwd warns, notes MAIN, writes into the parent tree, and creates no worktree", async () => {
		const nonGitDir = lab.repo("plain-dir");
		expect(vcs.git(nonGitDir)).toBeNull();
		const wtBefore = listWorktreeBase();

		const exec = await spawnWorker(nonGitDir);
		expect(exec.result.exitCode).toBe(0);

		// Not isolated, and the policy names the actionable reason.
		expect(exec.policy.isIsolated).toBe(false);
		expect(exec.policy.isolationSkipReason).toBe(SKIP_REASON);
		expect(exec.result.isolated).not.toBe(true);

		// (a) logger.warn carries cwd + agent name + reason.
		const skips = warnCalls.filter(call => String(call[0]).includes("worktree isolation skipped"));
		expect(skips).toHaveLength(1);
		expect(skips[0]![1]).toMatchObject({ cwd: nonGitDir, agent: "task", reason: SKIP_REASON });

		// (b) the model-facing note rides the mergeSummary channel MAIN reads.
		expect(exec.mergeSummary).toContain("ran unisolated");
		expect(exec.mergeSummary).toContain(nonGitDir);
		expect(exec.mergeSummary).toContain(SKIP_REASON);
		const envelope = formatTaskResultSummary(exec.result, {
			totalDurationMs: exec.result.durationMs,
			mergeSummary: exec.mergeSummary,
		});
		expect(envelope).toContain("<merge-summary>");
		expect(envelope).toContain("ran unisolated");

		// The worker really wrote into the parent tree — the clobber this guards.
		expect(fs.readFileSync(path.join(nonGitDir, "guard-cwd.txt"), "utf8").trim()).toBe(
			fs.realpathSync(nonGitDir),
		);
		expect(fs.readFileSync(path.join(nonGitDir, "guard-new.txt"), "utf8").trim()).toBe("touched");

		// No worktree was created for the unisolated run.
		expect(listWorktreeBase()).toEqual(wtBefore);
		expect(fs.existsSync(exec.artifactsDir)).toBe(false); // temporary lease auto-cleaned
	});

	it("2: the same spawn from a real temp git checkout runs isolated under the temp-HOME wt base and leaves the parent untouched", async () => {
		const repo = lab.repo("iso-repo", { "base.txt": "base\n" });
		git(repo, "init");
		git(repo, "add", "-A");
		git(repo, "commit", "-m", "init");
		// The harness runs under a temp HOME with XDG unset, so the managed
		// worktree base is exactly ~/.omp/wt inside that temp HOME.
		const wtBase = getWorktreesDir();
		expect(wtBase).toBe(path.join(os.homedir(), ".omp", "wt"));

		const exec = await spawnWorker(repo);
		try {
			expect(exec.result.exitCode).toBe(0);

			// Isolated: no skip reason, no skip warning, result flagged isolated.
			expect(exec.policy.isIsolated).toBe(true);
			expect(exec.policy.isolationSkipReason).toBeUndefined();
			expect(exec.result.isolated).toBe(true);
			expect(warnCalls.filter(call => String(call[0]).includes("worktree isolation skipped"))).toHaveLength(0);
			expect(exec.mergeSummary).not.toContain("ran unisolated");
			expect(exec.mergeSummary).toContain("Not applied"); // captured, apply=false

			// The child ran inside a worktree under the managed base: its own
			// `pwd`, captured into the retained patch, proves the location.
			expect(exec.result.patchPath).toBeDefined();
			const patch = fs.readFileSync(exec.result.patchPath!, "utf8");
			expect(patch).toContain("guard-new.txt");
			expect(patch).toContain("+touched");
			expect(patch).toContain(wtBase);

			// Parent tree untouched: no worker files, clean git status.
			expect(fs.existsSync(path.join(repo, "guard-cwd.txt"))).toBe(false);
			expect(fs.existsSync(path.join(repo, "guard-new.txt"))).toBe(false);
			expect(fs.readdirSync(repo).sort()).toEqual([".git", "base.txt"]);
			expect(git(repo, "status", "--porcelain")).toBe("");
		} finally {
			// apply=false retains the artifacts lease; the caller owns disposal.
			fs.rmSync(exec.artifactsDir, { recursive: true, force: true });
		}
	});
});
