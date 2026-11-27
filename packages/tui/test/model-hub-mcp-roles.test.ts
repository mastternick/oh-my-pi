/**
 * `mcp-*` roles nest under the `mcp` role in the Roles view: they are listed
 * beneath `mcp`, persist their own selectors, carry no compaction sub-row, and
 * stay reachable by search and in the model browser's role strip.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import type { DescribeContext } from "../src/native/node";
import {
	ModelHubComponent,
	type ModelHubCallbacks,
	type ModelHubRegistry,
	type ModelHubSource,
	type ScopedModelItem,
} from "../src/overlays/model-hub";
import { initTheme } from "../src/theme";
import { theme } from "../src/theme/theme";
import type { TUI } from "../src/index";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;

const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

const pickerCx: DescribeContext = {
	cols: 120,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => true,
};

function model(provider: string, id: string) {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

const parentModel = model("anthropic", "claude-sonnet");
const otherModel = model("openai", "gpt-mini");

interface Setup {
	roles: Record<string, string>;
	knownRoleIds: string[];
	hiddenRoles?: string[];
	sections?: Record<string, "chat" | "kind">;
	/** Roles whose value (configured or auto-selected as `pi/<role>`) resolves to no model. */
	unresolvedRoles?: string[];
	/** Roles set only in the merged view: a project `modelPresetDefault` masks them from the global layer. */
	maskedRoles?: Record<string, string>;
}

function createSource(setup: Setup): ModelHubSource {
	const unresolved = new Set((setup.unresolvedRoles ?? []).flatMap(role => [role, `pi/${role}`]));
	const hidden = new Set(setup.hiddenRoles ?? []);
	return {
		revision: 0,
		disabledProviders: [],
		fallbackChains: {},
		compactionModels: {},
		modelRoleStorage: "global",
		cycleOrder: [],
		getProjectModelRole: () => undefined,
		getGlobalModelRole: role => setup.roles[role],
		getModelRoleSource: () => "default",
		defaultThinkingLevel: "high",
		modelProviderOrder: [],
		knownRoleIds: setup.knownRoleIds,
		mruOrder: [],
		modelPerf: new Map(),
		getModelRole: role => setup.roles[role] ?? setup.maskedRoles?.[role],
		getRoleInfo: role => ({
			name: role,
			section: setup.sections?.[role] ?? "chat",
			accepts: () => true,
			hidden: hidden.has(role),
			...(role.startsWith("mcp-") ? { parent: "mcp" } : {}),
			...(role === "mcp" || role.startsWith("mcp-") ? { compactionRow: false as const } : {}),
		}),
		defaultRoleChain: () => [],
		resolveRoleValue: value => ({
			model: value !== undefined && unresolved.has(value) ? undefined : parentModel,
			explicitThinkingLevel: false,
		}),
	};
}

const registryStub: ModelHubRegistry = {
	getError: () => undefined,
	getAvailable: () => [],
	getAll: () => [],
	authStorage: { keys: { source: () => undefined } },
	getDiscoverableProviders: () => [],
	getProviderDiscoveryState: () => undefined,
	find: () => undefined,
	refresh: async () => {},
	refreshProvider: async () => {},
};

interface HubHarness {
	body(): string;
	lines(): string[];
	describe(): TspPickerProps;
	assigned: string[];
	compactionCalls: string[];
	key(data: string): void;
	/** Pick a browser model by its selector: a select (highlight) then an activate (commit). */
	pick(selector: string): void;
}

function createHub(setup: Setup): HubHarness {
	const assigned: string[] = [];
	const compactionCalls: string[] = [];
	const callbacks: ModelHubCallbacks = {
		onAssign: (_m, role, _t, selector) => {
			assigned.push(`${role}:${selector}`);
			return true;
		},
		onUnassign: () => {},
		onCancel: () => {},
		onCompactionModelChange: (selector, compactor) => {
			compactionCalls.push(`model:${selector}:${compactor}`);
		},
		onCompactionPointChange: () => {
			compactionCalls.push("point");
			return undefined;
		},
	};
	const scoped: ScopedModelItem[] = [{ model: parentModel }, { model: otherModel }];
	const hub = new ModelHubComponent(tuiStub, createSource(setup), registryStub, scoped, callbacks);
	const lines = () => hub.render(120).map(line => line.replace(ANSI_PATTERN, ""));
	return {
		body: () => lines().join("\n"),
		lines,
		describe: () => {
			const root = hub.describe(pickerCx);
			if (root.k !== "picker" || !root.p) throw new Error(`expected a picker root, got ${root.k}`);
			return root.p;
		},
		assigned,
		compactionCalls,
		key: (data: string) => hub.handleInput(data),
		pick: (selector: string) => {
			hub.handleNativeEvent({ type: "select", key: "", item: selector });
			hub.handleNativeEvent({ type: "activate", key: "", item: selector });
		},
	};
}

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";

