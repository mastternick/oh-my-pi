import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { installRetryFallbackRole } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { getRestorableSessionModels } from "@oh-my-pi/pi-coding-agent/session/session-context";
import { EXPLICIT_MODEL_CHANGE_ROLE } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const RATE_LIMIT = "rate limit exceeded retry-after-ms=60000";

describe("model routing: explicit-selector child identity", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-explicit-child-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");
		authStorage.keys.setRuntime("openai", "openai-test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
		modelRegistry.clearSuppressedSelectors();
	});

	function fixtures() {
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models to exist");
		return {
			primary,
			fallback,
			primarySelector: `${primary.provider}/${primary.id}`,
			fallbackSelector: `${fallback.provider}/${fallback.id}`,
		};
	}

	/**
	 * Builds the state the task executor leaves behind: the child session's
	 * initial model change carries the spawn identity, not a role-less default
	 * entry, and the stream throttles on the primary so only a fallback chain
	 * could move it.
	 */
	async function runChild(options: {
		identity: string | undefined;
		chains?: Record<string, string[]>;
		roles?: Record<string, string>;
		configure?: (settings: Settings) => void;
	}): Promise<{
		requestedModels: string[];
		fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>>;
		finalProvider: string | undefined;
		finalModel: string | undefined;
		stopReason: string | undefined;
	}> {
		const { primary, primarySelector } = fixtures();
		const requestedModels: string[] = [];
		const mock = createMockModel();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: { model: primary, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (model, context, streamOptions) => {
				requestedModels.push(`${model.provider}/${model.id}`);
				mock.push({ throw: RATE_LIMIT });
				return mock.stream(model, context, streamOptions);
			},
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.maxDelayMs": 1,
			"retry.maxRetries": 1,
			"retry.fallbackChains": options.chains ?? {},
			...(options.roles ? { modelRoles: options.roles } : {}),
		});
		options.configure?.(settings);
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendModelChange(primarySelector, options.identity);
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		const fallbackEvents: Array<Extract<AgentSessionEvent, { type: "retry_fallback_applied" }>> = [];
		session.subscribe(event => {
			if (event.type === "retry_fallback_applied") fallbackEvents.push(event);
		});

		await session.prompt("Throttle the primary");
		await session.waitForIdle();
		const last = session.messages.at(-1);
		return {
			requestedModels,
			fallbackEvents,
			finalProvider: session.model?.provider,
			finalModel: session.model?.id,
			stopReason: last?.role === "assistant" ? last.stopReason : undefined,
		};
	}

	it("fails closed instead of borrowing the default chain for an explicit selector", async () => {
		const { primarySelector, fallbackSelector } = fixtures();
		const result = await runChild({
			identity: EXPLICIT_MODEL_CHANGE_ROLE,
			roles: { default: primarySelector },
			chains: { default: [fallbackSelector] },
		});

		expect([...new Set(result.requestedModels)]).toEqual([primarySelector]);
		expect(result.fallbackEvents).toEqual([]);
		expect(result.finalProvider).toBe("anthropic");
		expect(result.stopReason).toBe("error");
	});

	it("still applies a provider wildcard chain that names the explicit selector", async () => {
		const { primarySelector, fallbackSelector } = fixtures();
		const result = await runChild({
			identity: EXPLICIT_MODEL_CHANGE_ROLE,
			chains: { "anthropic/*": [fallbackSelector] },
		});

		expect(result.requestedModels).toEqual([primarySelector, fallbackSelector]);
		expect(result.fallbackEvents).toEqual([
			{
				type: "retry_fallback_applied",
				from: primarySelector,
				to: fallbackSelector,
				role: "anthropic/*",
				reason: expect.stringContaining("rate limit exceeded"),
			},
		]);
		expect(result.finalProvider).toBe("openai");
	});

	it("keeps the default role's own chain for the default identity", async () => {
		const { primarySelector, fallbackSelector } = fixtures();
		const result = await runChild({
			identity: "default",
			roles: { default: primarySelector },
			chains: { default: [fallbackSelector] },
		});

		expect(result.requestedModels).toEqual([primarySelector, fallbackSelector]);
		expect(result.fallbackEvents.map(event => event.role)).toEqual(["default"]);
		expect(result.finalProvider).toBe("openai");
	});

	it("uses a pinned subagent role chain", async () => {
		const { primarySelector, fallbackSelector } = fixtures();
		const result = await runChild({
			identity: "subagent:smoke",
			configure: settings => {
				installRetryFallbackRole(settings, "subagent:smoke", {
					primary: primarySelector,
					chain: [fallbackSelector],
				});
			},
		});

		expect(result.requestedModels).toEqual([primarySelector, fallbackSelector]);
		expect(result.fallbackEvents.map(event => event.role)).toEqual(["subagent:smoke"]);
		expect(result.finalProvider).toBe("openai");
	});

	it("never lends the default chain to a role sharing the same model", async () => {
		const { primarySelector, fallbackSelector } = fixtures();
		const result = await runChild({
			identity: "vision",
			roles: { default: primarySelector, vision: primarySelector },
			chains: { default: [fallbackSelector] },
		});

		expect([...new Set(result.requestedModels)]).toEqual([primarySelector]);
		expect(result.fallbackEvents).toEqual([]);
		expect(result.stopReason).toBe("error");
	});

	it("restores an explicit identity's own model, never another role's", () => {
		expect(
			getRestorableSessionModels(
				{ default: "openai/gpt-4o-mini", [EXPLICIT_MODEL_CHANGE_ROLE]: "anthropic/claude-sonnet-4-5" },
				EXPLICIT_MODEL_CHANGE_ROLE,
			),
		).toEqual(["anthropic/claude-sonnet-4-5"]);
		expect(getRestorableSessionModels({ default: "openai/gpt-4o-mini" }, EXPLICIT_MODEL_CHANGE_ROLE)).toEqual([]);
	});
});
