import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TTS_LOCAL_MODELS } from "@oh-my-pi/pi-coding-agent/tts/models";
import { ttsClient } from "@oh-my-pi/pi-coding-agent/tts/tts-client";
import { Vocalizer } from "@oh-my-pi/pi-coding-agent/tts/vocalizer";

/**
 * Live speech synthesis must use the session's configured `speech` role: the
 * vocalizer resolves it from the live settings + registry on every utterance,
 * so a preset/role change applies without re-wiring. These tests mock the TTS
 * client and the audio player, so no provider or native audio call runs.
 */

function requireModel(provider: "local" | "xai", id: string): Model {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Missing bundled test model: ${provider}/${id}`);
	return model;
}

const localSpeech = requireModel("local", "kokoro");
const cloudSpeech = requireModel("xai", "grok-tts");

function silentHandle() {
	return { push: () => {}, end: () => {}, chunks: (async function* () {})() };
}

function vocalizerWith(settings: Settings, models: Model[]): Vocalizer {
	const registry = { getAvailable: () => models, getAll: () => models, getError: () => undefined } as never;
	const vocalizer = new Vocalizer(() => ({
		start: () => {},
		write: () => {},
		setGain: () => {},
		end: async () => {},
		stop: () => {},
	}));
	vocalizer.setModelSource({ settings, registry });
	return vocalizer;
}

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("Vocalizer speech-role source", () => {
	it("pauses instead of speaking with the bundled model when the configured role has no local backend", async () => {
		const settings = Settings.isolated({
			modelRoles: { speech: "xai/grok-tts" },
			"speech.enabled": true,
		});
		const synthesize = spyOn(ttsClient, "synthesizeStream").mockReturnValue(silentHandle() as never);
		const reported: string[] = [];
		const vocalizer = vocalizerWith(settings, [localSpeech, cloudSpeech]);
		vocalizer.setUnavailableReporter(message => reported.push(message));

		vocalizer.speak("Hello there, this is a test.");
		await vocalizer.idle();

		expect(synthesize).not.toHaveBeenCalled();
		expect(reported).toHaveLength(1);
		expect(reported[0]).toContain("xai/grok-tts");
		expect(vocalizer.isSpeaking()).toBe(false);
	});

	it("reports the gap once per wiring, not on every utterance", async () => {
		const settings = Settings.isolated({
			modelRoles: { speech: "xai/grok-tts" },
			"speech.enabled": true,
		});
		spyOn(ttsClient, "synthesizeStream").mockReturnValue(silentHandle() as never);
		const reported: string[] = [];
		const vocalizer = vocalizerWith(settings, [localSpeech, cloudSpeech]);
		vocalizer.setUnavailableReporter(message => reported.push(message));

		vocalizer.speak("First utterance.");
		vocalizer.speak("Second utterance.");
		await vocalizer.idle();

		expect(reported).toHaveLength(1);
	});

	it("picks up a speech-role change on the next utterance without re-wiring", async () => {
		const settings = Settings.isolated({
			modelRoles: { speech: "xai/grok-tts" },
			"speech.enabled": true,
		});
		const synthesize = spyOn(ttsClient, "synthesizeStream").mockReturnValue(silentHandle() as never);
		const vocalizer = vocalizerWith(settings, [localSpeech, cloudSpeech]);

		vocalizer.speak("Hello there, before the change.");
		await vocalizer.idle();
		expect(synthesize).not.toHaveBeenCalled();

		settings.setModelRole("speech", "local/kokoro");
		vocalizer.speak("Hello there, after the change.");
		await vocalizer.idle();

		expect(synthesize).toHaveBeenCalledTimes(1);
		expect(synthesize.mock.calls[0]?.[0]).toBe("kokoro");
	});

	it("keeps the bundled local model for an unconfigured speech role", async () => {
		const settings = Settings.isolated({ "speech.enabled": true });
		const synthesize = spyOn(ttsClient, "synthesizeStream").mockReturnValue(silentHandle() as never);
		const vocalizer = vocalizerWith(settings, [cloudSpeech]);

		vocalizer.speak("Hello there, unconfigured role.");
		await vocalizer.idle();

		expect(synthesize).toHaveBeenCalledTimes(1);
		expect(synthesize.mock.calls[0]?.[0]).toBe(TTS_LOCAL_MODELS[0].key);
	});
});
