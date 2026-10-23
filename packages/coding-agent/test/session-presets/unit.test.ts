// Behavioral probes for scoped model-preset state. Source under test is SOURCE_ROOT, default this package's src/.
// Each test gets a fresh scratch root via beforeEach; the real ~/.omp/agent/config.yml is never touched.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";

// Dynamic: SOURCE_ROOT overrides which source snapshot is under test; default is this package's src/.
const SRC = process.env.SOURCE_ROOT ?? path.resolve(import.meta.dir, "../../src");
const {
	applyModelPreset,
	applySessionPinDefault,
	attachSessionPreset,
	getModelPresetNames,
	recordSessionPreset,
	resolveSessionDefault,
	saveModelPreset,
} = await import(`${SRC}/config/model-presets.ts`);
const { Settings } = await import(`${SRC}/config/settings.ts`);
const { cfgDefaultThinkingLevel, cfgRetryFallbackChains } = await import(`${SRC}/session/settings.ts`);
const { SessionManager } = await import(`${SRC}/session/session-manager.ts`);

interface SessionPresetPin {
	modelRoles?: Record<string, string>;
	defaultThinkingLevel?: string;
	fallbackChains?: Record<string, string[]>;
}

const SCRATCH = path.join(process.env.TMPDIR ?? "/tmp", `.scratch-unit-${process.pid}`);
const AGENT = path.join(SCRATCH, "agent");
const P = path.join(SCRATCH, "project-p");
const Q = path.join(SCRATCH, "project-q");
const R = path.join(SCRATCH, "project-r");
const SESSIONS = path.join(SCRATCH, "sessions");
const GLOBAL_CONFIG = path.join(AGENT, "config.yml");
const P_CONFIG = path.join(P, ".omp", "config.yml");

// Global fixture: default gamma; presets A (low), B (high), C (medium), O (key-order), L (unauthed), N (no thinking).
const GLOBAL_YAML = `modelRoles:
  default: fakeprov/gamma
retry:
  fallbackChains:
    base: [fakeprov/gamma]
modelPresets:
  A:
    modelRoles:
      default: fakeprov/alpha
      smol: fakeprov/beta
    defaultThinkingLevel: low
    fallbackChains:
      base: [fakeprov/alpha, fakeprov/beta]
      extra: [fakeprov/gamma]
  B:
    modelRoles:
      default: fakeprov/beta
    defaultThinkingLevel: high
    fallbackChains:
      base: [fakeprov/beta]
  C:
    modelRoles:
      default: fakeprov/gamma
    defaultThinkingLevel: medium
    fallbackChains:
      base: [fakeprov/gamma, fakeprov/alpha]
  O:
    modelRoles:
      default: fakeprov/alpha
    fallbackChains:
      second: [fakeprov/beta]
      first: [fakeprov/alpha]
  L:
    modelRoles:
      default: fakeprov/locked
  N:
    modelRoles:
      default: fakeprov/gamma
`;

const model = (id: string): Model =>
	({
		provider: "fakeprov",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	}) as unknown as Model;

const MODELS = { alpha: model("alpha"), beta: model("beta"), gamma: model("gamma"), locked: model("locked") };

interface Stub {
	model: Model;
	settings: InstanceType<typeof Settings>;
	sessionManager: InstanceType<typeof SessionManager>;
	scopedModels: { model: Model }[];
	thinking: string | undefined;
	failSetModel: boolean;
	configuredThinkingLevel(): string | undefined;
	modelRegistry: { hasConfiguredAuth(m: Model): boolean; hasConcreteAuth(p: string): boolean };
	getAvailableModels(): Model[];
	setModel(m: Model): Promise<void>;
	setThinkingLevel(level: string): void;
}

/** Stub only the model registry and live model/thinking mutation; settings and SessionManager are real. */
function makeSession(
	settings: InstanceType<typeof Settings>,
	sessionManager: InstanceType<typeof SessionManager>,
): Stub {
	const stub: Stub = {
		model: MODELS.gamma,
		settings,
		sessionManager,
		scopedModels: [],
		thinking: undefined,
		failSetModel: false,
		configuredThinkingLevel: () => stub.thinking,
		modelRegistry: {
			hasConfiguredAuth: m => m.id !== "locked",
			hasConcreteAuth: () => true,
		},
		getAvailableModels: () => Object.values(MODELS),
		async setModel(m) {
			if (stub.failSetModel) throw new Error("injected setModel failure");
			stub.model = m;
		},
		setThinkingLevel(level) {
			stub.thinking = level;
		},
	};
	return stub;
}

