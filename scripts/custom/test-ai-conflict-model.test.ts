import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	AI_CONFLICT_MODEL,
	type AdapterRequest,
	type ConflictInput,
	type ReviewRequest,
	type ReviewResponse,
	type ResolveRequest,
	type ResolveResponse,
	REVIEW_SESSION_PREFIX,
	RESOLVER_SESSION_PREFIX,
	reviewResolutions,
	resolveConflicts,
	runAdapter,
	type SdkModule,
	type TurnOutcome,
	type TurnProof,
	type TurnRequest,
	type TurnRunner,
} from "./ai-conflict-model";

const CONFLICT: ConflictInput = {
	path: "src/demo.txt",
	base: "alpha\n",
	ours: "alpha\nours\n",
	theirs: "alpha\ntheirs\n",
};

function proofFor(request: TurnRequest, overrides: Partial<TurnProof> = {}): TurnProof {
	return {
		provider: AI_CONFLICT_MODEL.provider,
		model: AI_CONFLICT_MODEL.id,
		api: "openai-completions",
		sessionId: "session-test",
		sessionFile: "/tmp/session-test.jsonl",
		sessionName: request.sessionName,
		assistantMessages: 1,
		toolCalls: 0,
		toolsExposed: 0,
		retryRecoveries: [],
		...overrides,
	};
}

function runnerReturning(
	text: string | ((request: TurnRequest) => string),
	overrides: Partial<TurnProof> = {},
): TurnRunner {
	return async (request): Promise<TurnOutcome> => ({
		text: typeof text === "function" ? text(request) : text,
		proof: proofFor(request, overrides),
	});
}

function resolveRequest(overrides: Partial<ResolveRequest> = {}): ResolveRequest {
	return { mode: "resolve", jobKey: "custom-v18.16.0-c1", conflicts: [CONFLICT], ...overrides };
}

function reviewRequest(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
	return {
		mode: "review",
		jobKey: "custom-v18.16.0-c1",
		conflicts: [CONFLICT],
		files: [{ path: CONFLICT.path, content: "alpha\nours\ntheirs\n" }],
		...overrides,
	};
}

function expectFailure(
	response: ResolveResponse | ReviewResponse,
	code: Extract<ResolveResponse, { ok: false }>["error"]["code"],
): void {
	if (response.ok) throw new Error(`expected failure ${code}, got success`);
	expect(response.error.code).toBe(code);
}

function expectResolveSuccess(
	response: ResolveResponse | ReviewResponse,
): asserts response is Extract<ResolveResponse, { ok: true }> {
	if (!response.ok) throw new Error(`expected resolve success, got ${response.error.code}: ${response.error.message}`);
	if (response.mode !== "resolve") throw new Error("expected resolve success, got review success");
}

function expectReviewSuccess(response: ReviewResponse): asserts response is Extract<ReviewResponse, { ok: true }> {
	if (!response.ok) throw new Error(`expected review success, got ${response.error.code}: ${response.error.message}`);
}

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-conflict-model-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

interface FakeSdkState {
	agentDir: string;
	isolatedOverrides?: Readonly<Record<string, unknown>>;
	isolatedSettings?: object;
	captured?: Record<string, unknown>;
	findArgs?: string[];
	model?: { provider: string; id: string };
	registrySettings?: unknown;
	sessionCwd?: string;
	sessionDir?: string;
	setNameCalls: number;
	promptCalls: number;
	disposeCalls: number;
	closeCalls: number;
}

interface FakeSdkOptions {
	agentDir: string;
	/** Whether setSessionName may succeed at all. */
	nameAccepted?: boolean;
	/** Whether a successful naming is actually visible through the session manager. */
	nameRecorded?: boolean;
	/** What the fake SDK "dispatches" to; defaults to the pinned model. */
	dispatchModel?: { provider: string; id: string };
	/** Wrap the dispatch assertion failure in a plain Error, as an SDK might. */
	wrapDispatchError?: boolean;
	/** Run the dispatch assertion while creating the session instead of on the first prompt. */
	dispatchAtCreate?: boolean;
	tools?: unknown[];
	assistantText?: string;
}

