/**
 * Shared harness for the experience-memory acceptance tests (A–I).
 *
 * A Lab owns one temp root: repos, the agent dir (and therefore every mnemopi bank) and the auth store.
 * Construction fails closed unless bin/harness.sh exported XM_ACCEPTANCE_HARNESS=1 and HOME lies under a
 * temp dir, so these tests cannot reach the cleaned live banks.
 */
import { Database } from "bun:sqlite";
import { spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@oh-my-pi/pi-coding-agent/mnemopi/backend";
import { getMnemopiScopedDbPaths, getMnemopiSessionState } from "@oh-my-pi/pi-coding-agent/mnemopi/state";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { embeddingDimFor, resetMemoryForTests } from "@oh-my-pi/pi-mnemopi";
import { getProjectDir, setProjectDir, TempDir } from "@oh-my-pi/pi-utils";

// Regression tests take the state accessor from here, not from the package.
export { getMnemopiSessionState };

/** Baseline for every acceptance test. Legacy recall and auto-retain stay off, so only the experience path runs. */
export const MEMORY_OVERRIDES: Readonly<Record<string, unknown>> = {
	"compaction.enabled": false,
	"memory.backend": "mnemopi",
	"mnemopi.noEmbeddings": true,
	"mnemopi.llmMode": "smol",
	"mnemopi.autoRetain": false,
	"mnemopi.autoRecall": false,
	"mnemopi.experienceEnabled": true,
	"retry.fallbackChains": { memory: [] },
};

/** verify.sh passes only when src/parser.txt contains the guard token. */
export const VERIFY_SCRIPT = [
	"#!/bin/sh",
	'if grep -q guard src/parser.txt; then echo "PASS parser: guard present in src/parser.txt"; else echo "FAIL parser: empty input crashes length check"; exit 1; fi',
	"",
].join("\n");

/** Scripted shell commands. Only `sh verify.sh` matches CHECK_EVIDENCE_PATTERN; `ls` is routine work. */
export const CMD = {
	verify: "sh verify.sh",
	wrong: "printf wrong > src/parser.txt",
	fix: "printf guard > src/parser.txt",
	routine: "ls",
} as const;

export const NO_LESSONS = "NO_LESSONS";
export const LESSON_PREFIX = "LESSON[v1]";

/** Scripted main-turn response that calls the bash tool. */
export const callBash = (command: string) => ({
	content: [{ type: "toolCall" as const, name: "bash", arguments: { command } }],
});

/** Scripted main-turn response that replies with text. */
export const say = (text: string) => ({ content: [text] });

/**
 * Real `sh -c` in `cwd`. The exit code goes in details.exitCode because collectExperienceEvidence derives
 * `ok` from it. Never throws, so a failing check is recorded as evidence rather than as a crash.
 */
export function bashTool(cwd: string): AgentTool {
	return {
		name: "bash",
		label: "bash",
		description: "Run a shell command in the repository.",
		parameters: type({ command: "string" }),
		async execute(_toolCallId, params) {
			const { command } = params as { command: string };
			const proc = Bun.spawnSync(["sh", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
			const text = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
			return { content: [{ type: "text", text }], details: { exitCode: proc.exitCode ?? -1 } };
		},
	};
}

export interface SessionOptions {
	cwd: string;
	responses: MockResponseSource;
	overrides?: Readonly<Record<string, unknown>>;
}

export interface Built {
	session: AgentSession;
	mock: MockModel;
	settings: Settings;
}

export interface StoredRow {
	db: string;
	table: string;
	id: string;
	content: string;
}

/** One temp root, one agent dir (so one set of mnemopi banks), and any number of sessions. */
export class Lab {
	readonly root: string;
	readonly agentDir: string;
	readonly model: Model<Api>;
	readonly #auth: AuthStorage;
	readonly #temp: TempDir;
	readonly #savedProjectDir: string;
	readonly #sessions: AgentSession[] = [];

	constructor() {
		if (process.env.XM_ACCEPTANCE_HARNESS !== "1") {
			throw new Error("acceptance tests must run via bin/harness.sh (XM_ACCEPTANCE_HARNESS=1 is not set)");
		}
		const home = path.resolve(os.homedir());
		const tmpRoots = [os.tmpdir(), "/tmp"].map(dir => path.resolve(dir) + path.sep);
		if (!tmpRoots.some(root => home.startsWith(root))) {
			throw new Error(`refusing to run: HOME=${home} is outside the temp dirs ${tmpRoots.join(", ")}`);
		}
		this.#savedProjectDir = getProjectDir();
		this.#temp = TempDir.createSync("@xm-acceptance-");
		this.root = this.#temp.path();
		this.agentDir = path.join(this.root, "agent");
		fs.mkdirSync(this.agentDir, { recursive: true });
		this.#auth = new AuthStorage(new SqliteAuthCredentialStore(new Database(":memory:")));
		this.model = buildModel({
			id: "mock",
			name: "mock",
			api: "openai-responses",
			provider: "openai",
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 2048,
		});
		this.#auth.keys.setRuntime(this.model.provider, "test-key");
	}

	/** Creates <root>/repos/<name> and writes the given repo-relative files. */
	repo(name: string, files: Readonly<Record<string, string>> = {}): string {
		const dir = path.join(this.root, "repos", name);
		fs.mkdirSync(dir, { recursive: true });
		for (const [rel, text] of Object.entries(files)) writeFile(path.join(dir, rel), text);
		return dir;
	}

	/** Repo with the parser fixture: verify.sh fails until src/parser.txt contains the guard. */
	fixture(name: string): string {
		return this.repo(name, { "verify.sh": VERIFY_SCRIPT, "src/parser.txt": "" });
	}

	/** Top-level session in `opts.cwd` with the memory backend applied. */
	async session(opts: SessionOptions): Promise<Built> {
		const built = this.#build(opts, 0);
		await built.session.applyMemoryBackend();
		return built;
	}

	/**
	 * Task-worker session (depth 1) started against `parent`'s mnemopi state. Its alias shares the parent's
	 * DB handles, the way production TASK children do.
	 */
	async child(parent: AgentSession, opts: SessionOptions): Promise<Built> {
		const built = this.#build(opts, 1);
		await mnemopiBackend.start({
			session: built.session,
			settings: built.settings,
			modelRegistry: built.session.modelRegistry,
			agentDir: this.agentDir,
			taskDepth: 1,
			parentMnemopiSessionState: getMnemopiSessionState(parent),
		});
		return built;
	}

	/** Mnemopi DB files the session's bank scope resolves to. Read before dispose(). */
	dbPaths(session: AgentSession): string[] {
		const state = getMnemopiSessionState(session);
		if (!state) throw new Error("session has no mnemopi state; was applyMemoryBackend() called?");
		return [...getMnemopiScopedDbPaths(state.config)];
	}

	/** Current LESSON[v1] rows: not superseded and not expired. Missing DB files count as empty. */
	currentLessons(dbPaths: readonly string[]): StoredRow[] {
		return this.#rows(dbPaths, `content LIKE '${LESSON_PREFIX}%' AND valid_until IS NULL AND superseded_by IS NULL`);
	}

	/** Every row in working_memory and episodic_memory, regardless of content. */
	allRows(dbPaths: readonly string[]): StoredRow[] {
		return this.#rows(dbPaths, "1 = 1");
	}

	/** True when PRAGMA integrity_check reports ok on every existing DB file. */
	integrityOk(dbPaths: readonly string[]): boolean {
		return dbPaths.every(file => {
			if (!fs.existsSync(file)) return true;
			const db = this.#openReadOnly(file);
			try {
				return db.query("PRAGMA integrity_check").get()?.integrity_check === "ok";
			} finally {
				db.close();
			}
		});
	}

	/** Disposes sessions, resets mnemopi and mocks, restores cwd, removes the root. Call from afterEach. */
	async close(): Promise<void> {
		for (const session of this.#sessions.splice(0)) await session.dispose();
		resetMemoryForTests();
		vi.restoreAllMocks();
		this.#auth.close();
		AgentStorage.close();
		setProjectDir(this.#savedProjectDir);
		this.#temp.removeSync();
	}

	#build(opts: SessionOptions, taskDepth: number): Built {
		setProjectDir(opts.cwd);
		const settings = Settings.isolated({
			...MEMORY_OVERRIDES,
			modelRoles: { memory: `${this.model.provider}/${this.model.id}` },
			...opts.overrides,
		});
		const mock = createMockModel({ responses: opts.responses });
		const bash = bashTool(opts.cwd);
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: this.model, systemPrompt: ["initial"], tools: [bash] },
			streamFn: mock.stream,
		});
		const session = new AgentSession({
			agent,
			// The session manager's cwd is the project identity source for experience capture and recall.
			sessionManager: SessionManager.inMemory(opts.cwd),
			settings,
			modelRegistry: new ModelRegistry(this.#auth, path.join(this.root, "models.yml")),
			memoryAgentDir: this.agentDir,
			memoryTaskDepth: taskDepth,
			createMemoryTools: async () => [],
			toolRegistry: new Map([[bash.name, bash]]),
			builtInToolNames: [bash.name],
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${[...toolNames].sort().join(",")}`] }),
		});
		this.#sessions.push(session);
		spyOn(session.modelRegistry, "getAvailable").mockReturnValue([this.model]);
		spyOn(session.modelRegistry, "getApiKeyForProvider").mockResolvedValue(undefined);
		return { session, mock, settings };
	}

	#rows(dbPaths: readonly string[], where: string): StoredRow[] {
		const rows: StoredRow[] = [];
		for (const file of dbPaths) {
			if (!fs.existsSync(file)) continue;
			const db = this.#openReadOnly(file);
			try {
				for (const table of ["working_memory", "episodic_memory"]) {
					const exists = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
					if (!exists) continue;
					const found = db.query(`SELECT id, content FROM ${table} WHERE ${where}`).all() as Array<{
						id: string;
						content: string;
					}>;
					for (const row of found) rows.push({ db: file, table, ...row });
				}
			} finally {
				db.close();
			}
		}
		return rows;
	}

	#openReadOnly(file: string): Database {
		if (!file.startsWith(this.root + path.sep)) throw new Error(`refusing to open a DB outside the test root: ${file}`);
		return new Database(file, { readonly: true });
	}
}

/** Waits until no experience capture is in flight on `session`, then drains the session's background embedding writes. */
export async function settle(session: AgentSession): Promise<void> {
	const state = getMnemopiSessionState(session);
	for (;;) {
		const pending = state?.pendingExperienceCapture();
		if (!pending) break;
		await pending;
	}
	await state?.memory.flushExtractions();
}

/** One user turn, then settle the post-turn experience capture. */
export async function turn(session: AgentSession, text: string): Promise<void> {
	await session.prompt(text);
	await settle(session);
}

/** All string leaves of a value, newline-joined. Lets tests inspect prompts without depending on message shape. */
export function flatten(value: unknown, seen = new WeakSet<object>()): string {
	const parts: string[] = [];
	const walk = (node: unknown): void => {
		if (typeof node === "string") {
			parts.push(node);
		} else if (node && typeof node === "object") {
			if (seen.has(node)) return;
			seen.add(node);
			for (const child of Object.values(node)) walk(child);
		}
	};
	walk(value);
	return parts.join("\n");
}

export interface Evidence {
	index: number;
	tool: string;
	ok: boolean;
	request: string;
	output: string;
}

export interface Candidate {
	id: string;
	tag: "experience" | "legacy";
	content: string;
}

/**
 * Parses the EVIDENCE block rendered by renderEvidenceDigest:
 * `E<n> tool=<t> ok=<bool>[ exit=<n>][ callId=<id>]`, then `  request: …` and `  output: …`.
 * Output is read from the single line after `output:`. These fixtures never produce multi-line output.
 */
export function parseEvidence(prompt: string): Evidence[] {
	const out: Evidence[] = [];
	let current: Evidence | undefined;
	for (const line of prompt.split("\n")) {
		const header = /^E(\d+) tool=(\S+) ok=(true|false)/.exec(line);
		if (header) {
			current = { index: Number(header[1]), tool: header[2]!, ok: header[3] === "true", request: "", output: "" };
			out.push(current);
		} else if (current && line.startsWith("  request: ")) {
			current.request = line.slice("  request: ".length);
		} else if (current && line.startsWith("  output: ")) {
			current.output = line.slice("  output: ".length);
		} else if (!line.startsWith("  ")) {
			current = undefined;
		}
	}
	return out;
}

/** Parses candidate lines rendered as `- id=<id> (experience|legacy) <content>`. */
export function parseCandidates(prompt: string): Candidate[] {
	return [...prompt.matchAll(/^- id=(\S+) \((experience|legacy)\) (.*)$/gm)].map(match => ({
		id: match[1]!,
		tag: match[2] as Candidate["tag"],
		content: match[3]!,
	}));
}

/** `E<n>` of the first evidence entry whose request contains `needle` with the given ok flag. Throws if absent. */
export function ref(evidence: readonly Evidence[], needle: string, ok: boolean): string {
	const hit = evidence.find(entry => entry.ok === ok && entry.request.includes(needle));
	if (!hit) {
		const seen = evidence.map(entry => `E${entry.index} ok=${entry.ok} ${entry.request}`).join(" | ");
		throw new Error(`no evidence matching "${needle}" ok=${ok}; saw: ${seen}`);
	}
	return `E${hit.index}`;
}

export type ExtractorScript = (evidence: Evidence[], candidates: Candidate[]) => string;

/**
 * Replaces the lesson-extraction completion. An extraction is any completeSimple call whose prompt contains
 * NO_LESSONS. Every other completion gets an empty reply. Each extraction is recorded in `seen`.
 */
export function installExtractor(script: ExtractorScript) {
	const seen: Array<{ evidence: Evidence[]; candidates: Candidate[] }> = [];
	const spy = spyOn(ai, "completeSimple").mockImplementation(async (model, context, options) => {
		const prompt = flatten(context);
		let text = "";
		if (prompt.includes(NO_LESSONS)) {
			const evidence = parseEvidence(prompt);
			const candidates = parseCandidates(prompt);
			seen.push({ evidence, candidates });
			text = script(evidence, candidates);
		}
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		options?.onAttempt?.(message);
		return message;
	});
	return { seen, spy };
}

/** Extraction reply: one JSON object, or NO_LESSONS. */
export const lessonReply = (...lessons: Record<string, unknown>[]): string => JSON.stringify({ lessons });

/** Canonical parser solution. `refs` must cite passing check entries only: a failing citation is rejected. */
export function parserSolution(refs: readonly string[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		kind: "solution",
		title: "Parser empty input crash",
		situation: "verify.sh parser check",
		problem: "sh verify.sh fails: empty input crashes length check",
		rootCause: "src/parser.txt lacks guard",
		solution: "Run printf guard > src/parser.txt so sh verify.sh passes parser guard",
		pitfall: "",
		evidence: "sh verify.sh passed with parser guard present",
		evidenceRefs: [...refs],
		scope: "parser module",
		conditions: ["verify.sh", "src/parser.txt"],
		decision: "new",
		decisionId: null,
		...overrides,
	};
}

/** Runs the parser fixture once: failing verify, fix, passing verify, then learns the solution. Returns the DB paths. */
export async function learnParser(lab: Lab, repo: string): Promise<string[]> {
	const { session } = await lab.session({
		cwd: repo,
		responses: [
			callBash(CMD.verify),
			callBash(CMD.fix),
			callBash(CMD.verify),
			say("Parser crash fixed; sh verify.sh passes."),
		],
	});
	installExtractor(evidence => lessonReply(parserSolution([ref(evidence, CMD.verify, true)])));
	await turn(session, "Fix the parser empty input crash so sh verify.sh passes.");
	return lab.dbPaths(session);
}

/** Parser session: failing verify, fix, passing verify, then text. Empties src/parser.txt first, so each session starts failing. The caller installs its extractor and runs the turn. */
export async function parserSession(
	lab: Lab,
	repo: string,
	overrides?: Readonly<Record<string, unknown>>,
): Promise<AgentSession> {
	fs.writeFileSync(path.join(repo, "src", "parser.txt"), "");
	const { session } = await lab.session({
		cwd: repo,
		responses: [
			callBash(CMD.verify),
			callBash(CMD.fix),
			callBash(CMD.verify),
			say("Parser crash fixed; sh verify.sh passes."),
		],
		overrides,
	});
	return session;
}

const EmbedBody = type({ input: "string[]" });

/** OpenAI-style embeddings endpoint on a free local port. `url` ends in /v1. `posts` counts POST /v1/embeddings. Call stop() in a finally block. */
export function startEmbeddingStub(model: string) {
	const dim = embeddingDimFor(model);
	let posts = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/embeddings") {
				return new Response("not found", { status: 404 });
			}
			posts++;
			const body = EmbedBody.assert(await req.json());
			return Response.json({
				data: body.input.map((_text, row) => ({
					embedding: Array.from({ length: dim }, (_, k) => ((k + row + 1) % 17) + 1),
				})),
			});
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1`,
		get posts() {
			return posts;
		},
		stop() {
			server.stop(true);
		},
	};
}

/** Child-process embedding stub: `url` points at the child's HTTP server, `childPid` identifies it. `stop` SIGTERMs the child, reads the POSTS=<n> counter it wrote, and cleans up. */
export interface EmbeddingStubProcess {
	url: string;
	childPid: number;
	stop(): Promise<{ code: number; served: number }>;
}

/** Spawns the embeddings stub as a separate `bun` OS process and waits for its `URL <bound>` stdout handshake. */
export async function startEmbeddingStubProcess(model: string, counterFile: string): Promise<EmbeddingStubProcess> {
	const proc = Bun.spawn([process.execPath, import.meta.dir + "/embed-stub-child.ts"], {
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			XM_EMBED_MODEL: model,
			XM_EMBED_COUNTER: counterFile,
		},
	});
	const url = await readChildUrl(proc);
	let stopped: { code: number; served: number } | undefined;
	return {
		url,
		childPid: proc.pid,
		async stop() {
			if (stopped !== undefined) return stopped;
			proc.kill("SIGTERM");
			const code = await proc.exited;
			let served = NaN;
			try {
				const counter = fs.readFileSync(counterFile, "utf8").trim();
				const parsed = /^POSTS=(\d+)$/.exec(counter);
				if (parsed) served = Number(parsed[1]);
			} catch {
				// The child wrote no counter; served stays NaN, the callers assert on it.
			}
			fs.rmSync(counterFile, { force: true });
			stopped = { code, served };
			return stopped;
		},
	};
}

/** Reads the child stub's handshake line `URL <bound-url>` from stdout. Throws if the child exits before binding. */
async function readChildUrl(proc: Subprocess<"ignore", "pipe", "ignore">): Promise<string> {
	const reader = proc.stdout.getReader();
	const decoder = new TextDecoder();
	const deadline = Date.now() + 10000;
	let buffer = "";
	for (;;) {
		if (Date.now() > deadline) {
			proc.kill("SIGTERM");
			throw new Error("embedding stub child did not report its URL in 10s");
		}
		const { done, value } = await reader.read();
		if (value) buffer += decoder.decode(value, { stream: true });
		if (done) {
			const exit = await proc.exited;
			throw new Error(`embedding stub child exited (code ${exit}) before binding: ${buffer.trim()}`);
		}
		const newline = buffer.indexOf("\n");
		if (newline >= 0) {
			const line = buffer.slice(0, newline).trim();
			reader.cancel();
			reader.releaseLock();
			if (!line.startsWith("URL ")) throw new Error(`unexpected embedding stub handshake: ${line}`);
			return line.slice("URL ".length);
		}
	}
}

/** Runs git in `cwd` with a fixed author identity and no commit signing, so results never depend on host git config. Throws on nonzero exit. */
export function git(cwd: string, ...args: string[]): string {
	const proc = Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "acceptance",
			GIT_AUTHOR_EMAIL: "acceptance@example.invalid",
			GIT_COMMITTER_NAME: "acceptance",
			GIT_COMMITTER_EMAIL: "acceptance@example.invalid",
		},
	});
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim()}`);
	return proc.stdout.toString().trim();
}

function writeFile(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
}
