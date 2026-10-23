/**
 * Model presets: named snapshots of the role assignments (`modelRoles`), `defaultThinkingLevel`, and
 * `retry.fallbackChains`, saved and applied as a whole.
 *
 * Presets persist to the global config (`modelPresets.<name>`); a project config may also define presets,
 * which are listed and applied but never copied into the global file. Applying a preset pins the current
 * session to all three values and logs that snapshot in the session, so reopening restores it. A
 * project-scope switch also saves the preset as the project default, which only sessions created afterwards
 * inherit. A preset without `defaultThinkingLevel` takes the session's configured default level; one without
 * `fallbackChains` has no chains. Values another layer still decides (a `--config` overlay or a launch
 * override) are reported back instead of being silently kept.
 */
import type { Model } from "@oh-my-pi/pi-ai";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { AUTO_THINKING, type ConfiguredThinkingLevel, parseConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import { cfgDefaultThinkingLevel, cfgRetryFallbackChains } from "../session/settings";
import { pickDefaultAvailableModel, resolveModelRoleValue } from "./model-resolver";
import { cfgModelPresets, type ModelPreset } from "./model-settings";
import type { SessionPresetPin, Settings, SettingProvenance } from "./settings";

/** Preset names: a letter, then letters, digits, `-` or `_` (the model hub's role-name rule). */
const PRESET_NAME_PATTERN = /^[a-zA-Z][\w-]*$/;

export function isValidModelPresetName(name: string): boolean {
	return PRESET_NAME_PATTERN.test(name);
}

type PresetLookup = { kind: "found"; preset: ModelPreset } | { kind: "missing" } | { kind: "invalid"; reason: string };

/** Type guard for one `retry.fallbackChains` value: an ordered array of model selectors. */
function isSelectorList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(entry => typeof entry === "string");
}

/** Validate one raw `modelPresets` entry; hand-edited config can hold anything. */
function parseModelPreset(raw: unknown): ModelPreset | string {
	if (!isRecord(raw)) return "it is not a mapping";
	const roles = raw.modelRoles;
	if (!isRecord(roles)) return "`modelRoles` is missing or not a mapping";
	const modelRoles: Record<string, string> = {};
	for (const role of Object.keys(roles)) {
		const value = roles[role];
		if (typeof value !== "string" || value.trim() === "") return `role \`${role}\` is not a model selector`;
		modelRoles[role] = value;
	}
	const rawChains = raw.fallbackChains;
	let fallbackChains: Record<string, string[]> | undefined;
	if (rawChains !== undefined) {
		if (!isRecord(rawChains)) return "`fallbackChains` is not a mapping";
		fallbackChains = {};
		for (const key of Object.keys(rawChains)) {
			const chain = rawChains[key];
			if (!isSelectorList(chain)) return `fallback chain \`${key}\` is not an array of model selectors`;
			fallbackChains[key] = [...chain];
		}
	}
	const level = raw.defaultThinkingLevel;
	if (level === undefined) {
		return fallbackChains === undefined ? { modelRoles } : { modelRoles, fallbackChains };
	}
	const thinking = typeof level === "string" ? parseConfiguredThinkingLevel(level) : undefined;
	if (thinking === undefined || !isDefaultThinkingLevel(thinking)) {
		return "`defaultThinkingLevel` is not a thinking level";
	}
	return fallbackChains === undefined
		? { modelRoles, defaultThinkingLevel: thinking }
		: { modelRoles, defaultThinkingLevel: thinking, fallbackChains };
}

function isDefaultThinkingLevel(
	level: ConfiguredThinkingLevel,
): level is NonNullable<ModelPreset["defaultThinkingLevel"]> {
	return level === AUTO_THINKING || THINKING_EFFORTS.some(effort => effort === level);
}

/** Look a preset up whole from the highest layer owning its name — same-name entries never merge. */
export function getModelPreset(settings: Settings, name: string): PresetLookup {
	const owned = settings.getOwnedModelPreset(name);
	if (!owned) return { kind: "missing" };
	const parsed = parseModelPreset(owned.entry);
	return typeof parsed === "string" ? { kind: "invalid", reason: parsed } : { kind: "found", preset: parsed };
}