/** In-memory stand-in for the installed OMP SDK; no network, no real session storage. */
function fakeSdk(options: FakeSdkOptions): { sdk: SdkModule; state: FakeSdkState } {
	const model = { provider: AI_CONFLICT_MODEL.provider, id: AI_CONFLICT_MODEL.id };
	const state: FakeSdkState = {
		agentDir: options.agentDir,
		setNameCalls: 0,
		promptCalls: 0,
		disposeCalls: 0,
		closeCalls: 0,
	};
	const manager: { file?: string; name?: string } = {};
	const assistantText =
		options.assistantText ?? JSON.stringify({ files: [{ path: CONFLICT.path, content: "alpha\nmerged\n" }] });

	const sdk: SdkModule = {
		Settings: {
			isolated(overrides) {
				state.isolatedOverrides = overrides;
				state.isolatedSettings = { isolated: true, overrides };
				return state.isolatedSettings;
			},
		},
		getAgentDir: () => state.agentDir,
		discoverAuthStorage: async () => ({ close: () => void (state.closeCalls += 1) }),
		ModelRegistry: class {
			constructor(_auth: unknown, _modelsYml: string, registryOptions: { settings: unknown }) {
				state.registrySettings = registryOptions.settings;
			}
			find(provider: string, id: string) {
				state.findArgs = [provider, id];
				return provider === model.provider && id === model.id ? model : undefined;
			}
		},
		SessionManager: {
			create(cwd, sessionDir) {
				state.sessionCwd = cwd;
				state.sessionDir = sessionDir;
				manager.file = path.join(sessionDir ?? cwd, "fake-session.jsonl");
				// Deliberately permissive, so the adapter has to tighten it.
				writeFileSync(manager.file, "");
				chmodSync(manager.file, 0o644);
				return {
					getSessionId: () => "fake-session-id",
					getSessionFile: () => manager.file,
					getSessionName: () => manager.name,
				};
			},
		},
		createAgentSession: async sessionOptions => {
			state.captured = sessionOptions;
			if (options.dispatchAtCreate) {
				const assertDispatch = sessionOptions.assertDispatchModel as (dispatch: {
					provider: string;
					id: string;
				}) => void;
				try {
					assertDispatch(options.dispatchModel ?? model);
				} catch (error) {
					if (!options.wrapDispatchError) throw error;
					throw new Error(`session creation failed: ${(error as Error).message}`);
				}
			}
			const sessionState: {
				messages: Array<{
					role: string;
					provider?: string;
					model?: string;
					api?: string;
					content?: Array<{ type: string; text?: string }>;
					retryRecovery?: { recovery?: string };
				}>;
				tools: unknown[];
				model: { provider: string; id: string };
			} = { messages: [], tools: options.tools ?? [], model };
			const session = {
				setSessionName: async (name: string) => {
					state.setNameCalls += 1;
					if (options.nameAccepted === false) return false;
					if (options.nameRecorded !== false) manager.name = name;
					return true;
				},
				prompt: async () => {
					state.promptCalls += 1;
					const assertDispatch = sessionOptions.assertDispatchModel as (dispatch: {
						provider: string;
						id: string;
					}) => void;
					try {
						assertDispatch(options.dispatchModel ?? model);
					} catch (error) {
						if (!options.wrapDispatchError) throw error;
						throw new Error(`session dispatch failed: ${(error as Error).message}`);
					}
					sessionState.messages.push({
						role: "assistant",
						provider: model.provider,
						model: model.id,
						api: "openai-completions",
						content: [{ type: "text", text: assistantText }],
					});
					return true;
				},
				abort: async () => {},
				dispose: async () => void (state.disposeCalls += 1),
				sessionManager: {
					getSessionId: () => "fake-session-id",
					getSessionFile: () => manager.file,
					getSessionName: () => manager.name,
				},
				state: sessionState,
			};
			return { session };
		},
	};
	return { sdk, state };
}

