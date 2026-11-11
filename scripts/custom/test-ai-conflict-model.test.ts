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
	MAX_CALL_OUTPUT_TOKENS,
	REVIEW_SESSION_PREFIX,
	RESOLVER_SESSION_PREFIX,
	assembleMergedFile,
	conflictMarkerIn,
	estimateTokens,
	parseMergedFile,
	reviewResolutions,
	resolveConflicts,
	runAdapter,
	sessionOutputCap,
	type SdkModule,
	type TurnOutcome,
	type TurnProof,
	type TurnRequest,
	type TurnRunner,
} from "./ai-conflict-model";

/** A modify/modify conflict exactly as git writes it under merge.conflictStyle=diff3. */
const CONFLICT: ConflictInput = {
	path: "src/demo.txt",
	base: "alpha\n",
	ours: "alpha\nours\n",
	theirs: "alpha\ntheirs\n",
	merged: "alpha\n<<<<<<< HEAD\nours\n||||||| 9058ab9\n=======\ntheirs\n>>>>>>> upstream\n",
};

/** The answer for CONFLICT's single region, and the merged file it must assemble to. */
const ANSWER = JSON.stringify({ resolutions: [{ path: CONFLICT.path, region: 0, content: "ours\ntheirs\n" }] });
const MERGED = "alpha\nours\ntheirs\n";

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
		resolutions: [{ path: CONFLICT.path, region: 0, content: "ours\ntheirs\n" }],
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
	registryModelsFile?: string;
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
	/** Assistant messages the fake turn records, in order; overrides `assistantText`. */
	assistantMessages?: Array<{
		text?: string;
		stopReason?: string;
		errorStatus?: number | null;
		errorMessage?: string | null;
	}>;
	/** Registry limits the adapter's payload preflight reads; omitted means "not exposed". */
	contextWindow?: number;
	maxTokens?: number;
}

