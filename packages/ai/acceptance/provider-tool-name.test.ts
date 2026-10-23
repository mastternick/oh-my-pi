import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog";
import { streamOpenAICompletions } from "../src/providers/openai-completions";
import type { AssistantMessage, Context, ToolCall } from "../src/types";

type ToolDelta = {
	index?: number;
	id?: string;
	type?: "function";
	function?: { name?: string; arguments?: string };
};

type ChatChunk = {
	id: string;
	object: "chat.completion.chunk";
	created: number;
	model: string;
	choices: { index: number; delta: { tool_calls?: ToolDelta[] }; finish_reason: string | null }[];
};

const chunkBase = { id: "chatcmpl-test", object: "chat.completion.chunk" as const, created: 0, model: "test-model" };

function sseBody(deltas: ToolDelta[][]): string {
	const chunks: ChatChunk[] = deltas.map(toolCalls => ({
		...chunkBase,
		choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }],
	}));
	chunks.push({ ...chunkBase, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
	return `${chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
}

async function runStream(deltas: ToolDelta[][]): Promise<ToolCall[]> {
	const server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(sseBody(deltas), { headers: { "content-type": "text/event-stream" } }),
	});
	try {
		const base = getBundledModel("openai", "gpt-4o-mini");
		const model = {
			...base,
			api: "openai-completions" as const,
			baseUrl: `http://127.0.0.1:${server.port}/v1`,
		};
		const context: Context = {
			messages: [{ role: "user", content: "run tools", timestamp: 0 }],
		};
		const result: AssistantMessage = await streamOpenAICompletions(model, context, { apiKey: "test" }).result();
		return result.content.filter((b): b is ToolCall => b.type === "toolCall");
	} finally {
		server.stop(true);
	}
}

describe("openai-completions streamed function.name accumulation", () => {
	it("reconstructs a name split across fragments (ta + sk => task)", async () => {
		const calls = await runStream([
			[{ index: 0, id: "call_1", type: "function", function: { name: "ta", arguments: "" } }],
			[{ index: 0, function: { name: "sk" } }],
			[{ index: 0, function: { arguments: '{"prompt":' } }],
			[{ index: 0, function: { arguments: '"hi"}' } }],
		]);
		expect(calls.map(c => ({ id: c.id, name: c.name, arguments: c.arguments }))).toEqual([
			{ id: "call_1", name: "task", arguments: { prompt: "hi" } },
		]);
	});

	it("keeps a standard single-chunk name intact", async () => {
		const calls = await runStream([
			[{ index: 0, id: "call_2", type: "function", function: { name: "read", arguments: '{"path":"a.ts"}' } }],
		]);
		expect(calls.map(c => ({ name: c.name, arguments: c.arguments }))).toEqual([
			{ name: "read", arguments: { path: "a.ts" } },
		]);
	});

	it("reconstructs two interleaved fragmented calls independently", async () => {
		const calls = await runStream([
			[{ index: 0, id: "call_a", type: "function", function: { name: "ta", arguments: "" } }],
			[{ index: 1, id: "call_b", type: "function", function: { name: "re", arguments: "" } }],
			[{ index: 0, function: { name: "sk", arguments: '{"x":1}' } }],
			[{ index: 1, function: { name: "ad", arguments: '{"path":"b"}' } }],
		]);
		expect(calls.map(c => ({ id: c.id, name: c.name, arguments: c.arguments }))).toEqual([
			{ id: "call_a", name: "task", arguments: { x: 1 } },
			{ id: "call_b", name: "read", arguments: { path: "b" } },
		]);
	});

	it("appends repeated and same-prefix fragments verbatim", async () => {
		const calls = await runStream([
			[{ index: 0, id: "call_c", type: "function", function: { name: "ta", arguments: "" } }],
			[{ index: 0, function: { name: "ta" } }],
			[{ index: 1, id: "call_d", type: "function", function: { name: "a", arguments: "{}" } }],
			[{ index: 1, function: { name: "ab" } }],
		]);
		expect(calls.map(c => ({ id: c.id, name: c.name }))).toEqual([
			{ id: "call_c", name: "tata" },
			{ id: "call_d", name: "aab" },
		]);
	});
});