describe("resolve boundary", () => {
	test("returns validated replacements for every allowlisted path", async () => {
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerReturning(JSON.stringify({ files: [{ path: CONFLICT.path, content: "alpha\nmerged\n" }] })),
		});
		expectResolveSuccess(response);
		expect(response.files).toEqual([{ path: CONFLICT.path, content: "alpha\nmerged\n" }]);
		expect(response.session.name).toBe(`${RESOLVER_SESSION_PREFIX}custom-v18.16.0-c1`);
		expect(response.model).toEqual({ provider: AI_CONFLICT_MODEL.provider, id: AI_CONFLICT_MODEL.id });
		expect(response.proof.toolCalls).toBe(0);
	});

	test("accepts an explicit deletion", async () => {
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerReturning(JSON.stringify({ files: [{ path: CONFLICT.path, delete: true }] })),
		});
		expectResolveSuccess(response);
		expect(response.files).toEqual([{ path: CONFLICT.path, delete: true }]);
	});

	test("rejects extra, missing, duplicate, and traversing paths", async () => {
		const cases = [
			JSON.stringify({
				files: [
					{ path: CONFLICT.path, content: "x" },
					{ path: "other.txt", content: "y" },
				],
			}),
			JSON.stringify({ files: [] }),
			JSON.stringify({
				files: [
					{ path: CONFLICT.path, content: "x" },
					{ path: CONFLICT.path, content: "y" },
				],
			}),
			JSON.stringify({ files: [{ path: "../escape.txt", content: "x" }] }),
			JSON.stringify({ files: [{ path: CONFLICT.path, content: "x", delete: true }] }),
		];
		for (const text of cases) {
			const response = await resolveConflicts(resolveRequest(), { runner: runnerReturning(text) });
			expectFailure(response, "MALFORMED_MODEL_OUTPUT");
		}
	});

	test("rejects malformed or prose-wrapped JSON", async () => {
		for (const text of ["", "not json", '```json\n{"files":[]}\n````', 'Here you go: {"files":[]}', "[]"]) {
			const response = await resolveConflicts(resolveRequest(), { runner: runnerReturning(text) });
			expectFailure(response, "MALFORMED_MODEL_OUTPUT");
		}
	});

	test("accepts a single fenced JSON object", async () => {
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerReturning(
				"```json\n" + JSON.stringify({ files: [{ path: CONFLICT.path, content: "x" }] }) + "\n```",
			),
		});
		expectResolveSuccess(response);
	});
});

describe("transcript proof", () => {
	test("rejects a different provider or model", async () => {
		for (const overrides of [{ provider: "openrouter" }, { model: "deepseek-v4.1-flash-free" }]) {
			const response = await resolveConflicts(resolveRequest(), {
				runner: runnerReturning(JSON.stringify({ files: [{ path: CONFLICT.path, content: "x" }] }), overrides),
			});
			expectFailure(response, "MODEL_PROOF_MISMATCH");
		}
	});

	test("rejects tool use, exposed tools, and model/credential fallback", async () => {
		for (const overrides of [
			{ toolCalls: 1 },
			{ toolsExposed: 1 },
			{ retryRecoveries: ["model"] },
			{ retryRecoveries: ["credential"] },
		]) {
			const response = await resolveConflicts(resolveRequest(), {
				runner: runnerReturning(JSON.stringify({ files: [{ path: CONFLICT.path, content: "x" }] }), overrides),
			});
			expectFailure(response, "MODEL_PROOF_MISMATCH");
		}
	});

	test("rejects an unexpected session name and a gateway-substituted model", async () => {
		for (const overrides of [{ sessionName: "OMP — something else" }, { upstreamModel: "other-model" }]) {
			const response = await resolveConflicts(resolveRequest(), {
				runner: runnerReturning(JSON.stringify({ files: [{ path: CONFLICT.path, content: "x" }] }), overrides),
			});
			expectFailure(response, "MODEL_PROOF_MISMATCH");
		}
	});

	test("allows same-model retry recoveries", async () => {
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerReturning(JSON.stringify({ files: [{ path: CONFLICT.path, content: "x" }] }), {
				retryRecoveries: ["plain", "wait"],
			}),
		});
		expectResolveSuccess(response);
	});
});