/** Saved preset names, sorted; names a `--config`/runtime `null` tombstone hides are left out. */
export function getModelPresetNames(settings: Settings): string[] {
	return Object.keys(cfgModelPresets.get(settings))
		.filter(name => settings.getOwnedModelPreset(name) !== undefined)
		.sort((a, b) => a.localeCompare(b));
}

/**
 * Well-formed `retry.fallbackChains` entries from the live settings record, as fresh
 * arrays. The setting validates only the outer object — hand-edited YAML can hold `null`
 * or a bare string per key — and a preset that snapshotted such an entry would fail
 * `parseModelPreset` and become unappliable. Malformed entries are dropped instead.
 * Arrays are copied so a preset and the live record never share an instance.
 */
function sanitizeFallbackChains(raw: Record<string, unknown>): Record<string, string[]> {
	const chains: Record<string, string[]> = {};
	for (const [key, value] of Object.entries(raw)) {
		if (isSelectorList(value)) chains[key] = [...value];
	}
	return chains;
}

/** Order-sensitive equality for two selector lists; `undefined` matches only `undefined`. */
function sameSelectorList(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
	if (a === undefined || b === undefined) return a === b;
	return a.length === b.length && a.every((sel, i) => sel === b[i]);
}

/** Reported as a shadowed chain when only the record's key order differs from the preset's. */
const KEY_ORDER_LABEL = "(key order)";

/**
 * Equality for two `retry.fallbackChains` records, key order included:
 * `resolveRetryFallbackChainKey` takes the first matching key at equal precedence, so a record
 * whose keys are merely reordered is a different configuration, not the same one.
 */
function sameFallbackChains(a: Record<string, string[]>, b: Record<string, string[]>): boolean {
	const aKeys = Object.keys(a);
	const bKeys = Object.keys(b);
	if (aKeys.length !== bKeys.length) return false;
	return aKeys.every((key, i) => key === bKeys[i] && sameSelectorList(a[key], b[key]));
}

/**
 * First saved preset (by name) the current setup matches: identical effective role
 * assignments, the same default thinking level when the preset records one, and the
 * same `retry.fallbackChains` — key order included — when it records those too.
 * Undefined when the setup was edited past every preset.
 */
export function findActiveModelPreset(settings: Settings): string | undefined {
	const roles = settings.getModelRoles();
	// Same filter as `saveModelPreset`: empty selectors are never stored.
	const roleIds = Object.keys(roles).filter(role => roles[role]);
	const thinking = cfgDefaultThinkingLevel.get(settings);
	const liveChains = sanitizeFallbackChains(cfgRetryFallbackChains.get(settings));
	return getModelPresetNames(settings).find(name => {
		const lookup = getModelPreset(settings, name);
		if (lookup.kind !== "found") return false;
		const { modelRoles, defaultThinkingLevel } = lookup.preset;
		if (defaultThinkingLevel !== undefined && defaultThinkingLevel !== thinking) return false;
		const presetChains = lookup.preset.fallbackChains;
		if (presetChains !== undefined && !sameFallbackChains(presetChains, liveChains)) return false;
		const presetIds = Object.keys(modelRoles);
		return (
			presetIds.length === roleIds.length &&
			presetIds.every(role => Object.hasOwn(roles, role) && roles[role] === modelRoles[role])
		);
	});
}

/**
 * Save the effective role assignments, `defaultThinkingLevel` and `retry.fallbackChains`
 * as `name` in the global config, overwriting a preset of the same name. Only this entry
 * is written, so presets defined by a project config are never copied globally.
 *
 * @throws Error when `name` is not a valid preset name.
 */
