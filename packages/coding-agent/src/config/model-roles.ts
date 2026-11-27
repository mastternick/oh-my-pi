/**
 * Built-in model roles and role metadata helpers.
 */

import { modelKind, type Model } from "@oh-my-pi/pi-catalog/types";
import {
	KIND_ROLE_IDS,
	MODEL_ROLE_IDS,
	type ModelBrowserRegistry,
	type ModelBrowserRoleInfo,
	type ModelRole,
} from "@oh-my-pi/pi-tui/overlays/model-browser";
import { MAX_THINKING_SUFFIX_OPTIONS, splitThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { isValidThemeColor } from "@oh-my-pi/pi-tui/theme";
import type { Settings } from "./settings";
import type { AgentDefinition } from "../task/types";

import { cfgCycleOrder, cfgModelTags } from "./model-settings";

/** Canonical prefix for a configured model role selector. */
export const MODEL_ROLE_ALIAS_PREFIX = "@";

/** Legacy prefix accepted for backwards-compatible role selectors. */
export const LEGACY_MODEL_ROLE_ALIAS_PREFIX = "pi/";

/** Shorthand selector for the default model role. */
export const DEFAULT_MODEL_ROLE_ALIAS = "*";

/** Format a model role as its canonical selector. */
export function formatModelRoleAlias(role: string): string {
	return `${MODEL_ROLE_ALIAS_PREFIX}${role}`;
}

/** The default model role, which the `*` alias names. */
export const DEFAULT_MODEL_ROLE = "default";

const MODEL_ROLE_ALIAS_PREFIXES = [MODEL_ROLE_ALIAS_PREFIX, LEGACY_MODEL_ROLE_ALIAS_PREFIX];

/**
 * Minimum colon index for splitting a `:<level>` suffix off a role alias, or `undefined` when `value` is not
 * role-alias shaped. Doubles as the slice offset of the role name for prefixed aliases (`@role`, `pi/role`); the bare
 * `*` default alias returns 0 because its colon sits immediately after the one-character token (`*:xhigh`).
 */
export function modelRoleAliasPrefixLength(value: string): number | undefined {
	if (value === DEFAULT_MODEL_ROLE_ALIAS || value.startsWith(`${DEFAULT_MODEL_ROLE_ALIAS}:`)) return 0;
	return MODEL_ROLE_ALIAS_PREFIXES.find(prefix => value.startsWith(prefix))?.length;
}

/**
 * The role a model-list selector references the way the resolver reads it: `@role`, `pi/role`, or `*` (the default
 * role), each with an optional `:level` suffix. Undefined for any other selector.
 */
export function roleReferencedBySelector(selector: string): string | undefined {
	const trimmed = selector.trim();
	const prefixLength = modelRoleAliasPrefixLength(trimmed);
	if (prefixLength === undefined) return undefined;
	const { base } = splitThinkingSuffix(trimmed, prefixLength, MAX_THINKING_SUFFIX_OPTIONS);
	return base === DEFAULT_MODEL_ROLE_ALIAS ? DEFAULT_MODEL_ROLE : base.slice(prefixLength);
}

export type { ModelRole } from "@oh-my-pi/pi-tui/overlays/model-browser";
export { CHAT_MODEL_ROLE_IDS, KIND_ROLE_IDS, MODEL_ROLE_IDS } from "@oh-my-pi/pi-tui/overlays/model-browser";

export type ModelRoleInfo = ModelBrowserRoleInfo;

function acceptsChat(model: Model): boolean {
	return modelKind(model) === "chat";
}

function acceptsTinyOrChat(model: Model): boolean {
	const kind = modelKind(model);
	return kind === "tiny" || kind === "chat";
}

function acceptsWeb(model: Model): boolean {
	const kind = modelKind(model);
	return kind === "search" || (kind === "chat" && model.webSearch !== undefined);
}

function acceptsJudge(model: Model): boolean {
	const kind = modelKind(model);
	return kind === "judge" || kind === "tiny" || kind === "chat";
}

const ROLE_DESCRIPTIONS: Record<ModelRole, string> = {
	default:
		"The main chat model for the session. It is also the fallback for image questions after `@vision` " +
		"(`utils/image-question.ts:72`).",
	smol:
		"A fast, low-cost model for lightweight work. The cleanse step uses `@smol` (`cleanse/index.ts:21`), " +
		"and it is the fallback for commit messages (`commit/model-selection.ts:46`). Unset `tiny`, `memory` " +
		"and `widget` use its priority list (`config/model-resolver.ts:1180`).",
	slow:
		"A model for slower, deeper reasoning. The completion bridge maps the slow role to `@slow` " +
		"(`eval/completion-bridge.ts:68`). An unset `advisor` uses the slow priority list " +
		"(`config/model-resolver.ts:1180`).",
	vision:
		"The model for image input. Image questions try `@vision` first (`utils/image-question.ts:57`, `:72`) " +
		"and fall back to `@default`.",
	plan:
		"The model used in plan mode. It is resolved when plan mode starts, and reassigning it during planning " +
		"moves the active model onto it (`modes/interactive-mode.ts:5961`, `:5989`).",
	commit:
		"The model that writes commit messages. It is tried before `smol` and the chat roles " +
		"(`commit/model-selection.ts:46`).",
	tiny:
		"A very small model for cheap helper work: skill descriptions (`extensibility/skill-descriptions.ts:103`), " +
		"judge candidates (`config/settings.ts:4305`) and input-controller candidates " +
		"(`modes/controllers/input-controller.ts:308`). Unset, it uses the smol priority list.",
	memory:
		"The model the memory backend uses (`mnemopi/backend.ts:645`, `:725`). Unset, it uses the smol priority list.",
	task:
		"The model for subtasks started with the `task` tool. The bundled `task` agent uses `@task` " +
		"(`task/agents.ts:54`), and agents that inherit the role resolve their chain from it (`task/executor.ts:370`).",
	advisor:
		"The model an agent's advisor uses when the agent enables it without naming a model; it then defaults to " +
		"`@advisor` (`modes/agents-hub-deps.ts:115`). Unset, it uses the slow priority list (`config/model-resolver.ts:1180`).",
	widget:
		"The model that writes background-job widget specs (`job-widgets/author.ts:221`). " +
		"Unset, it uses the smol priority list.",
	image: "The model for image generation (`tools/image-gen.ts:308`). Only image-kind models are eligible.",
	web:
		"The model for web search (`web/search/index.ts:277`) and the xAI search provider " +
		"(`web/search/providers/xai.ts:607`). Only search-kind models and chat models with web search " +
		"are eligible.",
	speech: "The text-to-speech model for the `tts` tool (`tools/tts.ts:64`). Only TTS-kind models are eligible.",
	dictation:
		"The speech-to-text model for dictation (`stt/stt-controller.ts:242`). Only STT-kind models are eligible.",
	judge: "The model for judgment calls (`judgment/index.ts:337`). Judge-kind, tiny and chat models are eligible.",
};

export const MODEL_ROLES: Record<ModelRole, ModelRoleInfo> = {
	default: {
		tag: "DEFAULT",
		name: "Default",
		color: "success",
		section: "chat",
		accepts: acceptsChat,
		description: ROLE_DESCRIPTIONS.default,
	},
	smol: {
		tag: "SMOL",
		name: "Fast",
		color: "warning",
		section: "chat",
		accepts: acceptsChat,
		description: ROLE_DESCRIPTIONS.smol,
	},
	slow: {
		tag: "SLOW",
		name: "Thinking",
		color: "accent",
		section: "chat",
		accepts: acceptsChat,
		description: ROLE_DESCRIPTIONS.slow,
	},
	vision: {
		tag: "VISION",
		name: "Vision",
		color: "error",
		section: "chat",
		accepts: acceptsChat,
		description: ROLE_DESCRIPTIONS.vision,
	},
	plan: {
		tag: "PLAN",
		name: "Architect",
		color: "muted",
		section: "chat",
		accepts: acceptsChat,
		description: ROLE_DESCRIPTIONS.plan,
	},
	commit: {
		tag: "COMMIT",
		name: "Commit",
		color: "dim",
		section: "chat",
		accepts: acceptsChat,
		description: ROLE_DESCRIPTIONS.commit,
	},
	tiny: {
		tag: "TINY",
		name: "Tiny",
		color: "dim",
		section: "chat",
		accepts: acceptsTinyOrChat,
		description: ROLE_DESCRIPTIONS.tiny,
	},
	memory: {
		tag: "MEMORY",
		name: "Memory",
		color: "dim",
		section: "chat",
		accepts: acceptsTinyOrChat,
		description: ROLE_DESCRIPTIONS.memory,
	},
	task: {
		tag: "TASK",
		name: "Subtask",
		color: "muted",
		section: "chat",
		accepts: acceptsChat,
		description: ROLE_DESCRIPTIONS.task,
	},
	advisor: {
		tag: "ADVISOR",
		name: "Advisor",
		color: "accent",
		section: "chat",
		accepts: acceptsChat,
		description: ROLE_DESCRIPTIONS.advisor,
	},
	widget: {
		tag: "WIDGET",
		name: "Job widgets",
		color: "dim",
		section: "chat",
		accepts: acceptsChat,
		description: ROLE_DESCRIPTIONS.widget,
	},
	image: {
		tag: "IMAGE",
		name: "Image generation",
		color: "accent",
		section: "kind",
		accepts: model => modelKind(model) === "image",
		description: ROLE_DESCRIPTIONS.image,
	},
	web: {
		tag: "WEB",
		name: "Web search",
		color: "success",
		section: "kind",
		accepts: acceptsWeb,
		description: ROLE_DESCRIPTIONS.web,
	},
	speech: {
		tag: "SPEECH",
		name: "Speech",
		color: "warning",
		section: "kind",
		accepts: model => modelKind(model) === "tts",
		description: ROLE_DESCRIPTIONS.speech,
	},
	dictation: {
		tag: "DICTATION",
		name: "Dictation",
		color: "warning",
		section: "kind",
		accepts: model => modelKind(model) === "stt",
		description: ROLE_DESCRIPTIONS.dictation,
	},
	judge: {
		tag: "JUDGE",
		name: "Judge",
		color: "muted",
		section: "kind",
		accepts: acceptsJudge,
		description: ROLE_DESCRIPTIONS.judge,
	},
};

export type RoleInfo = ModelRoleInfo;

/** Whether a role belongs to the non-chat model-kind section. */
export function isKindRole(role: string): boolean {
	return KIND_ROLE_IDS.some(id => id === role);
}

function isModelRole(role: string): role is ModelRole {
	return MODEL_ROLE_IDS.some(id => id === role);
}

/** Available models eligible for a role, including keyless runner models. */
export function roleCandidatePool(role: string, settings: Settings, registry: ModelBrowserRegistry): Model[] {
	return registry.getAvailable("all").filter(getRoleInfo(role, settings).accepts);
}

/**
 * Return the canonical set of known roles for selector/carousel UI.
 *
 * Built-ins always come first. Configured cycle order, model assignments, and
 * tag metadata can introduce additional custom roles without requiring duplicate
 * entries across settings.
 */
export function getKnownRoleIds(settings: Settings): string[] {
	const roles: string[] = MODEL_ROLE_IDS.filter(role => !MODEL_ROLES[role].hidden);
	const seen = new Set<string>(roles);
	const addRole = (role: string) => {
		if (seen.has(role)) return;
		seen.add(role);
		roles.push(role);
	};

	for (const role of cfgCycleOrder.get(settings)) addRole(role);
	for (const role in settings.getModelRoles()) addRole(role);
	for (const role in cfgModelTags.get(settings)) addRole(role);

	return roles;
}

/**
 * Get role info for a role name (built-in or custom).
 * Configured metadata overrides built-in defaults when present.
 */
export function getRoleInfo(role: string, settings: Settings): RoleInfo {
	const builtIn = isModelRole(role) ? MODEL_ROLES[role] : undefined;
	const configuredTags = cfgModelTags.get(settings);
	const configured = Object.hasOwn(configuredTags, role) ? configuredTags[role] : undefined;

	if (configured) {
		const description = configured.description || builtIn?.description;
		return {
			tag: builtIn?.tag,
			name: configured.name || builtIn?.name || role,
			color: configured.color && isValidThemeColor(configured.color) ? configured.color : builtIn?.color,
			hidden: configured.hidden ?? builtIn?.hidden,
			description,
			descriptionSource: configured.description ? "modelTags" : description ? "built-in" : undefined,
			accepts: builtIn?.accepts ?? acceptsChat,
			section: builtIn?.section ?? "chat",
		};
	}

	if (builtIn) return { ...builtIn, descriptionSource: "built-in" };

	return { name: role, color: "muted", accepts: acceptsChat, section: "chat" };
}

/** An agent whose `model` list references a role as `@<role>`. */
export interface RoleAgentUsage {
	agent: string;
	description: string;
	/** `primary` for the agent's first model entry, otherwise `fallback N` where N is the entry's index. */
	position: string;
}

/**
 * Agents whose `model` list references `role` through any selector the resolver reads as a role reference
 * (see `roleReferencedBySelector`), in the order given. `undefined` while agent discovery is unresolved or failed,
 * so the caller shows the usage as unknown rather than none.
 */
export function getRoleAgentUsage(
	role: string,
	agents: readonly AgentDefinition[] | undefined,
): RoleAgentUsage[] | undefined {
	if (!agents) return undefined;
	const usage: RoleAgentUsage[] = [];
	for (const agent of agents) {
		const index = agent.model?.findIndex(entry => roleReferencedBySelector(entry) === role) ?? -1;
		if (index < 0) continue;
		const position = index === 0 ? "primary" : `fallback ${index}`;
		usage.push({ agent: agent.name, description: agent.description, position });
	}
	return usage;
}