describe("review boundary", () => {
	test("returns an accepted verdict and uses a fresh review session name", async () => {
		const response = await reviewResolutions(reviewRequest(), {
			runner: runnerReturning(JSON.stringify({ verdict: "accepted", findings: [] })),
		});
		expectReviewSuccess(response);
		expect(response.verdict).toBe("accepted");
		expect(response.session.name).toBe(`${REVIEW_SESSION_PREFIX}custom-v18.16.0-c1`);
		expect(response.findings).toEqual([]);
	});

	test("returns a rejected verdict with real findings", async () => {
		const response = await reviewResolutions(reviewRequest(), {
			runner: runnerReturning(
				JSON.stringify({
					verdict: "rejected",
					findings: [{ path: CONFLICT.path, severity: "error", message: "drops theirs' trailing line" }],
				}),
			),
		});
		expectReviewSuccess(response);
		expect(response.verdict).toBe("rejected");
		expect(response.findings).toEqual([
			{ path: CONFLICT.path, severity: "error", message: "drops theirs' trailing line" },
		]);
	});

	test("rejects a rejection without findings and an acceptance with an error finding", async () => {
		const rejectedEmpty = await reviewResolutions(reviewRequest(), {
			runner: runnerReturning(JSON.stringify({ verdict: "rejected", findings: [] })),
		});
		expectFailure(rejectedEmpty, "REVIEW_MISSING_FINDINGS");
		const acceptedError = await reviewResolutions(reviewRequest(), {
			runner: runnerReturning(
				JSON.stringify({
					verdict: "accepted",
					findings: [{ path: CONFLICT.path, severity: "error", message: "broken" }],
				}),
			),
		});
		expectFailure(acceptedError, "REVIEW_CONTRADICTION");
	});

	test("rejects findings outside the allowlist and malformed verdicts", async () => {
		const cases = [
			JSON.stringify({ verdict: "rejected", findings: [{ path: "other.txt", severity: "error", message: "x" }] }),
			JSON.stringify({ verdict: "maybe", findings: [] }),
			JSON.stringify({ verdict: "rejected", findings: [{ path: CONFLICT.path, severity: "error", message: "  " }] }),
		];
		for (const text of cases) {
			const response = await reviewResolutions(reviewRequest(), { runner: runnerReturning(text) });
			expectFailure(response, "MALFORMED_MODEL_OUTPUT");
		}
	});
});