/** In-memory stand-in for the installed OMP SDK; no network, no real session storage. */
function fakeSdk(options: FakeSdkOptions): { sdk: SdkModule; state: FakeSdkState } {
	const model = {
		provider: AI_CONFLICT_MODEL.provider,
		id: AI_CONFLICT_MODEL.id,
		contextWindow: options.contextWindow,
		maxTokens: options.maxTokens,
	};
	const state: FakeSdkState = {
		agentDir: options.agentDir,
		setNameCalls: 0,
		promptCalls: 0,
		disposeCalls: 0,
		closeCalls: 0,
	};
	const manager: { file?: string; name?: string } = {};
	const assistantText = options.assistantText ?? ANSWER;

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
			constructor(_auth: unknown, modelsYml: string, registryOptions: { settings: unknown }) {
				state.registryModelsFile = modelsYml;
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
					stopReason?: string;
					errorStatus?: number | null;
					errorMessage?: string | null;
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
					for (const message of options.assistantMessages ?? [{ text: assistantText }]) {
						sessionState.messages.push({
							role: "assistant",
							provider: model.provider,
							model: model.id,
							api: "openai-completions",
							content: [{ type: "text", text: message.text ?? "" }],
							stopReason: message.stopReason ?? "stop",
							errorStatus: message.errorStatus,
							errorMessage: message.errorMessage,
						});
					}
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
			runner: runnerReturning(ANSWER),
		});
		expectResolveSuccess(response);
		expect(response.files).toEqual([{ path: CONFLICT.path, content: MERGED }]);
		expect(response.session.name).toBe(`${RESOLVER_SESSION_PREFIX}custom-v18.16.0-c1`);
		expect(response.model).toEqual({ provider: AI_CONFLICT_MODEL.provider, id: AI_CONFLICT_MODEL.id });
		expect(response.proof.toolCalls).toBe(0);
	});

	test("assembles the answer into the merged file, keeping every other byte", async () => {
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerReturning(ANSWER),
		});
		expectResolveSuccess(response);
		// The region block is gone and the surrounding merged line survives untouched.
		expect(response.files).toEqual([{ path: CONFLICT.path, content: MERGED }]);
		expect(response.resolutions).toEqual([{ path: CONFLICT.path, region: 0, content: "ours\ntheirs\n" }]);
		expect(response.proof.regions).toEqual({ [CONFLICT.path]: 1 });
	});

	test("an empty answer deletes the block and nothing else", async () => {
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerReturning(JSON.stringify({ resolutions: [{ path: CONFLICT.path, region: 0, content: "" }] })),
		});
		expectResolveSuccess(response);
		expect(response.files).toEqual([{ path: CONFLICT.path, content: "alpha\n" }]);
	});

	test("an empty answer for a whole-file region deletes the path", async () => {
		// modify/delete: git keeps the surviving side with no markers, so the file is the region.
		const deleted: ConflictInput = {
			path: "moddel.txt",
			base: "kept\n",
			ours: null,
			theirs: "kept\nmodified\n",
			merged: "kept\nmodified\n",
		};
		const response = await resolveConflicts(resolveRequest({ conflicts: [deleted] }), {
			runner: runnerReturning(JSON.stringify({ resolutions: [{ path: "moddel.txt", region: 0, content: "" }] })),
		});
		expectResolveSuccess(response);
		expect(response.files).toEqual([{ path: "moddel.txt", delete: true }]);
		const kept = await resolveConflicts(resolveRequest({ conflicts: [deleted] }), {
			runner: runnerReturning(
				JSON.stringify({ resolutions: [{ path: "moddel.txt", region: 0, content: "kept\nmodified\n" }] }),
			),
		});
		expectResolveSuccess(kept);
		expect(kept.files).toEqual([{ path: "moddel.txt", content: "kept\nmodified\n" }]);
	});

	test("rejects unknown, missing, duplicated and out-of-range regions", async () => {
		const cases = [
			JSON.stringify({
				resolutions: [
					{ path: CONFLICT.path, region: 0, content: "a" },
					{ path: "other.txt", region: 0, content: "b" },
				],
			}),
			JSON.stringify({ resolutions: [] }),
			JSON.stringify({
				resolutions: [
					{ path: CONFLICT.path, region: 0, content: "a" },
					{ path: CONFLICT.path, region: 0, content: "b" },
				],
			}),
			JSON.stringify({ resolutions: [{ path: CONFLICT.path, region: 1, content: "a" }] }),
			JSON.stringify({ resolutions: [{ path: CONFLICT.path, region: -1, content: "a" }] }),
			JSON.stringify({ resolutions: [{ path: CONFLICT.path, region: 0.5, content: "a" }] }),
			JSON.stringify({ resolutions: [{ path: "../escape.txt", region: 0, content: "a" }] }),
			JSON.stringify({ resolutions: [{ path: CONFLICT.path, region: 0, content: "a", delete: true }] }),
			JSON.stringify({ resolutions: [{ path: CONFLICT.path, content: "a" }] }),
			JSON.stringify({ resolutions: [{ path: CONFLICT.path, region: 0, content: 7 }] }),
		];
		for (const text of cases) {
			const response = await resolveConflicts(resolveRequest(), { runner: runnerReturning(text) });
			expectFailure(response, "MALFORMED_MODEL_OUTPUT");
		}
	});

	test("rejects an answer that reopens a conflict block", async () => {
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerReturning(
				JSON.stringify({
					resolutions: [{ path: CONFLICT.path, region: 0, content: "<<<<<<< HEAD\nours\ntheirs\n" }],
				}),
			),
		});
		expectFailure(response, "MALFORMED_MODEL_OUTPUT");
		if (response.ok) return;
		expect(response.error.message).toContain("conflict marker line");
	});

	test("keeps marker-like lines that are legitimate merged text", async () => {
		for (const line of ["=======", "||||||| 9058ab9", ">>>>>>> upstream"]) {
			const content = `ours\n${line}\ntheirs\n`;
			const response = await resolveConflicts(resolveRequest(), {
				runner: runnerReturning(JSON.stringify({ resolutions: [{ path: CONFLICT.path, region: 0, content }] })),
			});
			expectResolveSuccess(response);
			// Assembly copies the answer over the block, so the line reaches the merged file.
			expect(response.files).toEqual([{ path: CONFLICT.path, content: `alpha\n${content}` }]);
		}
		expect(conflictMarkerIn("=======\n")).toBeUndefined();
		expect(conflictMarkerIn(">>>>>>> upstream\n")).toBeUndefined();
		expect(conflictMarkerIn("<<<<<<< HEAD\n")).toBe("<<<<<<<");
	});

	test("rejects malformed or prose-wrapped JSON", async () => {
		for (const text of [
			"",
			"not json",
			'```json\n{"resolutions":[]}\n````',
			'Here you go: {"resolutions":[]}',
			"[]",
		]) {
			const response = await resolveConflicts(resolveRequest(), { runner: runnerReturning(text) });
			expectFailure(response, "MALFORMED_MODEL_OUTPUT");
		}
	});

	test("accepts a single fenced JSON object", async () => {
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerReturning("```json\n" + ANSWER + "\n```"),
		});
		expectResolveSuccess(response);
	});
});

function diff3(tag: string, base: boolean, eol = "\n"): string {
	const lines = [
		`<<<<<<< HEAD`,
		`ours-${tag}`,
		`||||||| 9058ab9`,
		`base-${tag}`,
		`=======`,
		`theirs-${tag}`,
		">>>>>>> upstream",
	];
	if (!base) lines.splice(2, 2);
	return lines.map(line => line + eol).join("");
}

function conflictAt(filePath: string, merged: string): ConflictInput {
	return { path: filePath, base: "base\n", ours: "ours\n", theirs: "theirs\n", merged };
}

