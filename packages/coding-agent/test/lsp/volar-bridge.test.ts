import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import {
	ensureFileOpen,
	getOrCreateClient,
	sendRequest,
	shutdownAll,
	syncContent,
} from "@oh-my-pi/pi-coding-agent/lsp/client";
import { getConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import { fileToUri } from "@oh-my-pi/pi-coding-agent/lsp/utils";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";
import {
	createVueProject,
	restoreIsolatedPath,
	type VueProject,
	type VueProjectOptions,
} from "../helpers/vue-lsp-project";

const lspTestSettings = Settings.isolated();
const tempDirs: TempDir[] = [];

/** Minimal LSP tool session: cwd plus the settings every domain setting reads. */
function makeLspSession(cwd: string): ToolSession {
	return { cwd, settings: lspTestSettings } as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

interface CompanionState {
	initializationOptions: {
		plugins?: Array<{ name?: string; location?: string; languages?: string[] }>;
		tsserver?: { path?: string };
	} | null;
	languageIds: Record<string, string>;
	documents: Record<string, { version: number; text: string }>;
	requests: string[];
}

function companionConfig(dir: string): ServerConfig {
	const config = getConfig(dir).servers["typescript-language-server"];
	expect(config).toBeDefined();
	return config;
}

async function companionState(dir: string): Promise<CompanionState> {
	const client = await getOrCreateClient(companionConfig(dir), dir, 5_000);
	return (await sendRequest(client, "test/state", {}, undefined, 5_000)) as CompanionState;
}

function createProject(options: VueProjectOptions = {}): VueProject {
	const project = createVueProject(options);
	tempDirs.push(project.tempDir);
	return project;
}

afterEach(async () => {
	await shutdownAll();
	for (const tempDir of tempDirs.splice(0)) await tempDir.remove();
	restoreIsolatedPath();
});

describe("Volar tsserver bridge", () => {
	it("serves document symbols from Volar and its TypeScript-backed actions from the companion", async () => {
		const { dir, appVue } = createProject({ localTypescript: true });
		const tool = new LspTool(makeLspSession(dir));

		const symbols = await tool.execute("vue-symbols", { action: "symbols", file: appVue });
		expect(symbols.details?.serverName).toBe("vue-language-server");
		expect(textOf(symbols)).toContain("volar:App.vue");

		// Volar's own language service has no TypeScript plugin, so these are the
		// plugin host's answers — the same split VSCode's TS extension provides.
		const definition = await tool.execute("vue-definition", {
			action: "definition",
			file: appVue,
			line: 2,
			symbol: "title",
		});
		expect(definition.details?.serverName).toBe("typescript-language-server");
		expect(textOf(definition)).toContain("Found 1 definition(s)");

		const references = await tool.execute("vue-references", {
			action: "references",
			file: appVue,
			line: 2,
			symbol: "title",
		});
		expect(references.details?.serverName).toBe("typescript-language-server");
		expect(textOf(references)).toContain("Found 2 reference(s)");

		const hover = await tool.execute("vue-hover", { action: "hover", file: appVue, line: 2, symbol: "title" });
		expect(hover.details?.serverName).toBe("typescript-language-server");
		expect(textOf(hover)).toContain("via tsserver for");
	});

	it("forwards documentSymbol, definition, references and hover from Volar through the bridge", async () => {
		const { dir, appVue } = createProject({ localTypescript: true });
		const volar = await getOrCreateClient(getConfig(dir).servers["vue-language-server"], dir, 5_000);
		const uri = fileToUri(appVue);
		const position = { line: 1, character: 4 };

		const symbols = (await sendRequest(
			volar,
			"textDocument/documentSymbol",
			{ textDocument: { uri } },
			undefined,
			10_000,
		)) as Array<{ name: string }>;
		expect(symbols[0]?.name).toBe("volar:App.vue");

		const definition = (await sendRequest(
			volar,
			"textDocument/definition",
			{ textDocument: { uri }, position },
			undefined,
			10_000,
		)) as Array<{ uri: string }>;
		expect(definition).toHaveLength(1);

		const references = (await sendRequest(
			volar,
			"textDocument/references",
			{ textDocument: { uri }, position, context: { includeDeclaration: true } },
			undefined,
			10_000,
		)) as Array<{ uri: string }>;
		expect(references).toHaveLength(2);

		const hover = (await sendRequest(
			volar,
			"textDocument/hover",
			{ textDocument: { uri }, position },
			undefined,
			10_000,
		)) as { contents: { value: string } };
		expect(hover.contents.value).toBe(`via volar for ${uri}`);

		// Every answer above travelled through `workspace/executeCommand` on TypeScript.
		const state = await companionState(dir);
		expect(state.requests.filter(method => method === "workspace/executeCommand")).toHaveLength(4);
	});

	it("opens the same .vue document in the companion so tsserver knows the component", async () => {
		const { dir, appVue } = createProject({ localTypescript: true });
		await new LspTool(makeLspSession(dir)).execute("vue-symbols", { action: "symbols", file: appVue });

		const state = await companionState(dir);
		expect(state.languageIds[fileToUri(appVue)]).toBe("vue");
	});

	it("forwards the unsaved didOpen text and version Volar received to the companion", async () => {
		const { dir, appVue } = createProject({ localTypescript: true });
		const volar = await getOrCreateClient(getConfig(dir).servers["vue-language-server"], dir, 5_000);
		const unsaved = '<script setup lang="ts">\nconst title = ref("unsaved");\n</script>\n';

		// `syncContent` hands Volar in-memory text the disk copy does not have; the
		// companion must be opened with that text and the version Volar was given,
		// not with a re-read of the file.
		await syncContent(volar, appVue, unsaved);

		const state = await companionState(dir);
		expect(state.documents[fileToUri(appVue)]).toEqual({ version: 1, text: unsaved });
	});

	it("configures the companion with the Vue tsserver plugin and the project TypeScript", async () => {
		const { dir } = createProject({ localTypescript: true });
		await new LspTool(makeLspSession(dir)).execute("vue-symbols", {
			action: "symbols",
			file: path.join(dir, "App.vue"),
		});

		const state = await companionState(dir);
		const plugin = state.initializationOptions?.plugins?.[0];
		expect(plugin).toEqual({
			name: "@vue/typescript-plugin",
			location: path.join(dir, "node_modules", "@vue", "typescript-plugin"),
			languages: ["vue"],
		});
		expect(state.initializationOptions?.tsserver?.path).toBe(
			path.join(dir, "node_modules", "typescript", "lib", "tsserver.js"),
		);
	});

	it("leaves a non-Vue project's TypeScript server without Vue plugin options", async () => {
		const { dir } = createProject({ vue: false, localTypescript: true });

		const config = companionConfig(dir);
		expect(getConfig(dir).servers["vue-language-server"]).toBeUndefined();
		const client = await getOrCreateClient(config, dir, 5_000);
		const state = (await sendRequest(client, "test/state", {}, undefined, 5_000)) as CompanionState;
		expect(state.initializationOptions?.plugins).toBeUndefined();
	});

	it("answers null without hanging when no TypeScript companion can be wired", async () => {
		// TypeScript 7 only: `tsc --lsp` replaces the wrapper, and no tsserver.js exists
		// for the bridge to drive — the exact host layout that used to hang Volar.
		const { dir, appVue } = createProject({ typescript: "none" });
		expect(getConfig(dir).servers["typescript-language-server"]).toBeUndefined();
		const tool = new LspTool(makeLspSession(dir));

		const started = Date.now();
		const result = await tool.execute("vue-no-ts", { action: "symbols", file: appVue, timeout: 20 });
		const elapsed = Date.now() - started;

		const output = textOf(result);
		expect(elapsed).toBeLessThan(5_000);
		expect(output).toContain("No symbols found");
		expect(output).toContain("typescript-language-server");
		expect(output).toContain("TypeScript 7");
	});

	it("starts the companion for a request that arrives before it is running", async () => {
		const { dir, appVue } = createProject({ typescript: "slow-typescript", localTypescript: true });
		const volar = await getOrCreateClient(getConfig(dir).servers["vue-language-server"], dir, 5_000);
		expect(getConfig(dir).servers["typescript-language-server"]).toBeDefined();

		// No document is opened first: the bridge itself has to bring TypeScript up,
		// and must not answer null while that cold start is in flight.
		const started = Date.now();
		const result = (await sendRequest(
			volar,
			"textDocument/documentSymbol",
			{ textDocument: { uri: fileToUri(appVue) } },
			undefined,
			10_000,
		)) as unknown[];
		const elapsed = Date.now() - started;

		expect(elapsed).toBeGreaterThanOrEqual(350);
		expect(result).toEqual([
			{
				name: "volar:App.vue",
				kind: 12,
				range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
				selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
			},
		]);
	});

	it("ignores a malformed tsserver/request instead of forwarding it", async () => {
		const { dir, appVue } = createProject({ volar: "volar-malformed", localTypescript: true });
		const volar = await getOrCreateClient(getConfig(dir).servers["vue-language-server"], dir, 5_000);

		const result = (await sendRequest(
			volar,
			"textDocument/definition",
			{ textDocument: { uri: fileToUri(appVue) } },
			undefined,
			10_000,
		)) as Array<{ uri: string }>;

		// The valid request behind the malformed one was still answered…
		expect(result[0]?.uri).toBe(fileToUri(appVue));
		// …and TypeScript was asked exactly once: the malformed entry never reached it.
		const state = await companionState(dir);
		expect(state.requests.filter(method => method === "workspace/executeCommand")).toHaveLength(1);
	});

	it("answers a mixed batch entry by entry and forwards only the usable siblings", async () => {
		const { dir, appVue } = createProject({ volar: "volar-mixed", localTypescript: true });
		const volar = await getOrCreateClient(getConfig(dir).servers["vue-language-server"], dir, 5_000);

		const result = (await sendRequest(
			volar,
			"textDocument/definition",
			{ textDocument: { uri: fileToUri(appVue) } },
			undefined,
			10_000,
		)) as Array<{ uri: string }>;
		expect(result[0]?.uri).toBe(fileToUri(appVue));

		// One forward: the two entries with an id but no command were answered `null`
		// in place, and the entry without an id was dropped.
		const companion = await companionState(dir);
		expect(companion.requests.filter(method => method === "workspace/executeCommand")).toHaveLength(1);
		const volarState = (await sendRequest(volar, "test/state", {}, undefined, 5_000)) as {
			tsserverResponses: Array<Array<[unknown, unknown]>>;
		};
		const batch = volarState.tsserverResponses.at(-1);
		expect(batch).toHaveLength(3);
		expect(batch?.slice(0, 2).map(([, body]) => body)).toEqual([null, null]);
		expect(batch?.[2]?.[1]).not.toBeNull();
	});

	it("re-opens the .vue document after its TypeScript companion restarts", async () => {
		const { dir, appVue } = createProject({ localTypescript: true });
		const config = getConfig(dir);
		const volar = await getOrCreateClient(config.servers["vue-language-server"], dir, 5_000);
		const companion = await getOrCreateClient(config.servers["typescript-language-server"], dir, 5_000);
		await ensureFileOpen(volar, appVue);
		expect((await companionState(dir)).languageIds[fileToUri(appVue)]).toBe("vue");

		// The companion process dies: the mirrored document goes with it.
		companion.proc.kill();
		await companion.proc.exited.catch(() => {});

		// Volar's next type query must still be answered: the bridge starts a fresh
		// companion and hands it the document Volar already tracks.
		const result = (await sendRequest(
			volar,
			"textDocument/definition",
			{ textDocument: { uri: fileToUri(appVue) } },
			undefined,
			10_000,
		)) as Array<{ uri: string }>;
		expect(result[0]?.uri).toBe(fileToUri(appVue));

		const restarted = await getOrCreateClient(config.servers["typescript-language-server"], dir, 5_000);
		expect(restarted).not.toBe(companion);
		const state = (await sendRequest(restarted, "test/state", {}, undefined, 5_000)) as CompanionState;
		expect(state.languageIds[fileToUri(appVue)]).toBe("vue");
	});

	it("says the plugin is missing in .vue results when @vue/typescript-plugin cannot be found", async () => {
		const { dir, appVue } = createProject({ localTypescript: true, vuePlugin: false });
		expect(getConfig(dir).servers["vue-language-server"].vueCompanionIssue).toContain("@vue/typescript-plugin");

		const result = await new LspTool(makeLspSession(dir)).execute("vue-definition", {
			action: "definition",
			file: appVue,
			line: 2,
			symbol: "title",
		});
		const output = textOf(result);
		// The companion still answers; the note explains why type results are empty.
		expect(output).toContain("note: ");
		expect(output).toContain("@vue/typescript-plugin");
	});

	it("restores the TypeScript wrapper on a TypeScript 7 host when the project pins a tsserver", async () => {
		// Global `tsc` is TypeScript 7 (no tsserver.js), but the project has TypeScript
		// 5.9 in node_modules: the Vue workspace must still get a wrapper that can
		// answer Volar, pinned to the project's tsserver.
		const { dir, appVue } = createProject({ localTypescript: true, tscOnPath: true });
		const config = getConfig(dir);
		// The restored wrapper is the workspace's only TypeScript server: `tsc --lsp`
		// would answer every `.ts` request a second time.
		expect(config.servers["typescript-native"]).toBeUndefined();
		const companion = companionConfig(dir);
		expect(companion.initOptions?.tsserver).toEqual({
			path: path.join(dir, "node_modules", "typescript", "lib", "tsserver.js"),
		});

		const tool = new LspTool(makeLspSession(dir));
		const symbols = await tool.execute("vue-symbols", { action: "symbols", file: appVue });
		expect(textOf(symbols)).toContain("volar:App.vue");
	});
});
