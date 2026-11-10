import { afterEach, describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveRoleChain } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveImageCandidates } from "@oh-my-pi/pi-coding-agent/tools/image-gen";
import { TTS_LOCAL_MODELS } from "@oh-my-pi/pi-coding-agent/tts/models";
import { resolveLocalSpeechModelId } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";
import { xaiModelChain } from "@oh-my-pi/pi-coding-agent/web/search/providers/xai";

/**
 * Kind roles (`image`, `web`, `speech`, `dictation`, `judge`) own a separate
 * chain, but a configured model must be just as authoritative there: the
 * session's own provider and the built-in catalog are bootstrap defaults for an
 * unconfigured role only.
 */

function fixture(overrides: Record<string, unknown> & Pick<Model<Api>, "provider" | "id">): Model<Api> {
	return buildModel({
		name: overrides.id,
		api: "openai-responses",
		baseUrl: "https://fixture.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
		...overrides,
	} as Parameters<typeof buildModel>[0]) as Model<Api>;
}

function registryWith(models: Model<Api>[]) {
	return { getAvailable: () => models } as never;
}

afterEach(() => {
	resetSettingsForTest();
});

describe("configured image role", () => {
	const configuredImage = fixture({
		provider: "imagehost",
		id: "img-1",
		kind: "image",
		kindConfig: "image",
		api: "openai-responses",
	});
	const sessionModel = fixture({ provider: "session", id: "session-chat", hostedImage: true });

	it("uses only the configured selector, never the session's provider", () => {
		const settings = Settings.isolated({ modelRoles: { image: "imagehost/img-1" } });

		const candidates = resolveImageCandidates(settings, [configuredImage], sessionModel);

		expect(candidates.map(model => `${model.provider}/${model.id}`)).toEqual(["imagehost/img-1"]);
	});

	it("appends the session's provider only while the role is unconfigured", () => {
		const candidates = resolveImageCandidates(Settings.isolated(), [configuredImage], sessionModel);

		expect(candidates.map(model => `${model.provider}/${model.id}`)).toEqual(["session/session-chat"]);
	});
});

describe("configured web role", () => {
	// A web-role candidate is either a search-kind engine or a chat model with grounding.
	const xaiWeb = fixture({ provider: "xai", id: "grok-web", webSearch: "xai" });
	const parallelWeb = fixture({ provider: "web", id: "parallel", kind: "search", kindConfig: "search" });

	it("does not prepend the provider default for a configured role", () => {
		const settings = Settings.isolated({ modelRoles: { web: "web/parallel" } });

		expect(xaiModelChain(registryWith([xaiWeb, parallelWeb]) as never, settings)).toEqual([]);
	});

	it("prepends the provider default for an unconfigured role", () => {
		const chain = xaiModelChain(registryWith([xaiWeb, parallelWeb]) as never, Settings.isolated());

		expect(chain.map(model => `${model.provider}/${model.id}`)).toEqual(["xai/grok-web"]);
	});
});

describe("configured speech role", () => {
	const localSpeech = fixture({
		provider: "local",
		id: "tts-1",
		kind: "tts",
		kindConfig: "tts",
		api: "local-inference",
	});
	const cloudSpeech = fixture({
		provider: "cloud",
		id: "speech-1",
		kind: "tts",
		kindConfig: "tts",
		api: "openai-speech",
	});

	it("resolves a configured local backend", () => {
		const settings = Settings.isolated({ modelRoles: { speech: "local/tts-1" } });

		expect(resolveLocalSpeechModelId({ settings, registry: registryWith([localSpeech, cloudSpeech]) })).toBe("tts-1");
	});

	it("reports no local backend instead of substituting the bundled model", () => {
		const settings = Settings.isolated({ modelRoles: { speech: "cloud/speech-1" } });

		expect(
			resolveLocalSpeechModelId({ settings, registry: registryWith([localSpeech, cloudSpeech]) }),
		).toBeUndefined();
	});

	it("uses the bundled local model for an unconfigured role", () => {
		const chatModel = fixture({ provider: "session", id: "session-chat" });

		expect(resolveLocalSpeechModelId({ settings: Settings.isolated(), registry: registryWith([chatModel]) })).toBe(
			TTS_LOCAL_MODELS[0]!.key,
		);
	});
});

describe("configured kind roles stop at their own chain", () => {
	const judgeCandidate = fixture({
		provider: "typesafe",
		id: "jev-preview",
		kind: "judge",
		kindConfig: "judge",
		api: "typesafe",
	});
	const dictationCandidate = fixture({
		provider: "local",
		id: "stt-1",
		kind: "stt",
		kindConfig: "stt",
		api: "local-inference",
	});
	const fallbackCandidate = fixture({
		provider: "typesafe",
		id: "jev-backup",
		kind: "judge",
		kindConfig: "judge",
		api: "typesafe",
	});

	it("resolves only the configured judge selector and its own chain", () => {
		const primaryOnly = Settings.isolated({ modelRoles: { judge: "typesafe/jev-preview" } });
		expect(
			resolveRoleChain("judge", primaryOnly, [judgeCandidate, fallbackCandidate]).map(
				candidate => candidate.model.id,
			),
		).toEqual(["jev-preview"]);

		const chained = Settings.isolated({
			modelRoles: { judge: "typesafe/jev-preview" },
			"retry.fallbackChains": { judge: ["typesafe/jev-backup"] },
		});
		expect(
			resolveRoleChain("judge", chained, [judgeCandidate, fallbackCandidate]).map(candidate => candidate.model.id),
		).toEqual(["jev-preview", "jev-backup"]);
	});

	it("stops dictation at an unavailable configured model instead of the catalog", () => {
		const settings = Settings.isolated({ modelRoles: { dictation: "local/stt-missing" } });

		expect(resolveRoleChain("dictation", settings, [dictationCandidate])).toEqual([]);
	});
});