describe("conflict region parsing", () => {
	test("reads a diff3 block into ours/base/theirs plus merged context", () => {
		const conflict = conflictAt("a.txt", `head\n${diff3("one", true)}tail\n`);
		const plan = parseMergedFile(conflict);
		expect(plan.wholeFile).toBe(false);
		expect(plan.regions).toEqual([
			{
				index: 0,
				ours: "ours-one\n",
				base: "base-one\n",
				theirs: "theirs-one\n",
				before: "head\n",
				after: "tail\n",
			},
		]);
	});

	test("tolerates a block with no base section (both sides added)", () => {
		const plan = parseMergedFile(conflictAt("b.txt", diff3("add", false)));
		expect(plan.regions[0]).toEqual({
			index: 0,
			ours: "ours-add\n",
			base: null,
			theirs: "theirs-add\n",
			before: "",
			after: "",
		});
	});

	test("tolerates an empty base section (add/add as git writes it)", () => {
		const merged = "alpha\n<<<<<<< HEAD\nours\n||||||| 9058ab9\n=======\ntheirs\n>>>>>>> upstream\n";
		expect(parseMergedFile(conflictAt("c.txt", merged)).regions[0]?.base).toBe("");
	});

	test("splits two adjacent regions without overlapping their context", () => {
		const plan = parseMergedFile(conflictAt("d.txt", diff3("one", true) + diff3("two", true)));
		expect(plan.regions.map(region => [region.index, region.before, region.after])).toEqual([
			[0, "", ""],
			[1, "", ""],
		]);
		const spaced = parseMergedFile(conflictAt("e.txt", `top\n${diff3("one", true)}mid\n${diff3("two", true)}end\n`));
		expect(spaced.regions.map(region => [region.before, region.after])).toEqual([
			["top\n", "mid\n"],
			["mid\n", "end\n"],
		]);
	});

	test("caps the merged context at 30 lines on each side", () => {
		const before = Array.from({ length: 40 }, (_, index) => `before-${index}\n`).join("");
		const after = Array.from({ length: 40 }, (_, index) => `after-${index}\n`).join("");
		const plan = parseMergedFile(conflictAt("f.txt", before + diff3("one", true) + after));
		const region = plan.regions[0]!;
		expect(region.before).toBe(before.split("\n").filter(Boolean).slice(-30).join("\n") + "\n");
		expect(region.after).toBe(after.split("\n").filter(Boolean).slice(0, 30).join("\n") + "\n");
	});

	test("reads markers out of a CRLF file", () => {
		const plan = parseMergedFile(conflictAt("g.txt", `head\r\n${diff3("crlf", true, "\r\n")}tail\r\n`));
		expect(plan.regions[0]).toEqual({
			index: 0,
			ours: "ours-crlf\r\n",
			base: "base-crlf\r\n",
			theirs: "theirs-crlf\r\n",
			before: "head\r\n",
			after: "tail\r\n",
		});
	});

	test("keeps a content line that merely starts with the separator", () => {
		const merged = [
			"<<<<<<< HEAD",
			"ours",
			"||||||| 9058ab9",
			"base",
			"=======",
			"======= not a marker",
			">>>>>>> upstream",
			"",
		].join("\n");
		const plan = parseMergedFile(conflictAt("h.txt", merged));
		expect(plan.regions[0]?.theirs).toBe("======= not a marker\n");
		expect(conflictMarkerIn("======= not a marker\n")).toBeUndefined();
	});

	test("refuses a file that ends inside a region", () => {
		for (const merged of ["<<<<<<< HEAD\nours\n", "<<<<<<< HEAD\nours\n=======\ntheirs\n"]) {
			expect(() => parseMergedFile(conflictAt("i.txt", merged))).toThrow(
				/ends inside the block that starts at line 1/,
			);
		}
	});

	test("treats a body line starting with the terminator as text before the separator", () => {
		const merged = [
			"<<<<<<< HEAD",
			">>>>>>> this ours line only looks like a terminator",
			"||||||| 9058ab9",
			"base",
			"=======",
			"theirs",
			">>>>>>> upstream",
			"tail",
			"",
		].join("\n");
		const plan = parseMergedFile(conflictAt("k.txt", merged));
		expect(plan.regions).toHaveLength(1);
		expect(plan.regions[0]?.ours).toBe(">>>>>>> this ours line only looks like a terminator\n");
		expect(plan.regions[0]?.theirs).toBe("theirs\n");
		// The span still ends at the real terminator, so the tail is outside it.
		expect(merged.slice(plan.spans[0]!.end)).toBe("tail\n");
	});

	test("does not read a base section that follows the separator", () => {
		const merged = [
			"<<<<<<< HEAD",
			"ours",
			"=======",
			"||||||| ours-side text that looks like a base marker",
			"theirs",
			">>>>>>> upstream",
			"",
		].join("\n");
		const plan = parseMergedFile(conflictAt("l.txt", merged));
		expect(plan.regions[0]?.base).toBeNull();
		expect(plan.regions[0]?.theirs).toBe("||||||| ours-side text that looks like a base marker\ntheirs\n");
	});

	test("refuses two base sections before the separator", () => {
		const merged = [
			"<<<<<<< HEAD",
			"ours",
			"||||||| a",
			"base",
			"||||||| b",
			"=======",
			"theirs",
			">>>>>>> upstream",
			"",
		].join("\n");
		expect(() => parseMergedFile(conflictAt("m.txt", merged))).toThrow(/has two "\|\|\|\|\|\|\|" sections/);
	});

	test("refuses a conflicted file that carries no markers and no removed side", () => {
		expect(() => parseMergedFile(conflictAt("j.txt", "clean\n"))).toThrow(/carries no conflict block/);
	});

	test("treats a marker-free modify/delete conflict as one whole-file region", () => {
		const plan = parseMergedFile({
			path: "moddel.txt",
			base: "kept\n",
			ours: "kept\n",
			theirs: null,
			merged: "kept\n",
		});
		expect(plan.wholeFile).toBe(true);
		expect(plan.regions).toEqual([{ index: 0, ours: "kept\n", base: "kept\n", theirs: null, before: "", after: "" }]);
	});
});

