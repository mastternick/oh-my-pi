// Regression: newSession must not split the live model from the project pin when a session_before_switch
// hook changes the project default mid-transition. Uses the real createAgentSession factory and a real
// ModelRegistry; no prompts, no model calls, no production writes (scratch AGENT and project only).
import { afterAll, beforeAll, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";

// Dynamic: SOURCE_ROOT selects the source snapshot under test, so specifiers are runtime-chosen.
const SRC = process.env.SOURCE_ROOT;
if (!SRC) throw new Error("SOURCE_ROOT must point at a src/ snapshot");
const { createAgentSession, discoverAuthStorage } = await import(`${SRC}/sdk.ts`);
const { ModelRegistry } = await import(`${SRC}/config/model-registry.ts`);
const { Settings } = await import(`${SRC}/config/settings.ts`);
const { cfgRetryFallbackChains } = await import(`${SRC}/session/settings.ts`);
const { SessionManager } = await import(`${SRC}/session/session-manager.ts`);

interface SessionPresetPin {
	modelRoles?: Record<string, string>;
	defaultThinkingLevel?: string;
	fallbackChains?: Record<string, string[]>;
}

const SCRATCH = path.join(process.env.TMPDIR ?? "/tmp", `.scratch-sdk-race-${process.pid}`);
const AGENT = path.join(SCRATCH, "agent");
const P = path.join(SCRATCH, "project-p");
const SESSIONS = path.join(SCRATCH, "sessions");
const FAKE_KEY = "fixtest-key";

const savedKey = process.env.ANTHROPIC_API_KEY;
let sessionManager: InstanceType<typeof SessionManager>;
let registry: InstanceType<typeof ModelRegistry>;
let authStorage: Awaited<ReturnType<typeof discoverAuthStorage>>;
let modelA: Model;
let modelB: Model;
let rootSettings: InstanceType<typeof Settings>;

const ref = (m: Model) => `${m.provider}/${m.id}`;

beforeAll(async () => {
	fs.rmSync(SCRATCH, { recursive: true, force: true });
	for (const d of [AGENT, P, SESSIONS]) fs.mkdirSync(d, { recursive: true });
	process.env.ANTHROPIC_API_KEY = FAKE_KEY;

	authStorage = await discoverAuthStorage(AGENT);
	registry = new ModelRegistry(authStorage);
	await registry.refresh("offline");
	const reasoning = registry.getAvailable().filter((m: Model) => m.provider === "anthropic" && m.reasoning === true);
	const distinct = [...new Map(reasoning.map((m: Model) => [m.id, m])).values()] as Model[];
	if (distinct.length < 2) throw new Error(`need 2 authed anthropic reasoning models, found ${distinct.length}`);
	modelA = distinct[0]!;
	modelB = distinct[1]!;

	rootSettings = await Settings.loadIsolated({ cwd: P, agentDir: AGENT });
	await rootSettings.persistSessionPresetDefault("A", pinOf(modelA, "low"));
	await rootSettings.flush();
});

afterAll(async () => {
	await sessionManager?.close();
	if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = savedKey;
	fs.rmSync(SCRATCH, { recursive: true, force: true });
});

function pinOf(m: Model, thinking: string): SessionPresetPin {
	return { modelRoles: { default: ref(m) }, defaultThinkingLevel: thinking, fallbackChains: { base: [ref(m)] } };
}

test("newSession keeps live model, roles, and chains coherent when a hook changes the project default", async () => {
	const pinB = pinOf(modelB, "high");
	// Inline hook writes the new project default during the transition (the race window).
	let hookCalled = 0;
	const hookFactory = (pi: { on: (event: string, fn: (ev: { reason: string }) => Promise<void>) => void }) => {
		pi.on("session_before_switch", async ev => {
			if (ev.reason !== "new") return;
			hookCalled++;
			await rootSettings.persistSessionPresetDefault("B", pinB);
		});
	};

	sessionManager = SessionManager.create(P, SESSIONS);
	const { session } = await createAgentSession({
		cwd: P,
		agentDir: AGENT,
		authStorage,
		modelRegistry: registry,
		settings: rootSettings,
		sessionManager,
		model: modelA,
		thinkingLevel: "low",
		extensions: [hookFactory],
		disableExtensionDiscovery: true,
		enableMCP: false,
		toolNames: [],
		customTools: [],
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		hasUI: false,
		bindProcessState: false,
	});

	expect(session.model?.id).toBe(modelA.id);
	expect(session.thinkingLevel).toBe("low");

	expect(await session.newSession()).toBe(true);
	// The hook must have run inside the transition, or the coherence checks below prove nothing.
	expect(hookCalled).toBe(1);

	// The hook's B is the durable project default, persisted before any live-state check.
	const freshRoot = await Settings.loadIsolated({ cwd: P, agentDir: AGENT });
	expect(freshRoot.sessionView().projectSessionPin()).toEqual(pinB);

	// Live state is the preflight A; the consumer roles and chains must match that same A, not the hook's B.
	expect(session.model?.id).toBe(modelA.id);
	expect(session.thinkingLevel).toBe("low");
	expect(session.settings.getModelRoles()).toEqual({ default: ref(modelA) });
	expect(session.settings.getModelRole("default")).toBe(ref(modelA));
	expect(cfgRetryFallbackChains.get(session.settings)).toEqual({ base: [ref(modelA)] });

	// The next newSession inherits the project default B.
	expect(await session.newSession()).toBe(true);
	expect(hookCalled).toBe(2);
	expect(session.model?.id).toBe(modelB.id);
	expect(session.thinkingLevel).toBe("high");
	expect(session.settings.getModelRoles()).toEqual({ default: ref(modelB) });
	expect(cfgRetryFallbackChains.get(session.settings)).toEqual({ base: [ref(modelB)] });
});