export function saveModelPreset(settings: Settings, name: string): ModelPreset {
	if (!isValidModelPresetName(name)) {
		throw new Error(`Invalid preset name "${name}": use a letter, then letters, digits, - or _`);
	}
	const modelRoles: Record<string, string> = {};
	for (const [role, selector] of Object.entries(settings.getModelRoles())) {
		if (selector) modelRoles[role] = selector;
	}
	const preset: ModelPreset = {
		modelRoles,
		defaultThinkingLevel: cfgDefaultThinkingLevel.get(settings),
		fallbackChains: sanitizeFallbackChains(cfgRetryFallbackChains.get(settings)),
	};
	cfgModelPresets.setEntry(settings, name, preset);
	return preset;
}

export type ModelPresetDeleteResult = "deleted" | "missing" | "project";

/**
 * Delete `name` from the global config. A preset only a project (or `--config`)
 * file defines is reported as `project`: it has to be removed from that file.
 * The same applies when another layer defines the same name: the global entry is
 * removed but the preset keeps listing, so `project` is reported instead of a
 * false `deleted`.
 */
export function deleteModelPreset(settings: Settings, name: string): ModelPresetDeleteResult {
	const global = settings.getGlobalSettings().modelPresets;
	if (isRecord(global) && Object.hasOwn(global, name)) {
		cfgModelPresets.setEntry(settings, name, undefined);
		return settings.getOwnedModelPreset(name) ? "project" : "deleted";
	}
	return settings.getOwnedModelPreset(name) ? "project" : "missing";
}

/**
 * Layer above global config that still defines preset `name`, if any — so a
 * global save can warn that the just-saved entry is shadowed and won't apply.
 */
export function modelPresetShadowOwner(
	settings: Settings,
	name: string,
): "runtime" | "overlay" | "project" | undefined {
	const owned = settings.getOwnedModelPreset(name);
	return owned && owned.source !== "global" ? owned.source : undefined;
}

const SOURCE_LABELS: Record<SettingProvenance, string> = {
	env: "environment",
	runtime: "command line",
	overlay: "--config file",
	project: "project config",
	global: "global config",
	default: "default",
};

/** Status line after saving `name`, naming the higher layer whose same-name preset still wins, if any. */
export function modelPresetSavedMessage(settings: Settings, name: string): string {
	const owner = modelPresetShadowOwner(settings, name);
	if (owner === undefined) return `Saved model preset "${name}"`;
	return `Saved model preset "${name}" to the global config, but the ${SOURCE_LABELS[owner]} still defines a preset of the same name, which takes precedence`;
}

/** Serialize default-role mutations with the model hub's assign/unassign paths. */
let modelRoleMutationTail: Promise<void> = Promise.resolve();
export async function acquireModelRoleMutation(): Promise<() => void> {
	const previous = modelRoleMutationTail;
	const { promise, resolve } = Promise.withResolvers<void>();
	modelRoleMutationTail = previous.then(() => promise);
	await previous;
	return resolve;
}

/** A role whose effective assignment differs from the preset after applying it. */
export interface ModelPresetShadowedRole {
	role: string;
	/** The preset's selector, or undefined when the preset leaves the role unset. */
	expected: string | undefined;
	/** The effective selector that won instead. */
	actual: string | undefined;
	source: SettingProvenance;
}

/** The preset's `defaultThinkingLevel` when a layer above global config still decides the setting. */
export interface ModelPresetShadowedThinking {
	expected: NonNullable<ModelPreset["defaultThinkingLevel"]>;
	/** The effective setting that won instead; the live session still uses `expected`. */
	actual: ModelPreset["defaultThinkingLevel"];
	source: SettingProvenance;
}

/**
 * A `retry.fallbackChains` entry — or the record's key order — that another layer still decides
 * after the preset was written, so the effective chains differ from the preset's.
 */
export interface ModelPresetShadowedChain {
	/** The chain key, or `"(key order)"` when only the record's key order differs. */
	key: string;
	/** The preset's chain for `key`, or its key sequence for the `"(key order)"` entry. */
	expected: readonly string[] | undefined;
	/** The chain — or key sequence — effectively in force instead. */
	actual: readonly string[] | undefined;
	source: SettingProvenance;
}