describe("region payload", () => {
	test("sends regions, never a merged file with markers", async () => {
		let prompt = "";
		const response = await resolveConflicts(resolveRequest(), {
			runner: async request => {
				prompt = request.prompt;
				return { text: ANSWER, proof: proofFor(request) };
			},
		});
		expectResolveSuccess(response);
		expect(prompt).toContain("<conflict-regions>");
		const payload = JSON.parse(
			prompt.slice(prompt.indexOf("<conflict-regions>") + 18, prompt.indexOf("</conflict-regions>")),
		);
		expect(payload).toEqual([
			{
				path: CONFLICT.path,
				wholeFile: false,
				regions: [
					{
						index: 0,
						ours: "ours\n",
						base: "",
						theirs: "theirs\n",
						before: "alpha\n",
						after: "",
					},
				],
			},
		]);
		expect(prompt).not.toContain("<<<<<<<");
		expect(prompt).not.toContain(">>>>>>>");
	});

	test("the review carries the regions and the proposed replacement", async () => {
		let prompt = "";
		const response = await reviewResolutions(reviewRequest(), {
			runner: async request => {
				prompt = request.prompt;
				return { text: JSON.stringify({ verdict: "accepted", findings: [] }), proof: proofFor(request) };
			},
		});
		expectReviewSuccess(response);
		expect(prompt).toContain("<review-data>");
		const payload = JSON.parse(prompt.slice(prompt.indexOf("<review-data>") + 13, prompt.indexOf("</review-data>")));
		expect(payload[0].regions[0].proposed).toBe("ours\ntheirs\n");
		expect(payload[0].regions[0].theirs).toBe("theirs\n");
	});
});

describe("region assembly", () => {
	const merged = `top\n${diff3("one", true)}mid\n${diff3("two", true)}end\n`;

	test("replaces only the marker blocks and copies every other byte", () => {
		const plan = parseMergedFile(conflictAt("k.txt", merged));
		const answers = new Map([
			[0, "merged-one\n"],
			[1, ""],
		]);
		expect(assembleMergedFile(plan, merged, answers)).toEqual({
			path: "k.txt",
			content: "top\nmerged-one\nmid\nend\n",
		});
	});

	test("reassembles the original file byte for byte when each answer is the block it replaces", () => {
		const plan = parseMergedFile(conflictAt("l.txt", merged));
		const answers = new Map(plan.spans.map((span, index) => [index, merged.slice(span.start, span.end)]));
		expect(assembleMergedFile(plan, merged, answers)).toEqual({ path: "l.txt", content: merged });
		const crlf = `top\r\n${diff3("crlf", true, "\r\n")}end\r\n`;
		const crlfPlan = parseMergedFile(conflictAt("l2.txt", crlf));
		const crlfAnswers = new Map(crlfPlan.spans.map((span, index) => [index, crlf.slice(span.start, span.end)]));
		expect(assembleMergedFile(crlfPlan, crlf, crlfAnswers)).toEqual({ path: "l2.txt", content: crlf });
	});

	test("an empty answer deletes its block only", () => {
		const plan = parseMergedFile(conflictAt("m.txt", `top\n${diff3("one", true)}end\n`));
		const out = assembleMergedFile(plan, `top\n${diff3("one", true)}end\n`, new Map([[0, ""]]));
		expect(out).toEqual({ path: "m.txt", content: "top\nend\n" });
	});
});