const load = (cwd: string) => Settings.loadIsolated({ cwd, agentDir: AGENT });

function pinOf(s: InstanceType<typeof Settings>): SessionPresetPin {
	const pin = s.sessionPin();
	if (!pin) throw new Error("expected a session view");
	return pin;
}

/** What real consumers read: role getters and the config accessors, not the stored pin. */
function consumerOf(s: InstanceType<typeof Settings>) {
	return {
		roles: { ...s.getModelRoles() },
		defaultRole: s.getModelRole("default"),
		smolRole: s.getModelRole("smol"),
		chains: cfgRetryFallbackChains.get(s),
		thinking: cfgDefaultThinkingLevel.get(s),
	};
}

const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const lastSnapshot = (mgr: InstanceType<typeof SessionManager>) =>
	JSON.stringify(
		mgr
			.getBranch()
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "model-preset-session",
			)
			.at(-1) ?? null,
	);

/** Seeds P's project default to A through the real persistence path. */
async function seedProjectA(): Promise<void> {
	const root = await load(P);
	const sess = makeSession(root.sessionView(), SessionManager.create(P, SESSIONS));
	const result = await applyModelPreset(sess, "A", { scope: "project" });
	expect(result.kind).toBe("switched");
	await root.flush();
}

beforeEach(() => {
	fs.rmSync(SCRATCH, { recursive: true, force: true });
	fs.mkdirSync(AGENT, { recursive: true });
	fs.mkdirSync(P, { recursive: true });
	fs.mkdirSync(Q, { recursive: true });
	fs.mkdirSync(SESSIONS, { recursive: true });
	fs.writeFileSync(GLOBAL_CONFIG, GLOBAL_YAML);
});

afterAll(() => {
	fs.rmSync(SCRATCH, { recursive: true, force: true });
});

test("project switch persists P default only; Q consumer and global config untouched", async () => {
	const globalBefore = digest(GLOBAL_CONFIG);
	const qBefore = consumerOf((await load(Q)).sessionView());

	const root = await load(P);
	const sess = makeSession(root.sessionView(), SessionManager.create(P, SESSIONS));
	const result = await applyModelPreset(sess, "A", { scope: "project" });
	expect(result.kind).toBe("switched");
	expect(sess.model.id).toBe("alpha");
	await root.flush();

	const pFresh = (await load(P)).sessionView();
	expect(pinOf(pFresh).modelRoles).toEqual({ default: "fakeprov/alpha", smol: "fakeprov/beta" });
	expect(consumerOf(pFresh)).toEqual({
		roles: { default: "fakeprov/alpha", smol: "fakeprov/beta" },
		defaultRole: "fakeprov/alpha",
		smolRole: "fakeprov/beta",
		chains: { base: ["fakeprov/alpha", "fakeprov/beta"], extra: ["fakeprov/gamma"] },
		thinking: "low",
	});

	expect(consumerOf((await load(Q)).sessionView())).toEqual(qBefore);
	expect(digest(GLOBAL_CONFIG)).toBe(globalBefore);
});

test("sessions already started before a project switch stay independent; new P session inherits", async () => {
	await seedProjectA();
	const started = makeSession((await load(P)).sessionView(), SessionManager.create(P, SESSIONS));
	const startedBefore = consumerOf(started.settings);
	const startedModel = started.model.id;

	const switcher = makeSession((await load(P)).sessionView(), SessionManager.create(P, SESSIONS));
	expect((await applyModelPreset(switcher, "C", { scope: "project" })).kind).toBe("switched");
	expect(started.model.id).toBe(startedModel);
	expect(consumerOf(started.settings)).toEqual(startedBefore);

	const fresh = makeSession((await load(P)).sessionView(), SessionManager.create(P, SESSIONS));
	expect(consumerOf(fresh.settings)).toEqual({
		roles: { default: "fakeprov/gamma" },
		defaultRole: "fakeprov/gamma",
		smolRole: undefined,
		chains: { base: ["fakeprov/gamma", "fakeprov/alpha"] },
		thinking: "medium",
	});
});