/** Where a switch lands: this session only, or also the project default that new sessions inherit. */
export type ModelPresetScope = "session" | "project";

export type ModelPresetSwitchResult =
	| {
			kind: "switched";
			scope: ModelPresetScope;
			model: Model;
			thinkingLevel: ConfiguredThinkingLevel | undefined;
			/** Roles another layer still decides; empty on a clean switch. */
			shadowed: ModelPresetShadowedRole[];
			/** Set when another layer still decides `defaultThinkingLevel`, so it returns on reload. */
			shadowedThinking: ModelPresetShadowedThinking | undefined;
			/** Chain keys (or key order) another layer still decides; empty on a clean switch. */
			shadowedChains: ModelPresetShadowedChain[];
	  }
	| { kind: "missing" }
	| { kind: "invalid"; reason: string }
	/** Nothing was written: the preset cannot be applied right now. */
	| { kind: "unavailable"; reason: string }
	/** The live model could not be switched; the previous session state was restored. */
	| { kind: "failed"; reason: string };

export type ModelPresetSession = Pick<
	AgentSession,
	| "model"
	| "settings"
	| "sessionManager"
	| "setModel"
	| "setThinkingLevel"
	| "configuredThinkingLevel"
	| "getAvailableModels"
	| "scopedModels"
	| "modelRegistry"
>;