describe("input validation", () => {
	test("does not invoke the model for invalid requests", async () => {
		let called = 0;
		const runner: TurnRunner = async request => {
			called += 1;
			return { text: "{}", proof: proofFor(request) };
		};
		const responses = [
			await runAdapter({ ...resolveRequest(), conflicts: [CONFLICT, CONFLICT] }, { runner }),
			await runAdapter({ ...resolveRequest(), conflicts: [{ ...CONFLICT, path: "../escape" }] }, { runner }),
			await runAdapter({ ...resolveRequest(), mode: "nope" }, { runner }),
			await runAdapter({ ...resolveRequest(), jobKey: "bad key!" }, { runner }),
			await runAdapter({ ...resolveRequest(), conflicts: [{ ...CONFLICT, base: undefined }] }, { runner }),
		];
		expect(called).toBe(0);
		for (const response of responses) expectFailure(response, "INVALID_INPUT");
	});

	test("stops explicitly on symlink and binary conflicts", async () => {
		let called = 0;
		const runner: TurnRunner = async request => {
			called += 1;
			return { text: "{}", proof: proofFor(request) };
		};
		const symlink = await runAdapter(
			{ ...resolveRequest(), conflicts: [{ ...CONFLICT, type: "symlink" }] },
			{ runner },
		);
		expectFailure(symlink, "UNSUPPORTED_CONFLICT");
		const binary = await runAdapter(
			{ ...resolveRequest(), conflicts: [{ ...CONFLICT, ours: "abc\u0000def" }] },
			{ runner },
		);
		expectFailure(binary, "UNSUPPORTED_CONFLICT");
		expect(called).toBe(0);
	});

	test("review files must cover exactly the conflict paths", async () => {
		const extra = await reviewResolutions(reviewRequest({ files: [{ path: "other.txt", content: "x" }] }), {
			runner: runnerReturning("{}"),
		});
		expectFailure(extra, "INVALID_INPUT");
		const missing = await reviewResolutions(reviewRequest({ files: [] }), {
			runner: runnerReturning("{}"),
		});
		expectFailure(missing, "INVALID_INPUT");
		const duplicate = await reviewResolutions(
			reviewRequest({
				files: [
					{ path: CONFLICT.path, content: "a" },
					{ path: CONFLICT.path, delete: true },
				],
			}),
			{ runner: runnerReturning("{}") },
		);
		expectFailure(duplicate, "INVALID_INPUT");
		const nullContent = await reviewResolutions(
			reviewRequest({ files: [{ path: CONFLICT.path, content: null as unknown as string }] }),
			{ runner: runnerReturning("{}") },
		);
		expectFailure(nullContent, "INVALID_INPUT");
	});

	test("runAdapter requires an explicit, valid mode", async () => {
		const mismatch = await resolveConflicts(reviewRequest() as unknown as ResolveRequest, {
			runner: runnerReturning("{}"),
		});
		expectFailure(mismatch, "INVALID_INPUT");
		const missingMode = await runAdapter({ jobKey: "job-1", conflicts: [CONFLICT] });
		expectFailure(missingMode, "INVALID_INPUT");
	});
});

