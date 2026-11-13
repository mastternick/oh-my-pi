import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

/** The shared fake language-server fixture, driven in a role via its first argument. */
export const fakeLspFixturePath = path.join(import.meta.dir, "..", "fixtures", "fake-lsp-server.ts");

export interface VueProjectOptions {
	/** Fixture role behind `typescript-language-server`; "none" leaves the wrapper uninstalled. */
	typescript?: "typescript" | "slow-typescript" | "none";
	/** Volar's role: malformed entries are injected, or a mixed batch replaces the plain request. */
	volar?: "volar" | "volar-malformed" | "volar-mixed";
	/** Install a TypeScript 5.x layout (`node_modules/typescript/lib/tsserver.js`). */
	localTypescript?: boolean;
	/** Resolve `tsc` from PATH instead of `node_modules/.bin`, keeping the project TS install. */
	tscOnPath?: boolean;
	/** Install Volar, its plugin, and a Vue root marker (default true). */
	vue?: boolean;
	/** Install `@vue/typescript-plugin` beside Volar (default true). */
	vuePlugin?: boolean;
}

export interface VueProject {
	dir: string;
	appVue: string;
	tempDir: TempDir;
}

let previousPath: string | undefined;

/** Restore the PATH an isolated project replaced; call from the test's cleanup. */
export function restoreIsolatedPath(): void {
	if (previousPath === undefined) return;
	process.env.PATH = previousPath;
	previousPath = undefined;
}

function write(file: string, content: string, executable = false): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
	if (executable) fs.chmodSync(file, 0o755);
}

/** A fake language-server binary that runs the shared fixture in `mode`. */
function writeBin(projectDir: string, name: string, mode: string): void {
	write(
		path.join(projectDir, "node_modules", ".bin", name),
		`#!/bin/sh\nexec "${process.execPath}" "${fakeLspFixturePath}" ${mode}\n`,
		true,
	);
}

/**
 * A Vue 3 project whose language servers are the fixture, laid out like an npm
 * install: `node_modules/.bin` launchers, a TypeScript 5.x install, and Volar's
 * tsserver plugin beside `@vue/language-server`.
 *
 * PATH is isolated to the project plus `/usr/bin:/bin` so a TypeScript or
 * language server installed on the host never decides what the test observes.
 */
export function createVueProject(options: VueProjectOptions = {}): VueProject {
	const tempDir = TempDir.createSync("@omp-volar-project-");
	const dir = tempDir.path();
	write(path.join(dir, "package.json"), '{"name":"vue-fixture","private":true}\n');
	const appVue = path.join(dir, "App.vue");
	if (options.vue !== false) {
		write(path.join(dir, "vue.config.js"), "module.exports = {};\n");
		write(
			appVue,
			[
				'<script setup lang="ts">',
				"const title = ref('hello');",
				"</script>",
				"",
				"<template><h1>{{ title }}</h1></template>",
				"",
			].join("\n"),
		);
		if (options.vuePlugin !== false) {
			const pluginDir = path.join(dir, "node_modules", "@vue", "typescript-plugin");
			write(path.join(pluginDir, "package.json"), '{"name":"@vue/typescript-plugin","version":"3.0.0"}\n');
		}
		write(
			path.join(dir, "node_modules", "@vue", "language-server", "package.json"),
			'{"name":"@vue/language-server"}\n',
		);
		writeBin(dir, "vue-language-server", options.volar ?? "volar");
	}
	const typescript = options.typescript ?? "typescript";
	if (typescript !== "none") writeBin(dir, "typescript-language-server", typescript);
	if (options.localTypescript) {
		write(path.join(dir, "node_modules", "typescript", "package.json"), '{"name":"typescript","version":"5.9.2"}\n');
		write(path.join(dir, "node_modules", "typescript", "lib", "tsserver.js"), "// tsserver 5.9.2\n");
	}
	// A TypeScript 7 `tsc` answers `--version` and ships no tsserver.js, which is what
	// makes `selectTypescriptServer` prefer `tsc --lsp` over the wrapper.
	const tscScript = '#!/bin/sh\necho "Version 7.0.2-dev"\n';
	write(path.join(dir, "toolchain", "tsc"), tscScript, true);
	if (!options.tscOnPath) write(path.join(dir, "node_modules", ".bin", "tsc"), tscScript, true);
	previousPath ??= process.env.PATH;
	process.env.PATH = `${path.join(dir, "toolchain")}:/usr/bin:/bin`;
	return { dir, appVue, tempDir };
}