describe("transcript proof", () => {
	test("rejects a different provider or model", async () => {
		for (const overrides of [{ provider: "openrouter" }, { model: "deepseek-v4.1-flash-free" }]) {
			const response = await resolveConflicts(resolveRequest(), {
				runner: runnerReturning(ANSWER, overrides),
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
				runner: runnerReturning(ANSWER, overrides),
			});
			expectFailure(response, "MODEL_PROOF_MISMATCH");
		}
	});

	test("rejects an unexpected session name and a gateway-substituted model", async () => {
		for (const overrides of [{ sessionName: "OMP — something else" }, { upstreamModel: "other-model" }]) {
			const response = await resolveConflicts(resolveRequest(), {
				runner: runnerReturning(ANSWER, overrides),
			});
			expectFailure(response, "MODEL_PROOF_MISMATCH");
		}
	});

	test("allows same-model retry recoveries", async () => {
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerReturning(ANSWER, {
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

	test("review resolutions must cover exactly the planned regions", async () => {
		const extra = await reviewResolutions(
			reviewRequest({ resolutions: [{ path: "other.txt", region: 0, content: "x" }] }),
			{ runner: runnerReturning("{}") },
		);
		expectFailure(extra, "INVALID_INPUT");
		const missing = await reviewResolutions(reviewRequest({ resolutions: [] }), {
			runner: runnerReturning("{}"),
		});
		expectFailure(missing, "INVALID_INPUT");
		const duplicate = await reviewResolutions(
			reviewRequest({
				resolutions: [
					{ path: CONFLICT.path, region: 0, content: "a" },
					{ path: CONFLICT.path, region: 0, content: "b" },
				],
			}),
			{ runner: runnerReturning("{}") },
		);
		expectFailure(duplicate, "INVALID_INPUT");
		const beyond = await reviewResolutions(
			reviewRequest({ resolutions: [{ path: CONFLICT.path, region: 3, content: "a" }] }),
			{ runner: runnerReturning("{}") },
		);
		expectFailure(beyond, "INVALID_INPUT");
		const nullContent = await reviewResolutions(
			reviewRequest({ resolutions: [{ path: CONFLICT.path, region: 0, content: null as unknown as string }] }),
			{ runner: runnerReturning("{}") },
		);
		expectFailure(nullContent, "INVALID_INPUT");
	});

	test("review feedback is bounded to the conflicted plan and its regions", async () => {
		let called = 0;
		const runner: TurnRunner = async request => {
			called += 1;
			return { text: ANSWER, proof: proofFor(request) };
		};
		const note = {
			path: CONFLICT.path,
			regions: [0],
			findings: ["region 0 uses a name declared later"],
			priorAnswers: [{ region: 0, content: "ours\n" }],
		};
		const responses = [
			await runAdapter({ ...resolveRequest(), reviewFeedback: [{ ...note, path: "other.txt" }] }, { runner }),
			await runAdapter({ ...resolveRequest(), reviewFeedback: [{ ...note, priorAnswers: [] }] }, { runner }),
			await runAdapter(
				{ ...resolveRequest(), reviewFeedback: [{ ...note, priorAnswers: [{ region: 3, content: "x" }] }] },
				{ runner },
			),
			await runAdapter({ ...resolveRequest(), reviewFeedback: [{ ...note, regions: [0, 1] }] }, { runner }),
			await runAdapter({ ...resolveRequest(), reviewFeedback: [{ ...note, findings: [] }] }, { runner }),
			await runAdapter(
				{ ...resolveRequest(), reviewFeedback: [{ ...note, priorAnswers: [{ region: 0, content: null }] }] },
				{ runner },
			),
			await runAdapter({ ...reviewRequest(), reviewFeedback: [note] }, { runner }),
			await runAdapter({ ...resolveRequest(), reviewFeedback: [] }, { runner }),
		];
		expect(called).toBe(0);
		for (const response of responses) expectFailure(response, "INVALID_INPUT");
	});

	test("runAdapter requires an explicit, valid mode", async () => {
		const mismatch = await resolveConflicts(reviewRequest() as unknown as ResolveRequest, {
			runner: runnerReturning("{}"),
		});
		expectFailure(mismatch, "INVALID_INPUT");
		const missingMode = await runAdapter({ jobKey: "job-1", conflicts: [CONFLICT] });
		expectFailure(missingMode, "INVALID_INPUT");
	});

	test("refusal notes are bounded to the conflicted plan", async () => {
		let called = 0;
		const runner: TurnRunner = async request => {
			called += 1;
			return { text: ANSWER, proof: proofFor(request) };
		};
		const responses = [
			await runAdapter(
				{ ...resolveRequest(), refusals: [{ path: "other.txt", side: "ours", regions: [0], reason: "x" }] },
				{ runner },
			),
			await runAdapter(
				{ ...resolveRequest(), refusals: [{ path: CONFLICT.path, side: "ours", regions: [9], reason: "x" }] },
				{ runner },
			),
			await runAdapter(
				{ ...resolveRequest(), refusals: [{ path: CONFLICT.path, side: "ours", regions: [0], reason: "  " }] },
				{ runner },
			),
			await runAdapter(
				{ ...resolveRequest(), refusals: [{ path: CONFLICT.path, side: "neither", regions: [0], reason: "x" }] },
				{ runner },
			),
			await runAdapter({ ...resolveRequest(), refusals: [] }, { runner }),
			await runAdapter(
				{ ...reviewRequest(), refusals: [{ path: CONFLICT.path, side: "ours", regions: [0], reason: "x" }] },
				{
					runner,
				},
			),
		];
		expect(called).toBe(0);
		for (const response of responses) expectFailure(response, "INVALID_INPUT");
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
			runner: runnerReturning(ANSWER),
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
					text: ANSWER,
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
			JSON.stringify({ resolutions: [{ path: CONFLICT.path, region: 0, content: "x", mode: "0777" }] }),
			JSON.stringify({ resolutions: [{ path: CONFLICT.path, region: 0, content: "x" }], note: "extra" }),
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
			reviewRequest({ resolutions: [{ path: CONFLICT.path, region: 0, content: "a".repeat(16_000_001) }] }),
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
		expect(captured.model).toMatchObject({
			provider: AI_CONFLICT_MODEL.provider,
			id: AI_CONFLICT_MODEL.id,
			maxTokens: MAX_CALL_OUTPUT_TOKENS,
		});
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

function runnerWith(extra: Partial<TurnOutcome>): TurnRunner {
	return async (request): Promise<TurnOutcome> => ({
		text: "",
		proof: proofFor(request),
		...extra,
	});
}

describe("empty-turn dispositions", () => {
	test("carries the provider's own error text and status", async () => {
		const providerMessage =
			"400 Upstream request failed: [invalid_request_error] Input too long: model limit 1048576 tokens, requested 2024557 tokens";
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerWith({ stopReason: "error", errorStatus: 400, errorMessage: providerMessage }),
		});
		expectFailure(response, "PROVIDER_ERROR");
		if (response.ok) return;
		expect(response.error.message).toContain("provider error 400: 400 Upstream request failed");
		expect(response.error.message).toContain("Input too long: model limit 1048576 tokens");
		expect(response.error.status).toBe(400);
		expect(response.proof?.model).toBe(AI_CONFLICT_MODEL.id);
		expect(response.session?.name).toBe(`${RESOLVER_SESSION_PREFIX}custom-v18.16.0-c1`);
	});

	test("applies the same disposition to a review turn", async () => {
		const response = await reviewResolutions(reviewRequest(), {
			runner: runnerWith({ stopReason: "error", errorMessage: "503 upstream unavailable" }),
		});
		expectFailure(response, "PROVIDER_ERROR");
		if (response.ok) return;
		expect(response.error.message).toBe("provider error: 503 upstream unavailable");
		expect(response.error.status).toBeUndefined();
	});

	test("reports a reasoning-only message as malformed", async () => {
		const response = await resolveConflicts(resolveRequest(), { runner: runnerWith({ reasoningOnly: true }) });
		expectFailure(response, "MALFORMED_MODEL_OUTPUT");
		if (response.ok) return;
		expect(response.error.message).toContain("only reasoning and no answer text");
	});

	test("reports a cut-off answer as truncated even when text arrived", async () => {
		const partial = '{"resolutions":[{"path":"src/demo.txt","region":0,"content":"alpha\\nmerged';
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerWith({ text: partial, stopReason: "length" }),
		});
		expectFailure(response, "OUTPUT_TRUNCATED");
		if (response.ok) return;
		expect(response.error.message).toContain("output token cap");
	});

	test("refuses an answer that arrived beside an error status", async () => {
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerWith({
				text: ANSWER,
				stopReason: "error",
				errorMessage: "stream reset after a partial answer",
			}),
		});
		expectFailure(response, "PROVIDER_ERROR");
		if (response.ok) return;
		expect(response.error.message).toContain("stream reset after a partial answer");
	});

	test("fails a resumed turn whose earlier message ended in error", async () => {
		const root = await tempDir();
		const { sdk } = fakeSdk({
			agentDir: path.join(root, "agent"),
			// A stream reset keeps its partial text, the SDK resumes, and the tail alone is
			// not a whole answer: the error must win over the fragment.
			assistantMessages: [
				{
					text: '{"resolutions":[{"path":"src/demo.txt","region":0,"content":"alpha',
					stopReason: "error",
					errorMessage: "ECONNRESET: The socket connection was closed unexpectedly.",
				},
				{ text: '\\nmerged"}]}', stopReason: "stop" },
			],
		});
		const response = await resolveConflicts(resolveRequest({ sessionDir: path.join(root, "sessions") }), {
			sdk,
			stateRoot: path.join(root, "state"),
		});
		expectFailure(response, "PROVIDER_ERROR");
		if (response.ok) return;
		expect(response.error.message).toContain("ECONNRESET: The socket connection was closed unexpectedly.");
		expect(response.error.message).toContain("assistant message 1 of 2 ended in error");
		expect(response.error.message).toContain("1 later assistant message followed it");
		expect(response.proof?.assistantMessages).toBe(2);
	});

	test("ignores an empty error field on a successful message", async () => {
		const root = await tempDir();
		const { sdk } = fakeSdk({
			agentDir: path.join(root, "agent"),
			assistantMessages: [
				{
					text: ANSWER,
					stopReason: "stop",
					errorStatus: null,
					errorMessage: "",
				},
			],
		});
		const response = await resolveConflicts(resolveRequest({ sessionDir: path.join(root, "sessions") }), {
			sdk,
			stateRoot: path.join(root, "state"),
		});
		expectResolveSuccess(response);
		expect(response.files).toEqual([{ path: CONFLICT.path, content: MERGED }]);
	});
});

describe("payload preflight", () => {
	test("overestimates tokens at 3.2 chars per token", () => {
		expect(estimateTokens(0)).toBe(0);
		expect(estimateTokens(3200)).toBe(1000);
		expect(estimateTokens(3201)).toBe(1001);
	});

	test("refuses a payload that cannot fit the window before dispatching", async () => {
		const root = await tempDir();
		const { sdk, state } = fakeSdk({
			agentDir: path.join(root, "agent"),
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		});
		const response = await resolveConflicts(
			resolveRequest({
				sessionDir: path.join(root, "sessions"),
				conflicts: [{ ...CONFLICT, merged: `${"x".repeat(4_000_000)}\n${diff3("huge", true)}` }],
			}),
			{ sdk, stateRoot: path.join(root, "state") },
		);
		expectFailure(response, "PAYLOAD_TOO_LARGE");
		if (response.ok) return;
		expect(response.error.message).toContain("1000000-token context window");
		expect(state.promptCalls).toBe(0);
		expect(state.captured).toBeUndefined();
	});

	test("dispatches when the estimate plus output reserve fits", async () => {
		const root = await tempDir();
		const { sdk, state } = fakeSdk({
			agentDir: path.join(root, "agent"),
			contextWindow: 1_000_000,
			maxTokens: 384_000,
		});
		const response = await resolveConflicts(resolveRequest({ sessionDir: path.join(root, "sessions") }), {
			sdk,
			stateRoot: path.join(root, "state"),
		});
		expectResolveSuccess(response);
		expect(state.promptCalls).toBe(1);
	});

	test("reserves one completion's route cap, not the registry's whole maxTokens", async () => {
		const root = await tempDir();
		// ~189000 chars of merged context: ~59063 input tokens, which fits beside the 48000
		// resolve reserve but not beside the registry's full 384000.
		const { sdk, state } = fakeSdk({
			agentDir: path.join(root, "agent"),
			contextWindow: 300_000,
			maxTokens: 384_000,
		});
		const response = await resolveConflicts(
			resolveRequest({
				sessionDir: path.join(root, "sessions"),
				conflicts: [{ ...CONFLICT, merged: `${"x".repeat(189_000)}\n${diff3("big", true)}` }],
			}),
			{ sdk, stateRoot: path.join(root, "state") },
		);
		expectResolveSuccess(response);
		expect(state.promptCalls).toBe(1);
	});

	test("names the completion cap when the reserve pushes the payload over", async () => {
		const root = await tempDir();
		const { sdk, state } = fakeSdk({
			agentDir: path.join(root, "agent"),
			contextWindow: 300_000,
			maxTokens: 384_000,
		});
		const response = await resolveConflicts(
			resolveRequest({
				sessionDir: path.join(root, "sessions"),
				conflicts: [{ ...CONFLICT, merged: `${"x".repeat(900_000)}\n${diff3("wide", true)}` }],
			}),
			{ sdk, stateRoot: path.join(root, "state") },
		);
		expectFailure(response, "PAYLOAD_TOO_LARGE");
		if (response.ok) return;
		expect(response.error.message).toContain("completions capped at 48000 tokens");
		expect(response.error.message).toContain("300000-token context window");
		expect(state.promptCalls).toBe(0);
	});
});

describe("model registry", () => {
	test("reads the install's own models.yml and writes no override of its own", async () => {
		const root = await tempDir();
		const agentDir = path.join(root, "agent");
		const stateRoot = path.join(root, "state");
		const { sdk, state } = fakeSdk({ agentDir, contextWindow: 1_000_000, maxTokens: 384_000 });
		const response = await resolveConflicts(resolveRequest({ sessionDir: path.join(root, "sessions") }), {
			sdk,
			stateRoot,
		});
		expectResolveSuccess(response);
		// A region plan needs ~15k output tokens, so the resolver carries no compat override and
		// no models.yml of its own; it only lowers the session model's output cap.
		expect(state.registryModelsFile).toBe(path.join(agentDir, "models.yml"));
		await expect(fs.stat(path.join(stateRoot, "models.yml"))).rejects.toThrow();
		const stray = await fs.readdir(stateRoot);
		expect(stray).not.toContain("models.yml");
	});
});

describe("enforced output cap", () => {
	test("never exceeds the call cap and follows a smaller route cap", () => {
		expect(sessionOutputCap(384_000)).toBe(MAX_CALL_OUTPUT_TOKENS);
		expect(sessionOutputCap(20_000)).toBe(20_000);
		expect(sessionOutputCap(undefined)).toBe(MAX_CALL_OUTPUT_TOKENS);
		expect(sessionOutputCap(0)).toBe(MAX_CALL_OUTPUT_TOKENS);
		expect(sessionOutputCap(Number.NaN)).toBe(MAX_CALL_OUTPUT_TOKENS);
	});

	test("dispatches the session with that cap as its output limit", async () => {
		const root = await tempDir();
		const { sdk, state } = fakeSdk({
			agentDir: path.join(root, "agent"),
			contextWindow: 1_000_000,
			maxTokens: 20_000,
		});
		const response = await resolveConflicts(resolveRequest({ sessionDir: path.join(root, "sessions") }), {
			sdk,
			stateRoot: path.join(root, "state"),
		});
		expectResolveSuccess(response);
		const captured = state.captured as { model?: { maxTokens?: number } };
		expect(captured.model?.maxTokens).toBe(20_000);
	});
});

describe("side-copy reporting", () => {
	const copyAnswer = (content: string): string =>
		JSON.stringify({ resolutions: [{ path: CONFLICT.path, region: 0, content }] });

	test("names the region whose answer reproduced one side", async () => {
		const theirs = await resolveConflicts(resolveRequest(), { runner: runnerReturning(copyAnswer("theirs\n")) });
		expectResolveSuccess(theirs);
		expect(theirs.proof.sideCopies).toEqual([{ path: CONFLICT.path, region: 0, side: "theirs" }]);

		const ours = await resolveConflicts(resolveRequest(), { runner: runnerReturning(copyAnswer("ours\n")) });
		expectResolveSuccess(ours);
		expect(ours.proof.sideCopies).toEqual([{ path: CONFLICT.path, region: 0, side: "ours" }]);
	});

	test("treats a line-ending variant as the same copy", async () => {
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerReturning(copyAnswer("theirs\r\n\r\n")),
		});
		expectResolveSuccess(response);
		expect(response.proof.sideCopies).toEqual([{ path: CONFLICT.path, region: 0, side: "theirs" }]);
	});

	test("reports nothing for a merged answer", async () => {
		const response = await resolveConflicts(resolveRequest(), {
			runner: runnerReturning(copyAnswer("ours\ntheirs\n")),
		});
		expectResolveSuccess(response);
		expect(response.proof.sideCopies).toEqual([]);
	});
});

