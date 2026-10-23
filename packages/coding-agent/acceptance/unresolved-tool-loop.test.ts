/**
 * Bound on consecutive unresolved tool turns (tool name lookup miss) in the native agent loop.
 *
 * Contract: three consecutive completed tool turns in which every runnable call failed registry lookup end the
 * run with one aborted diagnostic and no further provider call. Any turn with a resolvable call, any no-tool turn,
 * and any new prompt resets the streak. Threshold, exemptTools, and identical-call state play no part.
 */
import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoop } from "@oh-my-pi/pi-agent-core/agent-loop";
import type {
	AgentContext,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
} from "@oh-my-pi/pi-agent-core/types";
import type { AssistantMessage, Message, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ToolCallLoopGuard } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";

type Calls = Record<string, number>;

function tool(name: string, calls: Calls, extra: Partial<AgentTool> = {}): AgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: type({ text: "string" }),
		async execute() {
			calls[name] = (calls[name] ?? 0) + 1;
			return { content: [{ type: "text", text: "ok" }], details: {} };
		},
		...extra,
	};
}

const call = (name: string, args: Record<string, unknown> = { text: "x" }) => ({
	content: [{ type: "toolCall" as const, name, arguments: args }],
});
const say = (text: string) => ({ content: [text] });

function run(mock: MockModel, tools: AgentTool[], extra: Partial<AgentLoopConfig> = {}) {
	const context: AgentContext = { systemPrompt: [], messages: [], tools };
	const config: AgentLoopConfig = {
		model: mock,
		convertToLlm: messages => messages as Message[],
		...extra,
	};
	const prompt = { role: "user", content: "go", timestamp: Date.now() } as AgentMessage;
	return agentLoop([prompt], context, config, undefined, mock.stream).result();
}

const toolResults = (msgs: readonly AgentMessage[]) =>
	msgs.filter(m => m.role === "toolResult") as ToolResultMessage[];
const last = (msgs: readonly AgentMessage[]) => msgs[msgs.length - 1] as AssistantMessage;

describe("unresolved tool turns in the agent loop", () => {
	it("one miss gets a registry-scoped error the model can correct", async () => {
		const calls: Calls = {};
		const mock = createMockModel({ responses: [call("nope"), say("done")] });
		const msgs = await run(mock, [tool("echo", calls)]);

		expect(mock.calls.length).toBe(2);
		const result = toolResults(msgs)[0]!;
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("Tools in this run: echo");
		expect(last(msgs).stopReason).toBe("stop");
		expect(calls).toEqual({});
	});

	it("three consecutive unresolved turns end the run with no fourth provider call", async () => {
		const calls: Calls = {};
		const mock = createMockModel({ responses: [call("nope"), call("nope"), call("nope"), say("never")] });
		const msgs = await run(mock, [tool("echo", calls)]);

		expect(mock.calls.length).toBe(3);
		const results = toolResults(msgs);
		expect(results.length).toBe(3);
		expect(results.every(r => r.isError)).toBe(true);
		expect(last(msgs).stopReason).toBe("aborted");
		expect(last(msgs).content.length).toBeGreaterThan(0);
		expect(calls).toEqual({});
	});

	it("varied names and arguments still count as unresolved", async () => {
		const mock = createMockModel({ responses: [call("a", { x: 1 }), call("b", { y: 2 }), call("c", { z: 3 })] });
		const msgs = await run(mock, [tool("echo", {})]);

		expect(mock.calls.length).toBe(3);
		expect(last(msgs).stopReason).toBe("aborted");
	});

	it("a disabled task tool is never executed and counts as unresolved", async () => {
		const calls: Calls = {};
		const mock = createMockModel({ responses: [call("task"), call("task"), call("task"), say("never")] });
		const msgs = await run(mock, [tool("echo", calls)]);

		expect(mock.calls.length).toBe(3);
		expect(last(msgs).stopReason).toBe("aborted");
		expect(calls).toEqual({});
	});

	it("a turn with a resolvable call resets the streak", async () => {
		const calls: Calls = {};
		const mock = createMockModel({
			responses: [call("nope"), call("nope"), call("echo"), call("nope"), call("nope"), say("done")],
		});
		const msgs = await run(mock, [tool("echo", calls)]);

		expect(mock.calls.length).toBe(6);
		expect(last(msgs).stopReason).toBe("stop");
		expect(calls.echo).toBe(1);
	});

	it("a resolvable call that errors also resets the streak", async () => {
		const calls: Calls = {};
		const boom = {
			...tool("boom", calls),
			async execute() {
				calls.boom = (calls.boom ?? 0) + 1;
				throw new Error("boom");
			},
		};
		const mock = createMockModel({
			responses: [call("nope"), call("nope"), call("boom"), call("nope"), call("nope"), say("done")],
		});
		const msgs = await run(mock, [boom]);

		expect(mock.calls.length).toBe(6);
		expect(last(msgs).stopReason).toBe("stop");
		expect(calls.boom).toBe(1);
		expect(toolResults(msgs).some(r => r.toolName === "boom" && r.isError)).toBe(true);
	});

	it("a mixed batch with one resolvable call resets the streak", async () => {
		const calls: Calls = {};
		const mixed = {
			content: [
				{ type: "toolCall" as const, name: "nope", arguments: { text: "x" } },
				{ type: "toolCall" as const, name: "echo", arguments: { text: "x" } },
			],
		};
		const mock = createMockModel({
			responses: [call("nope"), call("nope"), mixed, call("nope"), call("nope"), say("done")],
		});
		const msgs = await run(mock, [tool("echo", calls)]);

		expect(mock.calls.length).toBe(6);
		expect(last(msgs).stopReason).toBe("stop");
		expect(calls.echo).toBe(1);
	});

	it("customWireName resolves and never counts as unresolved", async () => {
		const calls: Calls = {};
		const mock = createMockModel({
			responses: [call("wire_echo"), call("wire_echo"), call("wire_echo"), say("done")],
		});
		const msgs = await run(mock, [tool("echo", calls, { customWireName: "wire_echo" })]);

		expect(mock.calls.length).toBe(4);
		expect(last(msgs).stopReason).toBe("stop");
		expect(calls.echo).toBe(3);
	});

	it("resolveFallbackTool results resolve and never count as unresolved", async () => {
		const calls: Calls = {};
		const mock = createMockModel({ responses: [call("ghost"), call("ghost"), call("ghost"), say("done")] });
		const msgs = await run(mock, [tool("echo", {})], {
			resolveFallbackTool: name => (name === "ghost" ? tool("ghost", calls) : undefined),
		});

		expect(mock.calls.length).toBe(4);
		expect(last(msgs).stopReason).toBe("stop");
		expect(calls.ghost).toBe(3);
	});

	it("a new prompt starts a fresh budget", async () => {
		const mock = createMockModel({
			responses: [call("nope"), call("nope"), call("nope"), call("nope"), say("ok")],
		});
		const first = await run(mock, [tool("echo", {})]);
		expect(mock.calls.length).toBe(3);
		expect(last(first).stopReason).toBe("aborted");

		const second = await run(mock, [tool("echo", {})]);
		expect(mock.calls.length).toBe(5);
		expect(last(second).stopReason).toBe("stop");
	});
});

