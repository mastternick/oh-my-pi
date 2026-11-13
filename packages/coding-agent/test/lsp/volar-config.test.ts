import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ServerConfig } from "@oh-my-pi/pi-coding-agent/lsp/types";
import {
	attachVueCompanions,
	findTsserverInTree,
	resolveVueCompanionConfig,
	resolveVueTsPluginLocation,
	supportsTsserverRequest,
} from "@oh-my-pi/pi-coding-agent/lsp/volar";
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];

function tempDir(): string {
	const dir = TempDir.createSync("@omp-volar-config-");
	tempDirs.push(dir);
	return dir.path();
}

function write(file: string, content = ""): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

function serverConfig(overrides: Partial<ServerConfig> & { command: string }): ServerConfig {
	return { fileTypes: [".vue"], rootMarkers: [], args: [], ...overrides };
}

const VUE_PLUGIN = path.join("node_modules", "@vue", "typescript-plugin");

afterEach(async () => {
	for (const tempDirPath of tempDirs.splice(0)) await tempDirPath.remove();
});

describe("resolveVueTsPluginLocation", () => {
	it("finds the plugin beside the language server in an npm install", () => {
		const dir = tempDir();
		write(path.join(dir, VUE_PLUGIN, "package.json"), "{}");
		write(path.join(dir, "node_modules", ".bin", "vue-language-server"), "#!/bin/sh\n");

		expect(resolveVueTsPluginLocation(path.join(dir, "node_modules", ".bin", "vue-language-server"))).toBe(
			path.join(dir, VUE_PLUGIN),
		);
	});

	it("finds a plugin nested under the language server package", () => {
		const dir = tempDir();
		const serverBin = path.join(dir, "node_modules", "@vue", "language-server", "bin", "vue-language-server.js");
		write(serverBin);
		write(path.join(dir, "node_modules", "@vue", "language-server", VUE_PLUGIN, "package.json"), "{}");

		expect(resolveVueTsPluginLocation(serverBin)).toBe(
			path.join(dir, "node_modules", "@vue", "language-server", VUE_PLUGIN),
		);
	});

	it("returns undefined when the binary is outside such a tree", () => {
		const dir = tempDir();
		const wrapper = path.join(dir, "bin", "vue-language-server");
		write(wrapper, "#!/bin/sh\n");
		expect(resolveVueTsPluginLocation(wrapper)).toBeUndefined();
	});
});

describe("resolveVueCompanionConfig", () => {
	it("pins the project TypeScript and wires the plugin in", () => {
		const dir = tempDir();
		write(path.join(dir, VUE_PLUGIN, "package.json"), "{}");
		write(path.join(dir, "node_modules", "@vue", "language-server", "package.json"), "{}");
		const tsserver = path.join(dir, "node_modules", "typescript", "lib", "tsserver.js");
		write(tsserver);
		const vueCommand = path.join(dir, "node_modules", "@vue", "language-server", "bin", "vue-language-server.js");
		write(vueCommand);

		const resolution = resolveVueCompanionConfig({
			cwd: dir,
			vueConfig: serverConfig({ command: vueCommand, resolvedCommand: vueCommand }),
			typescriptConfig: serverConfig({
				command: "typescript-language-server",
				initOptions: { hostInfo: "omp", plugins: [{ name: "other-plugin", location: "/other" }] },
			}),
		});

		expect(resolution.issue).toBeUndefined();
		expect(resolution.config?.initOptions).toEqual({
			hostInfo: "omp",
			tsserver: { path: tsserver },
			plugins: [
				{ name: "other-plugin", location: "/other" },
				{ name: "@vue/typescript-plugin", location: path.join(dir, VUE_PLUGIN), languages: ["vue"] },
			],
		});
	});

	it("honours an explicit plugin override", () => {
		const dir = tempDir();
		const tsserver = path.join(dir, "node_modules", "typescript", "lib", "tsserver.js");
		write(tsserver);

		const resolution = resolveVueCompanionConfig({
			cwd: dir,
			vueConfig: serverConfig({
				command: "vue-language-server",
				vueTsPlugin: { location: "/custom/vue-plugin", name: "@vue/typescript-plugin", languages: ["vue", "ts"] },
			}),
			typescriptConfig: serverConfig({ command: "typescript-language-server" }),
		});

		expect(resolution.config?.initOptions?.plugins).toEqual([
			{ name: "@vue/typescript-plugin", location: "/custom/vue-plugin", languages: ["vue", "ts"] },
		]);
	});

	it("keeps the companion but injects nothing when disabled", () => {
		const dir = tempDir();
		write(path.join(dir, "node_modules", "typescript", "lib", "tsserver.js"));

		const resolution = resolveVueCompanionConfig({
			cwd: dir,
			vueConfig: serverConfig({ command: "vue-language-server", vueTsPlugin: false }),
			typescriptConfig: serverConfig({ command: "typescript-language-server" }),
		});

		expect(resolution.config).toBeDefined();
		expect(resolution.config?.initOptions?.plugins).toBeUndefined();
	});

	it("reports a wrapper that has no tsserver-capable TypeScript", () => {
		const dir = tempDir();
		const resolution = resolveVueCompanionConfig({
			cwd: dir,
			vueConfig: serverConfig({ command: "vue-language-server" }),
			typescriptConfig: serverConfig({ command: "typescript-language-server" }),
		});

		expect(resolution.config).toBeUndefined();
		expect(resolution.issue).toContain("no tsserver-capable TypeScript");
	});

	it("keeps the companion but reports a missing plugin", () => {
		const dir = tempDir();
		write(path.join(dir, "node_modules", "typescript", "lib", "tsserver.js"));

		const resolution = resolveVueCompanionConfig({
			cwd: dir,
			vueConfig: serverConfig({ command: "vue-language-server" }),
			typescriptConfig: serverConfig({ command: "typescript-language-server" }),
		});

		// The companion still answers non-type commands, so it is not dropped…
		expect(resolution.config).toBeDefined();
		expect(resolution.config?.initOptions?.plugins).toBeUndefined();
		// …but `.vue` results must say why their type queries come back empty.
		expect(resolution.issue).toContain("@vue/typescript-plugin");
		expect(resolution.issue).toContain("vueTsPlugin.location");
	});

	it("reports a TypeScript 7 host with no wrapper as the reason Vue features are unavailable", () => {
		const dir = tempDir();
		const resolution = resolveVueCompanionConfig({
			cwd: dir,
			vueConfig: serverConfig({ command: "vue-language-server" }),
			typescriptConfig: undefined,
		});

		expect(resolution.config).toBeUndefined();
		expect(resolution.issue).toContain("TypeScript 7");
		expect(resolution.issue).toContain("typescript-language-server");
	});
});

