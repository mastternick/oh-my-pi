import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionAgentIdentity,
	ExtensionFactory,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { type CreateAgentSessionOptions, createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import * as sessionAdvisors from "@oh-my-pi/pi-coding-agent/session/session-advisors";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake } from "@oh-my-pi/pi-utils";
import * as logger from "@oh-my-pi/pi-utils/logger";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

// Extensions need to know which agent they run in: the same factory is rebound to every
// subagent, and hooks such as a Claude-style SubagentStart must act only there.
describe("ExtensionContext.agent", () => {
	let tempDir: string;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-ext-agent-identity-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		for (const authStorage of authStorages.splice(0)) authStorage.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	async function createSession(
		extension: ExtensionFactory,
		options: Partial<CreateAgentSessionOptions> = {},
	): Promise<AgentSession> {
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.yml")),
			settings: Settings.isolated(),
			sessionManager: SessionManager.inMemory(),
			disableExtensionDiscovery: true,
			extensions: [extension],
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			rules: [],
			preloadedCustomToolPaths: [],
			toolNames: ["read"],
			...options,
		});
		return session;
	}

	async function agentSeenByExtensions(options: Partial<CreateAgentSessionOptions>): Promise<ExtensionAgentIdentity> {
		let seen: ExtensionAgentIdentity | undefined;
		const session = await createSession(pi => {
			pi.on("before_agent_start", (_event, ctx) => {
				seen = ctx.agent;
			});
		}, options);
		try {
			await session.extensionRunner!.emitBeforeAgentStart("hi", undefined, []);
			return seen!;
		} finally {
			await session.dispose();
		}
	}

	test("a top-level session reports itself as the main agent", async () => {
		expect(await agentSeenByExtensions({})).toEqual({ kind: "main", id: "Main", name: "main", depth: 0 });
	});

	test("a subagent session reports its kind, id, definition name, depth and parent", async () => {
		expect(
			await agentSeenByExtensions({
				taskDepth: 2,
				parentTaskPrefix: "0-Explore",
				agentId: "0-Explore",
				agentDisplayName: "Explore",
				agentName: "Explore",
				parentAgentId: "Main",
			}),
		).toEqual({ kind: "sub", id: "0-Explore", name: "explore", depth: 2, parentId: "Main" });
	});

	test("a spawned session outside the task tool is a subagent at depth 0", async () => {
		// `/tan` clones pass a parent prefix but no task depth or agent definition.
		expect(
			await agentSeenByExtensions({
				parentTaskPrefix: "Main-tan-1",
				agentId: "Main-tan-1",
				agentDisplayName: "tan",
				parentAgentId: "Main",
			}),
		).toEqual({ kind: "sub", id: "Main-tan-1", name: "sub", depth: 0, parentId: "Main" });
	});

	// Advisors share the session's runner for approval enforcement; an extension scoping
	// tool hooks to the main agent (e.g. injecting hints into tool results) must not act
	// on the advisor's own investigation (issue #13598).
	test("an advisor's tool calls report the advisor, not the session's agent", async () => {
		const RealSessionAdvisors = sessionAdvisors.SessionAdvisors;
		let advisorTools: sessionAdvisors.AdvisorToolFactory | undefined;
		const advisorsSpy = spyOn(sessionAdvisors, "SessionAdvisors").mockImplementation(function (
			host: sessionAdvisors.SessionAdvisorsHost,
			options: sessionAdvisors.SessionAdvisorsOptions,
		) {
			advisorTools = options.tools;
			return new RealSessionAdvisors(host, options);
		} as never);
		const seen: Array<{ event: string; toolCallId: string; agent: ExtensionAgentIdentity }> = [];
		fs.writeFileSync(path.join(tempDir, "probe.txt"), "needle\n");
		let session: AgentSession;
		try {
			session = await createSession(pi => {
				pi.on("tool_call", (event, ctx) => {
					seen.push({ event: event.type, toolCallId: event.toolCallId, agent: ctx.agent });
				});
				pi.on("tool_result", (event, ctx) => {
					seen.push({ event: event.type, toolCallId: event.toolCallId, agent: ctx.agent });
				});
			});
		} finally {
			advisorsSpy.mockRestore();
		}
		try {
			const advisorGrep = advisorTools?.create(new Set(["grep"])).tools.find(tool => tool.name === "grep");
			await advisorGrep!.execute("advisor-call", { pattern: "needle", path: tempDir });
			await session.getToolByName("read")!.execute("main-call", { path: path.join(tempDir, "probe.txt") });
		} finally {
			await session.dispose();
		}

		const advisor: ExtensionAgentIdentity = {
			kind: "sub",
			id: "advisor",
			name: "advisor",
			depth: 0,
			parentId: "Main",
		};
		const main: ExtensionAgentIdentity = { kind: "main", id: "Main", name: "main", depth: 0 };
		expect(seen).toEqual([
			{ event: "tool_call", toolCallId: "advisor-call", agent: advisor },
			{ event: "tool_result", toolCallId: "advisor-call", agent: advisor },
			{ event: "tool_call", toolCallId: "main-call", agent: main },
			{ event: "tool_result", toolCallId: "main-call", agent: main },
		]);
	});

	test("an advisor granted a registered extension tool receives it; ungranted and missing grants are skipped", async () => {
		const RealSessionAdvisors = sessionAdvisors.SessionAdvisors;
		let advisorTools: sessionAdvisors.AdvisorToolFactory | undefined;
		const advisorsSpy = spyOn(sessionAdvisors, "SessionAdvisors").mockImplementation(function (
			host: sessionAdvisors.SessionAdvisorsHost,
			options: sessionAdvisors.SessionAdvisorsOptions,
		) {
			advisorTools = options.tools;
			return new RealSessionAdvisors(host, options);
		} as never);
		const seen: Array<{ toolCallId: string; agent: ExtensionAgentIdentity }> = [];
		const executeAgents: ExtensionAgentIdentity[] = [];
		// A plugin tool an advisor may now be granted, like Magic Context's `ctx_memory`.
		const memoryPlugin: ExtensionFactory = pi => {
			pi.registerTool({
				name: "ctx_memory",
				label: "Memory",
				description: "write a memory",
				parameters: pi.arktype({ text: pi.arktype("string") }),
				async execute(_toolCallId: string, params: { text: string }, _signal, _onUpdate, ctx) {
					executeAgents.push(ctx.agent);
					return {
						content: [{ type: "text" as const, text: `stored ${params.text}` }],
						details: {},
					};
				},
			});
			pi.on("tool_call", (event, ctx) => {
				seen.push({ toolCallId: event.toolCallId, agent: ctx.agent });
			});
			// Same name as a built-in that this session cannot build (`enableLsp: false`):
			// the built-in owns the name, so it must not be offered as an extension grant.
			pi.registerTool({
				name: "lsp",
				label: "LSP",
				description: "extension lsp",
				parameters: pi.arktype({}),
				async execute() {
					return { content: [{ type: "text" as const, text: "lsp" }], details: {} };
				},
			});
		};
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		let session: AgentSession;
		try {
			session = await createSession(memoryPlugin, {
				settings: Settings.isolated({ "tools.approvalMode": "yolo" }),
			});
		} finally {
			advisorsSpy.mockRestore();
		}
		try {
			// `/advisor configure` lists what a session can actually grant.
			expect(advisorTools!.names()).toContain("ctx_memory");
			// A built-in's name is not offered as an extension grant even when the
			// built-in itself could not be constructed for this session.
			expect(advisorTools!.names()).not.toContain("lsp");
			expect(advisorTools!.create(new Set(["lsp"]), { advisor: "Session coach" }).tools).toEqual([]);

			const granted = advisorTools!.create(new Set(["read", "ctx_memory"]), { advisor: "Session coach" });
			expect(granted.tools.map(tool => tool.name)).toEqual(["read", "ctx_memory"]);
			const memoryTool = granted.tools.find(tool => tool.name === "ctx_memory")!;
			const result = await memoryTool.execute("advisor-memory", { text: "lesson" });
			expect(result.content).toEqual([{ type: "text", text: "stored lesson" }]);

			const ungranted = advisorTools!.create(new Set(["read"]), { advisor: "Session coach" });
			expect(ungranted.tools.map(tool => tool.name)).not.toContain("ctx_memory");

			// A granted name no extension registered is skipped, warning once per
			// advisor+name even though `create` runs again for each review.
			const missing = advisorTools!.create(new Set(["ctx_note"]), { advisor: "Session coach" });
			expect(missing.tools).toEqual([]);
			advisorTools!.create(new Set(["ctx_note"]), { advisor: "Session coach" });
			const warnedTools = warn.mock.calls.flatMap(([, context]) => {
				const tool = context?.tool;
				return typeof tool === "string" ? [tool] : [];
			});
			expect(warnedTools.filter(tool => tool === "ctx_note")).toHaveLength(1);
		} finally {
			await session.dispose();
			warn.mockRestore();
		}

		// The extension sees the advisor as the caller, not the session's agent —
		// both in the hooks and inside the tool's own execute context.
		const advisorIdentity: ExtensionAgentIdentity = {
			kind: "sub",
			id: "advisor",
			name: "advisor",
			depth: 0,
			parentId: "Main",
		};
		expect(seen).toEqual([{ toolCallId: "advisor-memory", agent: advisorIdentity }]);
		expect(executeAgents).toEqual([advisorIdentity]);
	});

	test("an advisor's extension tool call is gated by tools.approval.<tool>", async () => {
		const RealSessionAdvisors = sessionAdvisors.SessionAdvisors;
		let advisorTools: sessionAdvisors.AdvisorToolFactory | undefined;
		const advisorsSpy = spyOn(sessionAdvisors, "SessionAdvisors").mockImplementation(function (
			host: sessionAdvisors.SessionAdvisorsHost,
			options: sessionAdvisors.SessionAdvisorsOptions,
		) {
			advisorTools = options.tools;
			return new RealSessionAdvisors(host, options);
		} as never);
		let executed = false;
		const memoryPlugin: ExtensionFactory = pi => {
			pi.registerTool({
				name: "ctx_memory",
				label: "Memory",
				description: "write a memory",
				parameters: pi.arktype({ text: pi.arktype("string") }),
				async execute() {
					executed = true;
					return { content: [{ type: "text" as const, text: "stored" }], details: {} };
				},
			});
		};
		let session: AgentSession;
		try {
			session = await createSession(memoryPlugin, {
				settings: Settings.isolated({ "tools.approval": { ctx_memory: "deny" } }),
			});
		} finally {
			advisorsSpy.mockRestore();
		}
		try {
			const slate = advisorTools!.create(new Set(["ctx_memory"]), { advisor: "Session coach" });
			const memoryTool = slate.tools.find(tool => tool.name === "ctx_memory")!;
			// The advisor's copy keeps the extension tool's own approval gate: a user
			// `deny` policy stops the reviewer's call before the plugin runs.
			await expect(memoryTool.execute("advisor-denied", { text: "lesson" })).rejects.toThrow(
				/blocked by user policy/,
			);
			expect(executed).toBe(false);
		} finally {
			await session.dispose();
		}
	});
});