function presetCandidates(session: ModelPresetSession): Model[] {
	const scoped = session.scopedModels.map(entry => entry.model);
	return scoped.length > 0 ? scoped : session.getAvailableModels();
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** First authed model for a preset with no `default`, mirroring startup's automatic pick. */
function pickAutomaticDefault(session: ModelPresetSession, candidates: Model[]): Model | undefined {
	return pickDefaultAvailableModel(
		candidates.filter(candidate => session.modelRegistry.hasConfiguredAuth(candidate)),
		provider => session.modelRegistry.hasConcreteAuth(provider),
	);
}

/**
 * Where `default` lands once the preset is applied: its model and thinking level. Only the preset's own roles
 * resolve, so a role it omits stays unset rather than falling back to the live settings. Writes nothing.
 * Without an explicit `:level` on the selector, the preset's `defaultThinkingLevel` applies, or the session's
 * configured level when the preset sets none.
 */
function resolvePresetDefault(
	settings: Settings,
	session: ModelPresetSession,
	candidates: Model[],
	preset: ModelPreset,
): { model: Model; thinkingLevel: ConfiguredThinkingLevel | undefined } | string {
	const roleValue = Object.hasOwn(preset.modelRoles, "default") ? preset.modelRoles.default : undefined;
	const fallbackLevel =
		preset.defaultThinkingLevel ?? parseConfiguredThinkingLevel(cfgDefaultThinkingLevel.get(settings));
	if (!roleValue) {
		const model = pickAutomaticDefault(session, candidates);
		return model ? { model, thinkingLevel: fallbackLevel } : "no model with configured credentials is available";
	}
	const roleLookup = {
		getModelRole: (role: string) => (Object.hasOwn(preset.modelRoles, role) ? preset.modelRoles[role] : undefined),
	};
	const resolved = resolveModelRoleValue(roleValue, candidates, { settings, roleLookup });
	if (!resolved.model) return `default model \`${roleValue}\` is not available`;
	if (!session.modelRegistry.hasConfiguredAuth(resolved.model)) {
		return `no credentials for ${resolved.model.provider}/${resolved.model.id}`;
	}
	return {
		model: resolved.model,
		thinkingLevel: resolved.explicitThinkingLevel ? resolved.thinkingLevel : fallbackLevel,
	};
}

function shadowedRoles(settings: Settings, preset: ModelPreset): ModelPresetShadowedRole[] {
	const effective = settings.getModelRoles();
	const roles = new Set([...Object.keys(effective), ...Object.keys(preset.modelRoles)]);
	const shadowed: ModelPresetShadowedRole[] = [];
	for (const role of [...roles].sort((a, b) => a.localeCompare(b))) {
		const expected = Object.hasOwn(preset.modelRoles, role) ? preset.modelRoles[role] : undefined;
		const actual = Object.hasOwn(effective, role) ? effective[role] : undefined;
		if (expected !== actual) {
			shadowed.push({ role, expected, actual, source: settings.getModelRoleProvenance(role) });
		}
	}
	return shadowed;
}

/**
 * Chain entries — or the key order — the preset could not put in force, because a layer above
 * global config still decides them. A whole-record global write cannot remove those keys, and
 * `Settings.#deepMerge` puts the higher layer's keys first, so the effective record can differ
 * from the preset's in values, in membership, or in order alone.
 */
function shadowedChains(settings: Settings, preset: ModelPreset): ModelPresetShadowedChain[] {
	const expected = preset.fallbackChains;
	if (expected === undefined) return [];
	const effective = sanitizeFallbackChains(cfgRetryFallbackChains.get(settings));
	if (sameFallbackChains(effective, expected)) return [];
	const source = cfgRetryFallbackChains.provenance(settings);
	const shadowed: ModelPresetShadowedChain[] = [];
	for (const key of new Set([...Object.keys(effective), ...Object.keys(expected)])) {
		const want = Object.hasOwn(expected, key) ? expected[key] : undefined;
		const got = Object.hasOwn(effective, key) ? effective[key] : undefined;
		if (!sameSelectorList(want, got)) shadowed.push({ key, expected: want, actual: got, source });
	}
	// Same keys and values in a different order: still not the preset's configuration, because
	// chain resolution takes the first matching key.
	if (shadowed.length === 0) {
		shadowed.push({ key: KEY_ORDER_LABEL, expected: Object.keys(expected), actual: Object.keys(effective), source });
	}
	return shadowed;
}

function shadowedThinking(settings: Settings, preset: ModelPreset): ModelPresetShadowedThinking | undefined {
	const expected = preset.defaultThinkingLevel;
	if (expected === undefined) return undefined;
	const actual = cfgDefaultThinkingLevel.get(settings);
	if (actual === expected) return undefined;
	return { expected, actual, source: cfgDefaultThinkingLevel.provenance(settings) };
}

/** Session-log entry holding a session's preset snapshot: its roles, thinking level and fallback chains. */
const SESSION_PRESET_ENTRY = "model-preset-session";

/** Log `pin` on the session branch, where `attachSessionPreset` finds it again on reopen. */
export function recordSessionPreset(manager: SessionManager, pin: SessionPresetPin): void {
	manager.appendCustomEntry(SESSION_PRESET_ENTRY, pin, { persist: true });
}

/**
 * Pins the session view `settings` to the snapshot most recently logged on `manager`'s branch and returns true.
 * `startup` re-applies CLI/env role overrides on top. A branch with no snapshot starts from the project baseline,
 * never the outgoing pin; with `record` set that baseline is logged so reopening keeps it, and it returns false.
 */
export function attachSessionPreset(
	settings: Settings,
	manager: SessionManager,
	options: { record: boolean; startup?: boolean },
): boolean {
	if (!settings.isSessionView) return false;
	const branch = manager.getBranch();
	const entry = branch.findLast(item => item.type === "custom" && item.customType === SESSION_PRESET_ENTRY);
	if (entry?.type === "custom") {
		const parsed = parseModelPreset(entry.data);
		if (typeof parsed !== "string") {
			settings.restoreSessionPin(
				{ ...parsed, fallbackChains: parsed.fallbackChains ?? {} },
				{ launch: options.startup === true },
			);
			return true;
		}
	}
	settings.resetSessionPin();
	const pin = options.record ? settings.sessionPin() : undefined;
	if (pin) recordSessionPreset(manager, pin);
	return false;
}

/**
 * Applies the preset to `session`, validating and auth-checking everything before any write. `scope: "project"`
 * also saves it as the project default that new sessions inherit; `"session"` changes only this session.
 */
export async function applyModelPreset(
	session: ModelPresetSession,
	name: string,
	options: { scope: ModelPresetScope },
): Promise<ModelPresetSwitchResult> {
	const release = await acquireModelRoleMutation();
	try {
		return await applyModelPresetLocked(session, name, options.scope);
	} finally {
		release();
	}
}

async function applyModelPresetLocked(
	session: ModelPresetSession,
	name: string,
	scope: ModelPresetScope,
): Promise<ModelPresetSwitchResult> {
	const { settings } = session;
	if (!settings.isSessionView) {
		return { kind: "unavailable", reason: "this session does not own its model settings" };
	}
	const lookup = getModelPreset(settings, name);
	if (lookup.kind !== "found") return lookup;
	const { preset } = lookup;
	const live = resolvePresetDefault(settings, session, presetCandidates(session), preset);
	if (typeof live === "string") return { kind: "unavailable", reason: live };

	const pin: SessionPresetPin = {
		modelRoles: { ...preset.modelRoles },
		defaultThinkingLevel: preset.defaultThinkingLevel ?? cfgDefaultThinkingLevel.get(settings),
		fallbackChains: structuredClone(preset.fallbackChains ?? {}),
	};
	const previousPin = settings.sessionPin();
	const previousModel = session.model;
	const previousThinking = session.configuredThinkingLevel();
	try {
		// The pin goes in first so anything resolved while the model switches reads the preset's own roles.
		settings.setSessionPin(pin);
		await session.setModel(live.model, "default", { persist: false });
		// setModel re-applies the model's default or keeps the current level; the preset decides instead.
		// `:inherit` means "no explicit level": leave what setModel applied rather than clearing the session level.
		if (live.thinkingLevel !== undefined && live.thinkingLevel !== ThinkingLevel.Inherit) {
			session.setThinkingLevel(live.thinkingLevel);
		}
		// Awaited so a failed project write rolls the whole switch back instead of reporting a false choice.
		if (scope === "project") await settings.persistSessionPresetDefault(name, pin);
	} catch (error) {
		const reason = errorMessage(error);
		if (previousPin) settings.setSessionPin(previousPin);
		try {
			if (previousModel && session.model !== previousModel) {
				await session.setModel(previousModel, "default", { persist: false });
			}
			session.setThinkingLevel(previousThinking);
		} catch (rollbackError) {
			return { kind: "failed", reason: `${reason}; rollback also failed: ${errorMessage(rollbackError)}` };
		}
		return { kind: "failed", reason };
	}
	// Logged only once the switch has fully applied, so a failed switch never leaves a snapshot behind.
	recordSessionPreset(session.sessionManager, pin);
	if (scope === "session") {
		return {
			kind: "switched",
			scope,
			model: live.model,
			thinkingLevel: live.thinkingLevel,
			shadowed: [],
			shadowedThinking: undefined,
			shadowedChains: [],
		};
	}
	// Judged against the root: what another layer still decides for sessions created from now on.
	const expected: ModelPreset = { ...preset, fallbackChains: preset.fallbackChains ?? {} };
	const root = settings.root;
	return {
		kind: "switched",
		scope,
		model: live.model,
		thinkingLevel: live.thinkingLevel,
		shadowed: shadowedRoles(root, expected),
		shadowedThinking: shadowedThinking(root, expected),
		shadowedChains: shadowedChains(root, expected),
	};
}

function describeRoleValue(value: string | undefined): string {
	return value ?? "(unset)";
}

function describeChainValue(value: readonly string[] | undefined): string {
	if (value === undefined) return "(unset)";
	return value.length > 0 ? value.join(", ") : "(empty)";
}

/** The model and thinking level a session's pinned default resolves to. */
export interface SessionDefaultSelection {
	model: Model;
	thinkingLevel: ConfiguredThinkingLevel | undefined;
}

/**
 * Resolves the model and thinking level `pin` selects for `session`, without touching it. A failure returns the
 * reason, so a caller can refuse a transition before any state changes.
 */
export function resolveSessionDefault(
	session: ModelPresetSession,
	pin: SessionPresetPin,
): SessionDefaultSelection | string {
	return resolvePresetDefault(session.settings, session, presetCandidates(session), {
		modelRoles: pin.modelRoles,
		fallbackChains: pin.fallbackChains,
		defaultThinkingLevel:
			pin.defaultThinkingLevel !== undefined && isDefaultThinkingLevel(pin.defaultThinkingLevel)
				? pin.defaultThinkingLevel
				: undefined,
	});
}

/** Applies a resolution from {@link resolveSessionDefault} to `session`. Writes nothing to disk. */
export async function applyResolvedSessionDefault(
	session: ModelPresetSession,
	live: SessionDefaultSelection,
): Promise<void> {
	await session.setModel(live.model, "default", { persist: false });
	if (live.thinkingLevel !== undefined && live.thinkingLevel !== ThinkingLevel.Inherit) {
		session.setThinkingLevel(live.thinkingLevel);
	}
}

/**
 * Applies the session's pinned default model and thinking level. Writes nothing. Returns the reason when the default
 * is unavailable, in which case the current selection is left in place.
 */
export async function applySessionPinDefault(session: ModelPresetSession): Promise<string | undefined> {
	const pin = session.settings.sessionPin();
	if (!pin) return undefined;
	const live = resolveSessionDefault(session, pin);
	if (typeof live === "string") return live;
	await applyResolvedSessionDefault(session, live);
	return undefined;
}

/** One line per role, chain entry and the thinking level the preset could not set, for status output. */
export function describeShadowedRoles(
	shadowed: readonly ModelPresetShadowedRole[],
	thinking?: ModelPresetShadowedThinking,
	chains?: readonly ModelPresetShadowedChain[],
): string[] {
	const lines = shadowed.map(
		entry =>
			`${entry.role}: ${describeRoleValue(entry.actual)} from ${SOURCE_LABELS[entry.source]} (preset: ${describeRoleValue(entry.expected)})`,
	);
	for (const entry of chains ?? []) {
		lines.push(
			`fallback chain ${entry.key}: ${describeChainValue(entry.actual)} from ${SOURCE_LABELS[entry.source]} (preset: ${describeChainValue(entry.expected)})`,
		);
	}
	if (thinking) {
		lines.push(
			`defaultThinkingLevel: ${describeRoleValue(thinking.actual)} from ${SOURCE_LABELS[thinking.source]} (preset: ${thinking.expected})`,
		);
	}
	return lines;
}

/** True when the switch applied the whole preset: switched, with no role, chain entry or thinking level still decided elsewhere. */
export function isCleanModelPresetSwitch(result: ModelPresetSwitchResult): boolean {
	return (
		result.kind === "switched" &&
		result.shadowed.length === 0 &&
		result.shadowedChains.length === 0 &&
		result.shadowedThinking === undefined
	);
}

/** Short summary of a switch outcome for status lines and command output. */
export function formatModelPresetSwitch(name: string, result: ModelPresetSwitchResult): string {
	switch (result.kind) {
		case "missing":
			return `Preset not found: ${name}`;
		case "invalid":
			return `Preset "${name}" is malformed: ${result.reason}`;
		case "unavailable":
		case "failed":
			return `Preset "${name}" not applied: ${result.reason}`;
		case "switched": {
			const thinking = result.thinkingLevel ? ` · ${result.thinkingLevel}` : "";
			const model = `${result.model.provider}/${result.model.id}${thinking}`;
			if (result.scope === "session") {
				return `Switched to preset "${name}" for this session only (${model}); project default unchanged`;
			}
			const saved = `Switched to preset "${name}" (${model}) and saved it as the project default`;
			const elsewhere = describeShadowedRoles(result.shadowed, result.shadowedThinking, result.shadowedChains);
			return elsewhere.length === 0 ? saved : `${saved}; still set elsewhere: ${elsewhere.join("; ")}`;
		}
	}
}
