import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getRoleAgentUsage, getRoleInfo } from "@oh-my-pi/pi-coding-agent/config/model-roles";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";

function makeModel(id: string, metadata: Partial<Pick<Model, "api" | "kind" | "webSearch">> = {}): Model {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider: "fixture",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
		...metadata,
	});
}

const chat = makeModel("chat");
const explicitChat = makeModel("explicit-chat", { kind: "chat" });
const groundedChat = makeModel("grounded-chat", { webSearch: "gemini" });
const tiny = makeModel("tiny", { kind: "tiny" });
const image = makeModel("image", { kind: "image" });
const search = makeModel("search", { kind: "search" });
const speech = makeModel("speech", { kind: "tts" });
const localDictation = makeModel("local-dictation", { api: "local-inference", kind: "stt" });
const cloudDictation = makeModel("cloud-dictation", { api: "openai-transcriptions", kind: "stt" });
const judge = makeModel("judge", { kind: "judge" });
const fixtures = [chat, explicitChat, groundedChat, tiny, image, search, speech, localDictation, cloudDictation, judge];

function acceptedIds(role: string, settings: Settings): string[] {
	return fixtures.filter(getRoleInfo(role, settings).accepts).map(model => model.id);
}

describe("getRoleInfo", () => {
	test("built-in roles accept models by capability", () => {
		const settings = Settings.isolated({});

		expect(acceptedIds("default", settings)).toEqual(["chat", "explicit-chat", "grounded-chat"]);
		expect(acceptedIds("tiny", settings)).toEqual(["chat", "explicit-chat", "grounded-chat", "tiny"]);
		expect(acceptedIds("memory", settings)).toEqual(["chat", "explicit-chat", "grounded-chat", "tiny"]);
		expect(acceptedIds("image", settings)).toEqual(["image"]);
		expect(acceptedIds("web", settings)).toEqual(["grounded-chat", "search"]);
		expect(acceptedIds("speech", settings)).toEqual(["speech"]);
		expect(acceptedIds("dictation", settings)).toEqual(["local-dictation", "cloud-dictation"]);
		expect(acceptedIds("judge", settings)).toEqual(["chat", "explicit-chat", "grounded-chat", "tiny", "judge"]);
	});

	test("custom metadata overrides presentation without widening model acceptance", () => {
		const settings = Settings.isolated({
			modelTags: {
				smol: { name: "My Smol", color: "success", hidden: true },
				custom: { name: "My Custom Tag", color: "error", hidden: true },
			},
		});

		const smol = getRoleInfo("smol", settings);
		expect(smol).toMatchObject({ name: "My Smol", color: "success", hidden: true, section: "chat" });
		expect(fixtures.filter(smol.accepts)).toEqual([chat, explicitChat, groundedChat]);

		const custom = getRoleInfo("custom", settings);
		expect(custom).toMatchObject({ name: "My Custom Tag", color: "error", hidden: true, section: "chat" });
		expect(fixtures.filter(custom.accepts)).toEqual([chat, explicitChat, groundedChat]);
	});

	test("kind roles remain in the kind section when their presentation is overridden", () => {
		const settings = Settings.isolated({
			modelTags: {
				image: { name: "Pictures", color: "warning" },
			},
		});

		const info = getRoleInfo("image", settings);
		expect(info).toMatchObject({ name: "Pictures", color: "warning", section: "kind" });
		expect(fixtures.filter(info.accepts)).toEqual([image]);
	});
});

describe("role descriptions and agent usage", () => {
	test("modelTags description overrides the built-in description", () => {
		const settings = Settings.isolated({ modelTags: { smol: { description: "Our smol model." } } });
		expect(getRoleInfo("smol", settings).description).toBe("Our smol model.");
	});

	test("a modelTags entry with only name keeps the built-in description", () => {
		const info = getRoleInfo("smol", Settings.isolated({ modelTags: { smol: { name: "My Smol" } } }));
		expect(info.name).toBe("My Smol");
		expect(info.description).toContain("A fast, low-cost model for lightweight work.");
	});

	test("getRoleAgentUsage reports primary and fallback positions", () => {
		const agents = [
			{ name: "scout", description: "Fast scout", systemPrompt: "", model: ["@smol", "@plan"] },
			{ name: "planner", description: "Planner", systemPrompt: "", model: ["@plan", "@smol"] },
			{ name: "reviewer", description: "Reviewer", systemPrompt: "", model: ["@plan"] },
		] as AgentDefinition[];
		expect(getRoleAgentUsage("smol", agents)).toEqual([
			{ agent: "scout", description: "Fast scout", position: "primary" },
			{ agent: "planner", description: "Planner", position: "fallback 1" },
		]);
	});

	test("getRoleAgentUsage counts thinking-suffixed, pi/ and * references and ignores other roles", () => {
		const agents = [
			{ name: "suffixed", description: "", systemPrompt: "", model: ["@task:high"] },
			{ name: "legacy", description: "", systemPrompt: "", model: ["pi/task"] },
			{ name: "fallback", description: "", systemPrompt: "", model: ["@plan", "pi/task:low"] },
			{ name: "other", description: "", systemPrompt: "", model: ["@other", "@task-helper"] },
			{ name: "empty", description: "", systemPrompt: "", model: [] },
			{ name: "bare", description: "", systemPrompt: "" },
			{ name: "defaulted", description: "", systemPrompt: "", model: ["*:xhigh"] },
		] as AgentDefinition[];
		expect(getRoleAgentUsage("task", agents)).toEqual([
			{ agent: "suffixed", description: "", position: "primary" },
			{ agent: "legacy", description: "", position: "primary" },
			{ agent: "fallback", description: "", position: "fallback 1" },
		]);
		expect(getRoleAgentUsage("default", agents)).toEqual([
			{ agent: "defaulted", description: "", position: "primary" },
		]);
	});

	test("getRoleAgentUsage returns undefined while agents are unknown and an empty list when none reference the role", () => {
		expect(getRoleAgentUsage("smol", undefined)).toBeUndefined();
		expect(getRoleAgentUsage("smol", [])).toEqual([]);
	});
});
