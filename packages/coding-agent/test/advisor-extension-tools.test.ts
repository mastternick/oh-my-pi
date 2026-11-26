/**
 * A roster that grants a plugin tool (`ctx_memory`) must get it even when the
 * plugin registers late: interactive startup defers `deferrable` extensions
 * (Magic Context is one), so the advisor slate is built before their tools
 * exist. Slates also capture a suspended extension's definition, so a
 * suspension toggle has to rebuild them too.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const MEMORY_PLUGIN = `
	export default function(pi) {
		pi.registerTool({
			name: "ctx_memory",
			label: "Memory",
			description: "write a memory",
			parameters: pi.arktype({ text: pi.arktype("string") }),
			execute: async () => ({ content: [{ type: "text", text: "stored" }], details: {} }),
		});
	}
`;

describe("advisor extension tool grants", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	let tempDir: TempDir;
	let session: AgentSession | undefined;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(() => {
		authStorage.close();
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@omp-advisor-ext-tools-");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		tempDir.removeSync();
	});

	function advisorToolNames(): string[] {
		const advisor = session?.getAdvisorAgent();
		if (!advisor) throw new Error("Expected the advisor to be live");
		return advisor.state.tools.map(tool => tool.name);
	}

	async function writeRoster(cwd: string, tools: string[] = ["read", "ctx_memory"]): Promise<void> {
		// `.git` bounds WATCHDOG discovery here instead of walking to the real home dir.
		await fs.mkdir(path.join(cwd, ".git"), { recursive: true });
		await Bun.write(
			path.join(cwd, "WATCHDOG.yml"),
			["advisors:", "  - name: Session coach", `    tools: [${tools.join(", ")}]`].join("\n"),
		);
	}

	async function createAdvisedSession(
		cwd: string,
		options: { deferredExtensionPaths?: string[]; preloadedExtensionPath?: string } = {},
	): Promise<AgentSession> {
		const eventBus = new EventBus();
		const settings = Settings.isolated({ "advisor.enabled": true, "compaction.enabled": false });
		settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		await settings.reloadForCwd(cwd);
		// One eager extension is always preloaded: it supplies the shared extension
		// runtime the deferred loader needs, and keeps discovery out of the test.
		const eagerPath = path.join(cwd, "eager-plugin.ts");
		if (!options.preloadedExtensionPath) await Bun.write(eagerPath, "export default function() {}\n");
		const preloaded = await loadExtensions([options.preloadedExtensionPath ?? eagerPath], cwd, eventBus);
		const result = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: SessionManager.inMemory(cwd),
			authStorage,
			modelRegistry,
			settings,
			model,
			eventBus,
			preloadedExtensions: preloaded,
			...(options.deferredExtensionPaths ? { deferredExtensionPaths: options.deferredExtensionPaths } : {}),
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		return result.session;
	}

	it("rebuilds a live advisor when a startup-deferred extension registers its granted tool", async () => {
		const cwd = tempDir.path();
		await writeRoster(cwd);
		const deferredPath = path.join(cwd, "memory-plugin.ts");
		await Bun.write(deferredPath, MEMORY_PLUGIN);

		session = await createAdvisedSession(cwd, { deferredExtensionPaths: [deferredPath] });
		// Built before the deferred plugin loaded: the grant resolves to nothing yet.
		expect(advisorToolNames()).toContain("read");
		expect(advisorToolNames()).not.toContain("ctx_memory");

		await session.loadDeferredExtensions();

		// The registration rebuilt the roster, so the coach now holds the tool…
		expect(advisorToolNames()).toContain("ctx_memory");
		// …and it is callable, not just listed.
		const memoryTool = session.getAdvisorAgent()!.state.tools.find(tool => tool.name === "ctx_memory")!;
		const result = await memoryTool.execute("advisor-memory", { text: "lesson" });
		expect(result.content).toEqual([{ type: "text", text: "stored" }]);
	});

	it("rebuilds a live advisor when its granted extension tool is suspended and resumed", async () => {
		const cwd = tempDir.path();
		await writeRoster(cwd);
		const pluginPath = path.join(cwd, "memory-plugin.ts");
		await Bun.write(pluginPath, MEMORY_PLUGIN);

		session = await createAdvisedSession(cwd, { preloadedExtensionPath: pluginPath });
		expect(advisorToolNames()).toContain("ctx_memory");

		const runner = session.extensionRunner;
		if (!runner) throw new Error("Expected an extension runner");
		runner.setSuspendedExtensions(() => true);
		expect(advisorToolNames()).not.toContain("ctx_memory");

		runner.setSuspendedExtensions(() => false);
		expect(advisorToolNames()).toContain("ctx_memory");
	});

	it("notices a grant nothing provides once the deferred plugins have loaded", async () => {
		const cwd = tempDir.path();
		// `ctx_notee` is a stale grant (a typo): nothing ever registers it.
		await writeRoster(cwd, ["read", "ctx_memory", "ctx_notee"]);
		const deferredPath = path.join(cwd, "memory-plugin.ts");
		await Bun.write(deferredPath, MEMORY_PLUGIN);

		session = await createAdvisedSession(cwd, { deferredExtensionPaths: [deferredPath] });
		const notices: string[] = [];
		const emitNotice = spyOn(session, "emitNotice").mockImplementation((_level, message) => {
			notices.push(message);
		});
		try {
			await session.loadDeferredExtensions();
		} finally {
			emitNotice.mockRestore();
		}

		expect(notices.filter(message => message.includes('"ctx_notee"'))).toHaveLength(1);
		// The deferred plugin's tool resolved, so only the stale grant is reported.
		expect(notices.filter(message => message.includes('"ctx_memory"'))).toEqual([]);
	});
});