describe("bounded time", () => {
	test("returns TIMEOUT for a turn that never settles", async () => {
		const pending = Promise.withResolvers<TurnOutcome>();
		const runner: TurnRunner = () => pending.promise;
		const started = Date.now();
		const response = await resolveConflicts(resolveRequest({ timeoutMs: 100 }), { runner });
		expectFailure(response, "TIMEOUT");
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("rejects timeoutMs outside the supported range", async () => {
		const runner = runnerReturning("{}");
		const tooSmall = await resolveConflicts(resolveRequest({ timeoutMs: 1 }), { runner });
		expectFailure(tooSmall, "INVALID_INPUT");
		const tooLarge = await resolveConflicts(resolveRequest({ timeoutMs: 10_000_000 }), { runner });
		expectFailure(tooLarge, "INVALID_INPUT");
	});
});

describe("CLI-shaped dispatch", () => {
	test("dispatches both modes from a plain request object", async () => {
		const resolveResponse = await runAdapter(resolveRequest() as AdapterRequest, {
			runner: runnerReturning(JSON.stringify({ files: [{ path: CONFLICT.path, content: "x" }] })),
		});
		expectResolveSuccess(resolveResponse as ResolveResponse);
		const reviewResponse = await runAdapter(reviewRequest() as AdapterRequest, {
			runner: runnerReturning(JSON.stringify({ verdict: "accepted", findings: [] })),
		});
		expectReviewSuccess(reviewResponse as ReviewResponse);
	});

	test("returns a JSON-safe failure for a non-object request", async () => {
		const response = await runAdapter("nope");
		expectFailure(response, "INVALID_INPUT");
		expect(JSON.parse(JSON.stringify(response))).toEqual(response);
	});

	test("forwards the request sessionDir to the turn runtime", async () => {
		const root = await tempDir();
		const sessions = path.join(root, "runner-sessions");
		let seen: { sessionDir?: string; cwd?: string } = {};
		const response = await runAdapter(resolveRequest({ sessionDir: sessions }), {
			stateRoot: path.join(root, "state"),
			runner: async (request, runtime) => {
				seen = { sessionDir: runtime.sessionDir, cwd: runtime.cwd };
				return {
					text: JSON.stringify({ files: [{ path: CONFLICT.path, content: "alpha\nmerged\n" }] }),
					proof: proofFor(request),
				};
			},
		});
		expectResolveSuccess(response);
		expect(seen.sessionDir).toBe(sessions);
		expect(seen.cwd).toBe(path.join(root, "state", "workdir"));
	});
});

describe("model output classification", () => {
	test("reports unexpected model-output fields as MALFORMED_MODEL_OUTPUT", async () => {
		const resolveTexts = [
			JSON.stringify({ files: [{ path: CONFLICT.path, content: "x", mode: "0777" }] }),
			JSON.stringify({ files: [{ path: CONFLICT.path, content: "x" }], note: "extra" }),
		];
		for (const text of resolveTexts) {
			const response = await resolveConflicts(resolveRequest(), { runner: runnerReturning(text) });
			expectFailure(response, "MALFORMED_MODEL_OUTPUT");
		}
		const reviewTexts = [
			JSON.stringify({ verdict: "accepted", findings: [], note: "extra" }),
			JSON.stringify({
				verdict: "rejected",
				findings: [{ path: CONFLICT.path, severity: "error", message: "broken", confidence: 0.9 }],
			}),
		];
		for (const text of reviewTexts) {
			const response = await reviewResolutions(reviewRequest(), { runner: runnerReturning(text) });
			expectFailure(response, "MALFORMED_MODEL_OUTPUT");
		}
	});
});

describe("bounded input", () => {
	test("counts proposed review content inside the same input budget", async () => {
		let called = 0;
		const runner: TurnRunner = async request => {
			called += 1;
			return { text: "{}", proof: proofFor(request) };
		};
		// The shared budget is MAX_TOTAL_INPUT_CHARS (16_000_000) for conflicts plus review content.
		const response = await reviewResolutions(
			reviewRequest({ files: [{ path: CONFLICT.path, content: "a".repeat(16_000_001) }] }),
			{ runner },
		);
		expectFailure(response, "INVALID_INPUT");
		expect(called).toBe(0);
	});

	test("rejects an oversized CLI request body before parsing it", async () => {
		const body = Buffer.from(`"${"a".repeat(16_000_001)}"`, "utf8");
		const child = Bun.spawn({
			cmd: [process.execPath, path.join(import.meta.dir, "ai-conflict-model.ts")],
			stdin: body,
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exitCode] = await Promise.all([new Response(child.stdout!).text(), child.exited]);
		expect(exitCode).toBe(2);
		expectFailure(JSON.parse(stdout.trim()) as ResolveResponse, "INVALID_INPUT");
	});
});

describe("SDK turn seam", () => {
	test("runs a tool-free, fallback-free, exactly pinned turn inside the requested session dir", async () => {
		const root = await tempDir();
		const sessions = path.join(root, "sessions");
		const stateRoot = path.join(root, "state");
		const { sdk, state } = fakeSdk({ agentDir: path.join(root, "agent") });
		const response = await resolveConflicts(resolveRequest({ sessionDir: sessions }), { sdk, stateRoot });
		expectResolveSuccess(response);

		const captured = state.captured as Record<string, unknown>;
		expect(captured.restrictToolNames).toBe(true);
		expect(captured.toolNames).toEqual([]);
		expect(captured.disableModelFallback).toBe(true);
		expect(captured.disableServerSideFallback).toBe(true);
		expect(captured.settings).toBe(state.isolatedSettings);
		expect(state.isolatedOverrides).toEqual({ "autolearn.enabled": false, "retry.modelFallback": false });
		expect(captured.model).toEqual({ provider: AI_CONFLICT_MODEL.provider, id: AI_CONFLICT_MODEL.id });
		expect(state.findArgs).toEqual([AI_CONFLICT_MODEL.provider, AI_CONFLICT_MODEL.id]);
		expect(state.registrySettings).toBe(state.isolatedSettings);

		expect(state.sessionDir).toBe(sessions);
		expect(state.sessionCwd).toBe(path.join(stateRoot, "workdir"));
		expect(response.session.file).toBe(path.join(sessions, "fake-session.jsonl"));
		expect(response.session.id).toBe("fake-session-id");
		expect(response.session.name).toBe(`${RESOLVER_SESSION_PREFIX}custom-v18.16.0-c1`);
		expect(response.proof.sessionName).toBe(response.session.name);
		expect(response.proof.assistantMessages).toBe(1);
		expect(response.proof.toolCalls).toBe(0);
		expect(response.proof.toolsExposed).toBe(0);
		expect(state.setNameCalls).toBe(1);
		expect(state.promptCalls).toBe(1);
		expect(state.disposeCalls).toBe(1);
		expect(state.closeCalls).toBe(1);

		for (const dir of [stateRoot, sessions, path.join(stateRoot, "workdir"), path.join(stateRoot, "cache")]) {
			expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
		}
		expect((await fs.stat(path.join(sessions, "fake-session.jsonl"))).mode & 0o777).toBe(0o600);
	});

	test("fails closed with MODEL_PROOF_MISMATCH when the SDK dispatches another model", async () => {
		const root = await tempDir();
		const { sdk, state } = fakeSdk({
			agentDir: path.join(root, "agent"),
			dispatchModel: { provider: "openrouter", id: "other-model" },
			wrapDispatchError: true,
		});
		const response = await resolveConflicts(resolveRequest({ sessionDir: path.join(root, "sessions") }), {
			sdk,
			stateRoot: path.join(root, "state"),
		});
		expectFailure(response, "MODEL_PROOF_MISMATCH");
		expect(state.promptCalls).toBe(1);
	});

	test("keeps MODEL_PROOF_MISMATCH when creation itself dispatches another model", async () => {
		const root = await tempDir();
		const { sdk, state } = fakeSdk({
			agentDir: path.join(root, "agent"),
			dispatchModel: { provider: "openrouter", id: "other-model" },
			dispatchAtCreate: true,
			wrapDispatchError: true,
		});
		const response = await resolveConflicts(resolveRequest({ sessionDir: path.join(root, "sessions") }), {
			sdk,
			stateRoot: path.join(root, "state"),
		});
		expectFailure(response, "MODEL_PROOF_MISMATCH");
		expect(state.promptCalls).toBe(0);
	});

	test("requires the session to accept the requested name before prompting", async () => {
		const root = await tempDir();
		const { sdk, state } = fakeSdk({ agentDir: path.join(root, "agent"), nameAccepted: false });
		const response = await resolveConflicts(resolveRequest({ sessionDir: path.join(root, "sessions") }), {
			sdk,
			stateRoot: path.join(root, "state"),
		});
		expectFailure(response, "MODEL_PROOF_MISMATCH");
		expect(state.setNameCalls).toBe(1);
		expect(state.promptCalls).toBe(0);
	});

	test("does not fall back to the request name when the session records none", async () => {
		const root = await tempDir();
		const { sdk, state } = fakeSdk({ agentDir: path.join(root, "agent"), nameRecorded: false });
		const response = await resolveConflicts(resolveRequest({ sessionDir: path.join(root, "sessions") }), {
			sdk,
			stateRoot: path.join(root, "state"),
		});
		expectFailure(response, "MODEL_PROOF_MISMATCH");
		expect(state.promptCalls).toBe(1);
	});
});