test("session-only switch persists in the branch; project consumer and config bytes unchanged; reopen restores", async () => {
	await seedProjectA();
	const configBytes = fs.readFileSync(P_CONFIG, "utf8");
	const projectConsumer = consumerOf((await load(P)).sessionView());
	const mgr = SessionManager.create(P, SESSIONS);
	const sess = makeSession((await load(P)).sessionView(), mgr);
	expect((await applyModelPreset(sess, "B", { scope: "session" })).kind).toBe("switched");
	expect(sess.model.id).toBe("beta");
	expect(sess.thinking).toBe("high");
	expect(consumerOf(sess.settings)).toEqual({
		roles: { default: "fakeprov/beta" },
		defaultRole: "fakeprov/beta",
		smolRole: undefined,
		chains: { base: ["fakeprov/beta"] },
		thinking: "high",
	});
	expect(fs.readFileSync(P_CONFIG, "utf8")).toBe(configBytes);
	expect(JSON.parse(lastSnapshot(mgr)).data.defaultThinkingLevel).toBe("high");

	expect(consumerOf((await load(P)).sessionView())).toEqual(projectConsumer);

	const reopened = await SessionManager.open(mgr.getSessionFile(), SESSIONS);
	const view = (await load(P)).sessionView();
	expect(attachSessionPreset(view, reopened, { record: false })).toBe(true);
	expect(consumerOf(view)).toEqual({
		roles: { default: "fakeprov/beta" },
		defaultRole: "fakeprov/beta",
		smolRole: undefined,
		chains: { base: ["fakeprov/beta"] },
		thinking: "high",
	});
});

test("role and chain keys replace whole records; chain key order preserved", async () => {
	const sess = makeSession((await load(P)).sessionView(), SessionManager.create(P, SESSIONS));
	expect((await applyModelPreset(sess, "O", { scope: "session" })).kind).toBe("switched");
	const consumer = consumerOf(sess.settings);
	expect(consumer.roles).toEqual({ default: "fakeprov/alpha" });
	expect(consumer.smolRole).toBeUndefined();
	expect(Object.keys(consumer.chains ?? {})).toEqual(["second", "first"]);
	expect(consumer.chains).toEqual({ second: ["fakeprov/beta"], first: ["fakeprov/alpha"] });
});

test("unauthed or missing preset rolls back: no persisted choice, pin and config unchanged", async () => {
	await seedProjectA();
	const root = await load(P);
	const mgr = SessionManager.create(P, SESSIONS);
	const sess = makeSession(root.sessionView(), mgr);
	const consumerBefore = consumerOf(sess.settings);
	const configBytes = fs.readFileSync(P_CONFIG, "utf8");
	const snapBefore = lastSnapshot(mgr);
	const modelBefore = sess.model.id;

	expect((await applyModelPreset(sess, "L", { scope: "project" })).kind).toBe("unavailable");
	expect((await applyModelPreset(sess, "NOPE", { scope: "project" })).kind).toBe("missing");
	expect(consumerOf(sess.settings)).toEqual(consumerBefore);
	expect(sess.model.id).toBe(modelBefore);
	expect(lastSnapshot(mgr)).toBe(snapBefore);
	expect(fs.readFileSync(P_CONFIG, "utf8")).toBe(configBytes);
});

test("setModel failure rolls back pin, thinking, model, and project default", async () => {
	await seedProjectA();
	const root = await load(P);
	const mgr = SessionManager.create(P, SESSIONS);
	const sess = makeSession(root.sessionView(), mgr);
	const consumerBefore = consumerOf(sess.settings);
	const thinkBefore = sess.thinking;
	const snapBefore = lastSnapshot(mgr);
	const configBytes = fs.readFileSync(P_CONFIG, "utf8");

	sess.failSetModel = true;
	expect((await applyModelPreset(sess, "C", { scope: "project" })).kind).toBe("failed");
	expect(consumerOf(sess.settings)).toEqual(consumerBefore);
	expect(sess.model.id).toBe("gamma");
	expect(sess.thinking).toBe(thinkBefore);
	expect(lastSnapshot(mgr)).toBe(snapBefore);
	expect(fs.readFileSync(P_CONFIG, "utf8")).toBe(configBytes);
});

test("async project save failure rolls back pin, thinking, model, and records no snapshot", async () => {
	fs.mkdirSync(R, { recursive: true });
	const root = await load(R);
	const mgr = SessionManager.create(R, SESSIONS);
	const sess = makeSession(root.sessionView(), mgr);
	sess.thinking = "low";
	const consumerBefore = consumerOf(sess.settings);
	const snapBefore = lastSnapshot(mgr);
	// A directory at the config path makes the atomic write fail on rename.
	fs.mkdirSync(path.join(R, ".omp", "config.yml"), { recursive: true });

	expect((await applyModelPreset(sess, "C", { scope: "project" })).kind).toBe("failed");
	expect(consumerOf(sess.settings)).toEqual(consumerBefore);
	expect(sess.thinking).toBe("low");
	expect(sess.model.id).toBe("gamma");
	expect(lastSnapshot(mgr)).toBe(snapBefore);
});

