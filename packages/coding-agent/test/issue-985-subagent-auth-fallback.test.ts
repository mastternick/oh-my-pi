import { afterEach, describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { kNoAuth } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import {
	type ModelLookupRegistry,
	resolveModelOverrideWithAuthFallback,
} from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";

/**
 * Subagent override resolution is explicit-only (#985 reversed).
 *
 * The historical #985 fix rerouted a subagent whose requested model had no
 * working credentials onto the parent session's active model. That is another
 * model's selection, so it is gone: resolution walks only the caller's own
 * ordered selector list and otherwise returns the requested model unchanged, so
 * the dispatch fails visibly instead of silently running something else.
 */

const parentModel: Model<Api> = buildModel({
	id: "deepseek-v4-pro",
	name: "DeepSeek V4 Pro",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const unauthedTaskModel: Model<Api> = buildModel({
	id: "qwen3.6-plus-free",
	name: "Qwen3.6 Plus Free",
	api: "openai-completions",
	provider: "opencode-zen",
	baseUrl: "https://opencode.ai/zen/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

const sharedModel: Model<Api> = buildModel({
	id: "shared-id",
	name: "Shared",
	api: "openai-completions",
	provider: "deepseek",
	baseUrl: "https://api.deepseek.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 8192,
});

interface MockRegistryOptions {
	models: Model<Api>[];
	authedProviders: Set<string>;
}

function createMockRegistry(options: MockRegistryOptions): ModelLookupRegistry & {
	getApiKey(model: Model<Api>): Promise<string | undefined>;
} {
	return {
		getAvailable: () => options.models,
		getApiKey: async (model: Model<Api>) =>
			options.authedProviders.has(model.provider) ? "sk-test-token" : undefined,
	} as unknown as ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> };
}

describe("issue #985: subagent dispatch auth fallback", () => {
	test("selects an authenticated later entry from the caller's own list", async () => {
		const registry = createMockRegistry({
			models: [unauthedTaskModel, sharedModel, parentModel],
			authedProviders: new Set(["deepseek"]),
		});
		const selected = await resolveModelOverrideWithAuthFallback(
			["opencode-zen/qwen3.6-plus-free", "deepseek/shared-id:high"],
			registry,
		);
		expect(selected.model?.id).toBe("shared-id");
		expect(selected.thinkingLevel?.toString()).toBe("high");
	});

	test("never substitutes the parent session model for an unauthenticated request", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek"]), // user has DeepSeek; opencode-zen unauthed
		});

		const result = await resolveModelOverrideWithAuthFallback(["qwen3.6-plus-free"], registry);

		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("does not walk the list when the requested model has working auth", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(["deepseek", "opencode-zen"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free", "deepseek/deepseek-v4-pro"],
			registry,
		);

		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("returns the requested model when nothing in the list authenticates", async () => {
		const registry = createMockRegistry({
			models: [parentModel, unauthedTaskModel],
			authedProviders: new Set(), // nothing authed
		});

		const result = await resolveModelOverrideWithAuthFallback(["qwen3.6-plus-free"], registry);

		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});

	test("treats keyless providers (kNoAuth marker) as authenticated", async () => {
		// Keyless-by-design providers (Ollama, llama.cpp, lm-studio) advertise the
		// kNoAuth sentinel from getApiKey to signal that they do not require
		// credentials. The helper treats this as authenticated so an explicitly
		// configured local model is never rerouted.
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>) => {
				if (model.provider === "deepseek") return "sk-test";
				if (model.provider === "opencode-zen") return kNoAuth;
				return undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(["qwen3.6-plus-free"], registry);

		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});
});

describe("issue #5325: sessionId forwarded to getApiKey for session-sticky OAuth", () => {
	// The pre-flight auth check in resolveModelOverrideWithAuthFallback calls
	// getApiKey without a session id. For providers with session-sticky OAuth
	// credentials, this can return undefined even though the credential is
	// usable once the subagent session starts. The fix forwards a sessionId
	// so session-sticky credentials resolve during the pre-flight check.
	test("forwards sessionId to getApiKey for the primary model", async () => {
		let receivedSessionId: string | undefined;
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>, sessionId?: string) => {
				if (model.provider === "opencode-zen") {
					receivedSessionId = sessionId;
					// Without sessionId, OAuth can't resolve; with it, it can.
					return sessionId ? "sk-resolved-token" : undefined;
				}
				if (model.provider === "deepseek") return "sk-test";
				return undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free"],
			registry,
			undefined,
			"subagent-session-123",
		);

		expect(receivedSessionId).toBe("subagent-session-123");
		expect(result.model?.provider).toBe("opencode-zen");
		expect(result.model?.id).toBe("qwen3.6-plus-free");
	});
	test("forwards sessionId to getApiKey for the own-list fallback model", async () => {
		const receivedSessionIds: string[] = [];
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel],
			getApiKey: async (model: Model<Api>, sessionId?: string) => {
				if (sessionId) receivedSessionIds.push(`${model.provider}:${sessionId}`);
				if (model.provider === "opencode-zen") return undefined;
				return sessionId ? "sk-resolved-token" : undefined;
			},
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free", "deepseek/deepseek-v4-pro"],
			registry,
			undefined,
			"subagent-session-456",
		);

		expect(receivedSessionIds).toEqual(["opencode-zen:subagent-session-456", "deepseek:subagent-session-456"]);
		expect(result.model?.provider).toBe("deepseek");
	});
	test("preserves the requested model warning when an own-list entry is selected", async () => {
		const registry: ModelLookupRegistry & { getApiKey(model: Model<Api>): Promise<string | undefined> } = {
			getAvailable: () => [parentModel, unauthedTaskModel, sharedModel],
			getApiKey: async (model: Model<Api>) => (model.provider === "deepseek" ? "sk-test" : undefined),
		} as never;

		const result = await resolveModelOverrideWithAuthFallback(
			["qwen3.6-plus-free:invalid", "deepseek/shared-id"],
			registry,
		);

		expect(result.model?.id).toBe("shared-id");
		expect(result.warning).toBe(
			'Invalid thinking level "invalid" in pattern "qwen3.6-plus-free:invalid". Using default instead.',
		);
	});
});

describe("issue #11709: disabled provider subagent model resolution", () => {
	afterEach(() => {
		resetSettingsForTest();
	});

	test("skips an authenticated model from a disabled provider", async () => {
		const settings = await Settings.init({
			inMemory: true,
			overrides: { disabledProviders: ["opencode-zen"] },
		});
		const registry = createMockRegistry({
			models: [unauthedTaskModel, parentModel],
			authedProviders: new Set(["opencode-zen", "deepseek"]),
		});

		const result = await resolveModelOverrideWithAuthFallback(
			["opencode-zen/qwen3.6-plus-free", "deepseek/deepseek-v4-pro"],
			registry,
			settings,
		);

		expect(result.model?.provider).toBe("deepseek");
		expect(result.model?.id).toBe("deepseek-v4-pro");
	});
});