const unresolved = (...ids: string[]) => ({
	toolCalls: ids.map(id => ({ id, name: "ghost" })),
	unresolvedToolCallIds: new Set(ids),
});

describe("ToolCallLoopGuard.recordUnresolvedTurn", () => {
	it("triggers on the third consecutive all-unresolved turn, ignoring threshold and exemptions", () => {
		const guard = new ToolCallLoopGuard({ threshold: 1000, exemptTools: ["ghost"] });

		expect(guard.recordUnresolvedTurn(unresolved("a"))).toBeNull();
		expect(guard.recordUnresolvedTurn(unresolved("b"))).toBeNull();
		expect(guard.recordUnresolvedTurn(unresolved("c"))).toEqual({
			kind: "unresolved_tool_loop",
			count: 3,
			toolNames: ["ghost"],
		});
	});

	it("no-tool, partially unresolved, missing-set, and undefined turns reset the streak", () => {
		const guard = new ToolCallLoopGuard({ threshold: 1, exemptTools: [] });
		const noTools = { toolCalls: [], unresolvedToolCallIds: new Set<string>() };
		const partial = {
			toolCalls: [
				{ id: "a", name: "ghost" },
				{ id: "x", name: "echo" },
			],
			unresolvedToolCallIds: new Set(["a"]),
		};
		const noSet = { toolCalls: [{ id: "a", name: "ghost" }], unresolvedToolCallIds: undefined };

		expect(guard.recordUnresolvedTurn(unresolved("a"))).toBeNull();
		expect(guard.recordUnresolvedTurn(unresolved("b"))).toBeNull();
		expect(guard.recordUnresolvedTurn(noTools)).toBeNull();
		expect(guard.recordUnresolvedTurn(unresolved("c"))).toBeNull();
		expect(guard.recordUnresolvedTurn(unresolved("d"))).toBeNull();
		expect(guard.recordUnresolvedTurn(partial)).toBeNull();
		expect(guard.recordUnresolvedTurn(unresolved("e"))).toBeNull();
		expect(guard.recordUnresolvedTurn(unresolved("f"))).toBeNull();
		expect(guard.recordUnresolvedTurn(noSet)).toBeNull();
		expect(guard.recordUnresolvedTurn(undefined)).toBeNull();
		expect(guard.recordUnresolvedTurn(unresolved("g"))).toBeNull();
		expect(guard.recordUnresolvedTurn(unresolved("h"))).toBeNull();
		expect(guard.recordUnresolvedTurn(unresolved("i"))).toMatchObject({
			kind: "unresolved_tool_loop",
			count: 3,
		});
	});
});

describe("ToolCallLoopGuard.recordTurn (identical-call contract unchanged)", () => {
	const turn = (name: string, args: Record<string, unknown>) => ({
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: `${name}-id`, name, arguments: args }],
		} as unknown as AssistantMessage,
		toolResults: [],
	});

	it("reports the third identical non-exempt call and ignores exempt waits", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: ["wait"] });

		expect(guard.recordTurn(turn("read", { path: "a" }))).toBeNull();
		expect(guard.recordTurn(turn("read", { path: "a" }))).toBeNull();
		expect(guard.recordTurn(turn("read", { path: "a" }))).toMatchObject({
			kind: "repeated_tool_call",
			toolName: "read",
			count: 3,
		});
		for (let i = 0; i < 5; i++) expect(guard.recordTurn(turn("wait", {}))).toBeNull();
	});

	it("unresolved turns do not reset the identical-call streak", () => {
		const guard = new ToolCallLoopGuard({ threshold: 3, exemptTools: [] });

		expect(guard.recordTurn(turn("read", { path: "a" }))).toBeNull();
		expect(guard.recordTurn(turn("read", { path: "a" }))).toBeNull();
		expect(guard.recordUnresolvedTurn(unresolved("a"))).toBeNull();
		expect(guard.recordTurn(turn("read", { path: "a" }))).toMatchObject({
			kind: "repeated_tool_call",
			count: 3,
		});
	});
});