test("absent preset thinking keeps the current session thinking level", async () => {
	const sess = makeSession((await load(P)).sessionView(), SessionManager.create(P, SESSIONS));
	expect((await applyModelPreset(sess, "A", { scope: "session" })).kind).toBe("switched");
	expect((await applyModelPreset(sess, "N", { scope: "session" })).kind).toBe("switched");
	expect(sess.thinking).toBe("low");
	expect(consumerOf(sess.settings).thinking).toBe("low");
});

test("saved catalog entries are durable on disk and visible to a fresh load", async () => {
	const root = await load(Q);
	saveModelPreset(root, "CatalogQ");
	await root.flush();

	const fresh = await load(Q);
	expect(getModelPresetNames(fresh)).toContain("CatalogQ");
	expect(fs.readFileSync(GLOBAL_CONFIG, "utf8")).toContain("CatalogQ");
});

test("session-view project save flushes to root and persists to disk", async () => {
	const root = await load(P);
	const sess = makeSession(root.sessionView(), SessionManager.create(P, SESSIONS));
	expect((await applyModelPreset(sess, "B", { scope: "project" })).kind).toBe("switched");
	await root.flush();

	const fresh = (await load(P)).sessionView();
	expect(consumerOf(fresh)).toEqual({
		roles: { default: "fakeprov/beta" },
		defaultRole: "fakeprov/beta",
		smolRole: undefined,
		chains: { base: ["fakeprov/beta"] },
		thinking: "high",
	});
});

test("reloadForCwd rescopes the root: project save targets the new project, not the source", async () => {
	const root = await load(P);
	await root.reloadForCwd(Q);
	const sess = makeSession(root.sessionView(), SessionManager.create(Q, SESSIONS));
	expect((await applyModelPreset(sess, "A", { scope: "project" })).kind).toBe("switched");
	await root.flush();

	expect(consumerOf((await load(Q)).sessionView()).roles).toEqual({
		default: "fakeprov/alpha",
		smol: "fakeprov/beta",
	});
	expect(fs.existsSync(P_CONFIG)).toBe(false);
});

test("same-process attach restores the branch snapshot over the project default", async () => {
	await seedProjectA();
	const mgr = SessionManager.create(P, SESSIONS);
	recordSessionPreset(mgr, {
		modelRoles: { default: "fakeprov/gamma" },
		defaultThinkingLevel: "medium",
		fallbackChains: { base: ["fakeprov/gamma"] },
	});
	const view = (await load(P)).sessionView();
	expect(attachSessionPreset(view, mgr, { record: false })).toBe(true);
	expect(consumerOf(view)).toEqual({
		roles: { default: "fakeprov/gamma" },
		defaultRole: "fakeprov/gamma",
		smolRole: undefined,
		chains: { base: ["fakeprov/gamma"] },
		thinking: "medium",
	});
});

test("branch with no preset entry takes the current project baseline", async () => {
	await seedProjectA();
	const mgr = SessionManager.create(P, SESSIONS);
	const view = (await load(P)).sessionView();
	expect(attachSessionPreset(view, mgr, { record: false })).toBe(false);
	expect(consumerOf(view)).toEqual(consumerOf((await load(P)).sessionView()));
});

test("applySessionPinDefault applies the project default model and thinking to a new session", async () => {
	await seedProjectA();
	const sess = makeSession((await load(P)).sessionView(), SessionManager.create(P, SESSIONS));
	sess.thinking = "medium";
	expect(await applySessionPinDefault(sess)).toBeUndefined();
	expect(sess.model.id).toBe("alpha");
	expect(sess.thinking).toBe("low");
});

test("resolveSessionDefault returns a reason for an unauthed project candidate and changes nothing", async () => {
	const root = await load(P);
	const mgr = SessionManager.create(P, SESSIONS);
	const sess = makeSession(root.sessionView(), mgr);
	sess.thinking = "medium";
	const consumerBefore = consumerOf(sess.settings);
	const snapBefore = lastSnapshot(mgr);
	const modelBefore = sess.model.id;

	const live = resolveSessionDefault(sess, { modelRoles: { default: "fakeprov/locked" } });
	expect(typeof live).toBe("string");
	expect(sess.model.id).toBe(modelBefore);
	expect(sess.thinking).toBe("medium");
	expect(consumerOf(sess.settings)).toEqual(consumerBefore);
	expect(lastSnapshot(mgr)).toBe(snapBefore);
});
