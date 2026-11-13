import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { LspTool } from "@oh-my-pi/pi-coding-agent/lsp";
import { getOrCreateClient, sendRequest, shutdownAll } from "@oh-my-pi/pi-coding-agent/lsp/client";
import { getConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const fixturePath = path.join(import.meta.dir, "..", "fixtures", "fake-lsp-server.ts");
const lspTestSettings = Settings.isolated();
const tempDirs: TempDir[] = [];

function makeLspSession(cwd: string): ToolSession {
	return { cwd, settings: lspTestSettings } as ToolSession;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map(block => (block.type === "text" ? (block.text ?? "") : "")).join("\n");
}

interface ServerState {
	requests: string[];
	initializeCount: number;
}

/** PATH of the previous test; restored when the test ends. */
let previousPath: string | undefined;

/** A project whose language servers are the fixture roles named in `servers`. */
function createWorkspace(servers: Record<string, string>): string {
	const tempDir = TempDir.createSync("@omp-workspace-symbol-");
	tempDirs.push(tempDir);
	const dir = tempDir.path();
	fs.writeFileSync(path.join(dir, "package.json"), '{"name":"symbol-fixture","private":true}\n');
	const config = {
		servers: Object.fromEntries(
			Object.entries(servers).map(([name, mode]) => [
				name,
				{
					command: process.execPath,
					args: [fixturePath, mode],
					fileTypes: [".ts"],
					rootMarkers: ["package.json"],
				},
			]),
		),
	};
	fs.writeFileSync(path.join(dir, "lsp.json"), JSON.stringify(config, null, 2));
	// Only the servers above: a TypeScript installed on the host would otherwise be
	// discovered from package.json alone and answer the same query.
	previousPath ??= process.env.PATH;
	process.env.PATH = "/usr/bin:/bin";
	return dir;
}

async function serverState(dir: string, serverName: string): Promise<ServerState> {
	const serverConfig = getConfig(dir).servers[serverName];
	expect(serverConfig).toBeDefined();
	const client = await getOrCreateClient(serverConfig, dir, 5_000);
	return (await sendRequest(client, "test/state", {}, undefined, 5_000)) as ServerState;
}

afterEach(async () => {
	await shutdownAll();
	for (const tempDir of tempDirs.splice(0)) await tempDir.remove();
	if (previousPath !== undefined) process.env.PATH = previousPath;
	previousPath = undefined;
});

describe("workspace/symbol aggregation", () => {
	it("asks only servers that advertise the capability and reports the others compactly", async () => {
		const dir = createWorkspace({ plain: "default", symbols: "typescript" });

		const result = await new LspTool(makeLspSession(dir)).execute("symbols", {
			action: "symbols",
			file: "*",
			query: "Target",
		});
		const output = textOf(result);
		expect(result.details?.success).toBe(true);
		expect(output).toContain("Symbol_Target");
		expect(output).toContain("plain: workspace/symbol not implemented");
		// A server without the capability is never asked.
		expect((await serverState(dir, "plain")).requests).not.toContain("workspace/symbol");
		expect((await serverState(dir, "symbols")).requests).toContain("workspace/symbol");
	});

	it("maps a -32601 answer to the same compact line and drops its stack trace", async () => {
		const dir = createWorkspace({ broken: "broken-symbol", symbols: "typescript" });

		const output = textOf(
			await new LspTool(makeLspSession(dir)).execute("symbols", {
				action: "symbols",
				file: "*",
				query: "Target",
			}),
		);
		expect(output).toContain("Symbol_Target");
		expect(output).toContain("broken: workspace/symbol not implemented");
		expect(output).not.toContain("at Volar.symbols");
		expect(output).not.toContain("Method not found");
	});

	it("keeps only the first line of a genuine server failure", async () => {
		const dir = createWorkspace({ failing: "symbol-error", symbols: "typescript" });

		const output = textOf(
			await new LspTool(makeLspSession(dir)).execute("symbols", {
				action: "symbols",
				file: "*",
				query: "Target",
			}),
		);
		expect(output).toContain("Symbol_Target");
		expect(output).toContain("Server failures:");
		expect(output).toContain("failing: LSP error -32603: Internal error: symbol index rebuild failed");
		expect(output).not.toContain("at Index.query");
	});

	it("asks a server that registered workspace/symbol dynamically", async () => {
		const dir = createWorkspace({ dynamic: "dynamic-symbol", symbols: "typescript" });
		const dynamic = await getOrCreateClient(getConfig(dir).servers.dynamic, dir, 5_000);
		// The fixture registers the capability as a client request; the reader applies
		// it before answering, so this reply proves the registration landed.
		await sendRequest(dynamic, "test/registerSymbols", {}, undefined, 5_000);
		expect([...(dynamic.dynamicCapabilityRegistrations?.values() ?? [])]).toContain("workspace/symbol");

		const output = textOf(
			await new LspTool(makeLspSession(dir)).execute("symbols", {
				action: "symbols",
				file: "*",
				query: "Target",
			}),
		);
		expect(output).toContain("Symbol_Target");
		expect(output).not.toContain("dynamic: workspace/symbol not implemented");
		expect((await serverState(dir, "dynamic")).requests).toContain("workspace/symbol");
	});

	it("says so when no server implements workspace/symbol", async () => {
		const dir = createWorkspace({ plain: "default" });

		const result = await new LspTool(makeLspSession(dir)).execute("symbols", {
			action: "symbols",
			file: "*",
			query: "Target",
		});
		const output = textOf(result);
		expect(result.details?.success).toBe(false);
		expect(output).toContain("not implemented by any configured language server");
		expect(output).toContain("plain: workspace/symbol not implemented");
	});
});
