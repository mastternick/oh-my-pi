import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { YAML } from "bun";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Explicit-only model routing at startup.
 *
 * A configured `default` role (and every other configured role) is
 * authoritative: when its model cannot serve, startup reports the failure
 * instead of picking an unrelated catalog/provider default. Only an
 * unconfigured default role (fresh install) bootstraps from the first
 * available provider default.
 */

const LOCAL_PROVIDER = "loopback";
const LOCAL_MODEL = `${LOCAL_PROVIDER}/small-model`;

function emptyWorkspaceTree(cwd: string) {
	return { rootPath: cwd, rendered: ".\n", truncated: false, totalLines: 1, agentsMdFiles: [] };
}

function providerModelsYaml() {
	return JSON.stringify({
		providers: {
			[LOCAL_PROVIDER]: {
				baseUrl: "http://127.0.0.1:9/v1",
				api: "openai-completions",
				auth: "none",
				models: [
					{
						id: "small-model",
						name: "Small Model",
						reasoning: false,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 131072,
						maxTokens: 1024,
					},
				],
			},
		},
	});
}

describe("explicit-only startup model routing", () => {
	let testDir: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		resetSettingsForTest();
		testDir = path.join(os.tmpdir(), `omp-explicit-routing-${Snowflake.next()}`);
		agentDir = path.join(testDir, "agent");
		cwd = path.join(testDir, "work");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(cwd, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "models.yml"), providerModelsYaml());
	});

	afterEach(() => {
		resetSettingsForTest();
		// `Settings.init` opened `<agentDir>/agent.db`; Windows cannot delete it while open.
		AgentStorage.close();
		if (fs.existsSync(testDir)) removeSyncWithRetries(testDir);
	});

	async function start(config: Record<string, unknown>) {
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify(config));
		const settings = await Settings.init({ cwd, agentDir });
		const authStorage = await AuthStorage.create(":memory:");
		const modelRegistry = new ModelRegistry(authStorage, path.join(agentDir, "models.yml"));
		try {
			const { session, modelFallbackMessage } = await createAgentSession({
				cwd,
				agentDir,
				authStorage,
				modelRegistry,
				settings,
				sessionManager: SessionManager.inMemory(),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				workspaceTree: emptyWorkspaceTree(cwd),
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
			});
			return { session, modelFallbackMessage };
		} finally {
			authStorage.close();
		}
	}

	test("does not substitute another model when the configured default does not exist", async () => {
		const { session, modelFallbackMessage } = await start({
			modelRoles: { default: "ghost/missing-model" },
		});
		try {
			expect(session.model).toBeUndefined();
			expect(modelFallbackMessage).toContain("Default model ghost/missing-model not found");
		} finally {
			await session.dispose();
		}
	});

	test("does not substitute another model when the configured default has no credentials", async () => {
		const { session, modelFallbackMessage } = await start({
			modelRoles: { default: "anthropic/claude-sonnet-4-5" },
		});
		try {
			expect(session.model).toBeUndefined();
			expect(modelFallbackMessage).toContain("Default model anthropic/claude-sonnet-4-5 is unavailable");
		} finally {
			await session.dispose();
		}
	});

	test("starts on the default role's own configured chain when the primary is unavailable", async () => {
		const { session, modelFallbackMessage } = await start({
			modelRoles: { default: "ghost/missing-model" },
			retry: { fallbackChains: { default: [LOCAL_MODEL] } },
		});
		try {
			expect(`${session.model?.provider}/${session.model?.id}`).toBe(LOCAL_MODEL);
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});

	test("bootstraps from an available provider default when the default role is unconfigured", async () => {
		const { session, modelFallbackMessage } = await start({ enabledModels: [LOCAL_MODEL] });
		try {
			expect(`${session.model?.provider}/${session.model?.id}`).toBe(LOCAL_MODEL);
			expect(modelFallbackMessage).toBeUndefined();
		} finally {
			await session.dispose();
		}
	});
});