describe("attachVueCompanions", () => {
	it("installs the companion under the canonical TypeScript key only for Vue projects", () => {
		const dir = tempDir();
		write(path.join(dir, VUE_PLUGIN, "package.json"), "{}");
		write(path.join(dir, "node_modules", "@vue", "language-server", "package.json"), "{}");
		write(path.join(dir, "node_modules", "typescript", "lib", "tsserver.js"));
		const vueCommand = path.join(dir, "node_modules", "@vue", "language-server", "bin", "vue-language-server.js");
		write(vueCommand);
		const typescriptConfig = serverConfig({ command: "typescript-language-server" });
		const servers: Record<string, ServerConfig> = {
			"vue-language-server": serverConfig({ command: vueCommand, resolvedCommand: vueCommand }),
			// A TypeScript 7 host keeps `tsc --lsp`; the restored wrapper replaces it.
			"typescript-native": serverConfig({ command: "tsc" }),
		};

		attachVueCompanions(servers, { cwd: dir, defaults: { "typescript-language-server": typescriptConfig } });

		expect(servers["vue-language-server"].vueCompanion?.command).toBe("typescript-language-server");
		expect(servers["vue-language-server"].vueCompanionIssue).toBeUndefined();
		expect(servers["typescript-language-server"]).toBeDefined();
		expect(servers["typescript-native"]).toBeUndefined();

		const plain: Record<string, ServerConfig> = {
			"typescript-language-server": serverConfig({ command: "typescript-language-server" }),
		};
		attachVueCompanions(plain, { cwd: dir, defaults: {} });
		expect(plain["typescript-language-server"].initOptions).toBeUndefined();
	});
});

describe("findTsserverInTree", () => {
	it("walks up to a monorepo root's TypeScript install", () => {
		const dir = tempDir();
		const tsserver = path.join(dir, "node_modules", "typescript", "lib", "tsserver.js");
		write(tsserver);
		const packageDir = path.join(dir, "packages", "web", "src");
		fs.mkdirSync(packageDir, { recursive: true });

		expect(findTsserverInTree(packageDir)).toBe(tsserver);
		expect(findTsserverInTree(path.join(dir, "packages", "api"))).toBe(tsserver);
	});

	it("finds a TypeScript nested inside the wrapper's own install tree", () => {
		const dir = tempDir();
		const tsserver = path.join(
			dir,
			"node_modules",
			"typescript-language-server",
			"node_modules",
			"typescript",
			"lib",
			"tsserver.js",
		);
		write(tsserver);

		expect(findTsserverInTree(path.join(dir, "node_modules", "typescript-language-server"))).toBe(tsserver);
	});
});

describe("supportsTsserverRequest", () => {
	it("accepts only servers advertising the raw tsserver command", () => {
		expect(supportsTsserverRequest({ executeCommandProvider: { commands: ["typescript.tsserverRequest"] } })).toBe(
			true,
		);
		expect(
			supportsTsserverRequest({ executeCommandProvider: { commands: ["_typescript.applyFixAllCodeAction"] } }),
		).toBe(false);
		expect(supportsTsserverRequest({})).toBe(false);
		expect(supportsTsserverRequest(undefined)).toBe(false);
		expect(supportsTsserverRequest({ executeCommandProvider: "nope" })).toBe(false);
	});
});