/** Enter the Roles view: hop up to the Roles entry, then dive into its rows. */
function openRoles(key: (data: string) => void): void {
	key(UP);
	key(ENTER);
}

/** Press DOWN until the nav cursor sits on a rendered line that contains `needle`. */
function moveCursorTo(hub: HubHarness, needle: string): void {
	for (let i = 0; i < 40; i++) {
		if (hub.lines().some(l => l.includes(needle) && l.includes(theme.nav.cursor))) return;
		hub.key(DOWN);
	}
	throw new Error(`cursor never reached a row containing "${needle}"`);
}

/** The Roles footer line: its key hints name what the cursor's row offers. */
function footer(hub: HubHarness): string {
	const line = hub.lines().find(l => l.includes(" rows · "));
	if (!line) throw new Error("Roles footer not rendered");
	return line;
}

beforeAll(async () => {
	await initTheme(false);
});

describe("mcp roles nest under mcp", () => {
	const setup: Setup = {
		roles: { mcp: "anthropic/claude-sonnet", "mcp-lifeos": "@mcp", "mcp-trello": "openai/gpt-mini" },
		knownRoleIds: ["mcp", "mcp-lifeos", "mcp-trello"],
	};

	test("children render beneath mcp and not at the top level", () => {
		const hub = createHub(setup);
		openRoles(hub.key);
		const lines = hub.lines();
		const mcpAt = lines.findIndex(l => /\bmcp\b/.test(l) && !l.includes("↳"));
		const lifeosAt = lines.findIndex(l => l.includes("↳") && l.includes("lifeos:"));
		const trelloAt = lines.findIndex(l => l.includes("↳") && l.includes("trello:"));
		expect(mcpAt).toBeGreaterThanOrEqual(0);
		expect(lifeosAt).toBeGreaterThan(mcpAt);
		expect(trelloAt).toBeGreaterThan(lifeosAt);
		expect(hub.body()).toContain("lifeos: (itself)");
		expect(hub.body()).toContain("trello: openai/gpt-mini");
		const items = hub.describe().items ?? [];
		expect(items.filter(item => item.id === "childRole:mcp-lifeos")).toHaveLength(1);
		expect(items.some(item => item.id === "role:mcp-lifeos")).toBe(false);
		expect(hub.lines().filter(line => line.includes("lifeos"))).toHaveLength(1);
	});

	test("x on a child persists @mcp through the role callback", () => {
		const hub = createHub(setup);
		openRoles(hub.key);
		moveCursorTo(hub, "↳");
		hub.key("x");
		expect(hub.assigned).toContain("mcp-lifeos:@mcp");
	});

	test("enter on a child, then picking the parent's current model, persists that exact selector", () => {
		const hub = createHub({
			roles: { mcp: "anthropic/claude-sonnet", "mcp-lifeos": "anthropic/claude-sonnet" },
			knownRoleIds: ["mcp", "mcp-lifeos"],
		});
		openRoles(hub.key);
		moveCursorTo(hub, "↳ lifeos:");
		hub.key(ENTER);
		hub.pick("anthropic/claude-sonnet");
		expect(hub.assigned).toEqual(["mcp-lifeos:anthropic/claude-sonnet"]);
	});

	test("enter on a child, then picking a different model, persists that model's selector", () => {
		const hub = createHub({
			roles: { mcp: "anthropic/claude-sonnet", "mcp-lifeos": "anthropic/claude-sonnet" },
			knownRoleIds: ["mcp", "mcp-lifeos"],
		});
		openRoles(hub.key);
		moveCursorTo(hub, "↳ lifeos:");
		hub.key(ENTER);
		hub.pick("openai/gpt-mini");
		expect(hub.assigned).toEqual(["mcp-lifeos:openai/gpt-mini"]);
	});

	test("the All tab count equals the roles shown, top-level plus children", () => {
		const hub = createHub(setup);
		openRoles(hub.key);
		const props = hub.describe();
		const rows = props.items ?? [];
		const roles = rows.filter(row => /^(role|childRole):/.test(row.id ?? ""));
		expect(roles).toHaveLength(3);
		expect(props.tabs?.find(tab => tab.id === "all")?.count).toBe(roles.length);
		expect(props.total).toBe(rows.length);
	});

	test("a child's picker row is labelled with its full role id and shows its value", () => {
		const hub = createHub(setup);
		openRoles(hub.key);
		const items = hub.describe().items ?? [];
		const lifeos = items.find(item => item.id === "childRole:mcp-lifeos");
		const trello = items.find(item => item.id === "childRole:mcp-trello");
		expect(lifeos?.label).toBe("mcp-lifeos");
		expect(lifeos?.detail).toBe("(itself)");
		expect(trello?.detail).toBe("openai/gpt-mini");
	});

	test("a child under a project default shows the merged selector, not (itself)", () => {
		const hub = createHub({
			roles: { mcp: "anthropic/claude-sonnet", "mcp-lifeos": "@mcp" },
			maskedRoles: { "mcp-trello": "openai-codex/gpt-6-luna:auto" },
			knownRoleIds: ["mcp", "mcp-lifeos", "mcp-trello"],
		});
		openRoles(hub.key);
		expect(hub.body()).toContain("trello: openai-codex/gpt-6-luna:auto");
		const trello = (hub.describe().items ?? []).find(item => item.id === "childRole:mcp-trello");
		expect(trello?.detail).toBe("openai-codex/gpt-6-luna:auto");
	});

	test("activating a browser model lists mcp-lifeos in the model browser's role strip", () => {
		const hub = createHub(setup);
		hub.pick("anthropic/claude-sonnet");
		expect(JSON.stringify(hub.describe().strip)).toContain("mcp-lifeos");
	});

	test("with mcp absent, mcp-* roles render at the top level", () => {
		const hub = createHub({ roles: { "mcp-lifeos": "@mcp" }, knownRoleIds: ["mcp-lifeos"] });
		openRoles(hub.key);
		expect(hub.body()).toContain("mcp-lifeos");
		expect(hub.body()).not.toContain("↳");
	});

	test("with mcp hidden, mcp-* roles render at the top level", () => {
		const hub = createHub({
			roles: { mcp: "anthropic/claude-sonnet", "mcp-lifeos": "@mcp" },
			knownRoleIds: ["mcp", "mcp-lifeos"],
			hiddenRoles: ["mcp"],
		});
		openRoles(hub.key);
		expect(hub.body()).toContain("mcp-lifeos");
		expect(hub.body()).not.toContain("↳");
	});

	test("mcp and its children offer no compactor or compaction-limit key, and m and k change nothing", () => {
		const hub = createHub(setup);
		openRoles(hub.key);
		for (const needle of ["mcp", "↳ lifeos:"]) {
			moveCursorTo(hub, needle);
			expect(footer(hub)).not.toContain("compactor");
			expect(footer(hub)).not.toContain("compaction limit");
			hub.key("m");
			hub.key("k");
		}
		expect(hub.body()).not.toContain("compaction:");
		expect(hub.compactionCalls).toEqual([]);
		expect(hub.assigned).toEqual([]);
	});

	test("positive control: a non-mcp role with a model keeps its compaction sub-row and compactor key", () => {
		const hub = createHub({ roles: { default: "anthropic/claude-sonnet" }, knownRoleIds: ["default"] });
		openRoles(hub.key);
		expect(hub.body()).toContain("compaction:");
		moveCursorTo(hub, "default");
		expect(footer(hub)).toContain("compactor");
	});

	test("the Chat and Kinds tab counts place a child under its parent's section", () => {
		const hub = createHub({ ...setup, sections: { "mcp-lifeos": "kind" } });
		openRoles(hub.key);
		const tabs = hub.describe().tabs ?? [];
		expect(tabs.find(tab => tab.id === "chat")?.count).toBe(3);
		expect(tabs.find(tab => tab.id === "kind")?.count).toBe(0);
	});

	test("submitting an existing child's name in the New role strip creates no role", () => {
		const hub = createHub(setup);
		openRoles(hub.key);
		moveCursorTo(hub, "+ New role");
		hub.key(ENTER);
		for (const char of "mcp-lifeos") hub.key(char);
		hub.key(ENTER);
		expect(hub.assigned).toEqual([]);
		expect(hub.describe().strip).not.toBeNull();
	});

	test("the Roles sidebar annotation counts children as assigned and visible", () => {
		const hub = createHub(setup);
		expect(hub.body()).toMatch(/Roles\s+3\/3/);
	});

	test("with mcp assigned, a child's footer offers the x inherit hint", () => {
		const hub = createHub(setup);
		openRoles(hub.key);
		moveCursorTo(hub, "↳ lifeos:");
		expect(footer(hub)).toContain("use mcp");
	});

	test("with mcp unassigned, a child's footer has no x inherit hint", () => {
		const hub = createHub({
			roles: { "mcp-lifeos": "@mcp" },
			knownRoleIds: ["mcp", "mcp-lifeos"],
			unresolvedRoles: ["mcp"],
		});
		openRoles(hub.key);
		moveCursorTo(hub, "↳ lifeos:");
		expect(footer(hub)).toContain("assign");
		expect(footer(hub)).not.toContain("use mcp");
	});
});