describe("retry prompt", () => {
	test("names the rejected path and region in the request the model sees", async () => {
		let prompt = "";
		const response = await resolveConflicts(
			resolveRequest({
				refusals: [
					{
						path: CONFLICT.path,
						side: "theirs",
						regions: [0],
						reason:
							"resolved content matches the upstream side; copying a side is not a merge, refusing (SIDE_COPY)",
					},
				],
			}),
			{
				runner: async request => {
					prompt = request.prompt;
					return { text: ANSWER, proof: proofFor(request) };
				},
			},
		);
		expectResolveSuccess(response);
		expect(prompt).toContain("<refused-attempt>");
		expect(prompt).toContain(`"${CONFLICT.path}", region(s) 0`);
		expect(prompt).toContain("byte-for-byte copy of the theirs slice");
		expect(prompt).toContain("refusing (SIDE_COPY)");
		expect(prompt).toContain("keeps both sides' changes");
	});

	test("says nothing when the turn is not a retry", async () => {
		let prompt = "";
		await resolveConflicts(resolveRequest(), {
			runner: async request => {
				prompt = request.prompt;
				return { text: ANSWER, proof: proofFor(request) };
			},
		});
		expect(prompt).not.toContain("<refused-attempt>");
		expect(prompt).not.toContain("<review-feedback>");
	});

	test("renders the review findings and rejected answers as their own block", async () => {
		let prompt = "";
		let systemPrompt = "";
		const response = await resolveConflicts(
			resolveRequest({
				jobKey: "sync-v18.18.6-c1-rev1-1",
				reviewFeedback: [
					{
						path: CONFLICT.path,
						regions: [0],
						findings: ["region 0 uses `model` before its declaration in region 1"],
						priorAnswers: [{ region: 0, content: "ours\n" }],
					},
				],
			}),
			{
				runner: async request => {
					prompt = request.prompt;
					systemPrompt = request.systemPrompt;
					return { text: ANSWER, proof: proofFor(request) };
				},
			},
		);
		expectResolveSuccess(response);
		expect(prompt).toContain("<review-feedback>");
		expect(prompt).toContain("<review-feedback-data>");
		expect(prompt).toContain("uses `model` before its declaration");
		expect(prompt).toContain('"previousAnswers"');
		expect(prompt).toContain("must stay internally consistent");
		expect(prompt).toContain("must stay in scope");
		expect(prompt).toContain("braces and statements must balance");
		expect(prompt).toContain("Do not return a slice verbatim");
		expect(prompt).toContain("Return only the JSON object described by the system prompt.");
		expect(systemPrompt).toContain("Reply with ONLY a JSON object");
	});

	test("keeps the request a region plan: only the path's planned regions are sent", async () => {
		const multiRegion: ConflictInput = {
			...CONFLICT,
			merged:
				"alpha\n<<<<<<< HEAD\nours\n||||||| base\n=======\ntheirs\n>>>>>>> upstream\nmid\n<<<<<<< HEAD\nours2\n||||||| base\n=======\ntheirs2\n>>>>>>> upstream\n",
		};
		let prompt = "";
		const response = await resolveConflicts(
			resolveRequest({
				conflicts: [multiRegion],
				reviewFeedback: [
					{
						path: multiRegion.path,
						regions: [0, 1],
						findings: ["region 1 closes a brace opened in region 0"],
						priorAnswers: [
							{ region: 0, content: "ours\n" },
							{ region: 1, content: "ours2\n" },
						],
					},
				],
			}),
			{
				runner: async request => {
					prompt = request.prompt;
					return {
						text: JSON.stringify({
							resolutions: [
								{ path: multiRegion.path, region: 0, content: "ours\ntheirs\n" },
								{ path: multiRegion.path, region: 1, content: "ours2\ntheirs2\n" },
							],
						}),
						proof: proofFor(request),
					};
				},
			},
		);
		expectResolveSuccess(response);
		expect(prompt).toContain('"region": 0');
		expect(prompt).toContain('"region": 1');
		expect(prompt).toContain("region 1 closes a brace opened in region 0");
	});
});
