/**
 * Volar (Vue 3 / Nuxt) ↔ TypeScript bridge wiring.
 *
 * `vue-language-server` delegates every type query to a TypeScript server: it
 * sends a `tsserver/request` notification and waits for `tsserver/response`.
 * Nothing else answers that notification, so without a companion TypeScript
 * server every Vue semantic request (documentSymbol, definition, references,
 * hover, …) hangs until the tool times out.
 *
 * This module owns the contract shared by the two halves of the fix:
 * {@link resolveVueCompanionConfig} decides which TypeScript server answers the
 * bridge and how to configure it (the `@vue/typescript-plugin` tsserver plugin),
 * and the client forwards `tsserver/request` notifications to that server.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { logger } from "@oh-my-pi/pi-utils";
import type { ServerConfig } from "./types";

/** The executeCommand a TypeScript language server exposes for raw tsserver calls. */
export const TSSERVER_REQUEST_COMMAND = "typescript.tsserverRequest";

/** Whether a server advertises the raw tsserver command. */
export function supportsTsserverRequest(capabilities: unknown): boolean {
	if (typeof capabilities !== "object" || capabilities === null) return false;
	if (!("executeCommandProvider" in capabilities)) return false;
	const provider = capabilities.executeCommandProvider;
	if (typeof provider !== "object" || provider === null || !("commands" in provider)) return false;
	const commands = provider.commands;
	return Array.isArray(commands) && commands.includes(TSSERVER_REQUEST_COMMAND);
}

/** The tsserver plugin package that teaches tsserver about `.vue` files. */
const VUE_TS_PLUGIN_PACKAGE = "@vue/typescript-plugin";

/** Canonical name of the Vue language server in `defaults.json` and user configuration. */
const VUE_SERVER_NAME = "vue-language-server";

/** Name of the TypeScript server Volar can bridge to (the only one with the tsserver command). */
export const VUE_COMPANION_SERVER_NAME = "typescript-language-server";

/** Native `tsc --lsp` entry, which duplicates every `.ts` request the wrapper already answers. */
const TYPESCRIPT_NATIVE_SERVER_NAME = "typescript-native";

/**
 * Actions Volar cannot answer for a `.vue` file on its own.
 *
 * Its language service registers no `volar-service-typescript`, so definitions,
 * hovers, references, and renames come from the TypeScript plugin host — the
 * companion — exactly as VSCode's client-side TypeScript extension provides them
 * in an editor. Volar keeps what it owns: document symbols, folding, selection
 * ranges, semantic tokens, inlay hints, formatting, and its own diagnostics.
 */
export const VUE_TYPESCRIPT_BACKED_ACTIONS: Record<string, true> = {
	definition: true,
	type_definition: true,
	implementation: true,
	references: true,
	hover: true,
	rename: true,
	code_actions: true,
};

/** Ancestors walked when locating the plugin or the workspace TypeScript install. */
const LOOKUP_DEPTH = 8;

/**
 * Whether a configured server is a Volar instance.
 *
 * Config keys come first because a project may launch the very same binary
 * through a wrapper (`bun …`, a shell shim, a nix store path); the command
 * basename still catches instances configured under another key.
 */
export function isVueLanguageServer(name: string, config: ServerConfig): boolean {
	return name === VUE_SERVER_NAME || path.basename(config.command).includes(VUE_SERVER_NAME);
}

function isPackageDir(dir: string): boolean {
	try {
		return fs.statSync(path.join(dir, "package.json")).isFile();
	} catch {
		return false;
	}
}

/**
 * Locate `@vue/typescript-plugin` inside the install tree of the resolved
 * `vue-language-server` binary.
 *
 * Layouts walked, nearest first: npm nests it as `node_modules/@vue/typescript-plugin`
 * beside (or inside) `@vue/language-server`, and both `node_modules/.bin` symlinks
 * and global prefixes resolve to the same tree by ascending from the real binary
 * path. Returns undefined when the binary lives outside such a tree (a bare
 * wrapper script, a distro package that splits the plugin out).
 */
export function resolveVueTsPluginLocation(command: string): string | undefined {
	let realPath = command;
	try {
		realPath = fs.realpathSync(command);
	} catch {
		// Not resolvable (already absolute, or a wrapper on PATH): walk from the given path.
	}
	let dir = path.dirname(realPath);
	for (let depth = 0; depth < LOOKUP_DEPTH; depth++) {
		// A package dir (npm/pnpm may nest the plugin inside @vue/language-server)…
		const nested = path.join(dir, VUE_TS_PLUGIN_PACKAGE);
		if (isPackageDir(nested)) return nested;
		// …or a sibling in the same node_modules tree as the language server.
		const sibling = path.join(dir, "node_modules", VUE_TS_PLUGIN_PACKAGE);
		if (isPackageDir(sibling)) return sibling;
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/**
 * `typescript/lib/tsserver.js` of the TypeScript install reachable from `startDir`,
 * or undefined. Searched the way Node resolves a dependency: `<dir>/node_modules/…`
 * and `<dir>/…` at every level up, which covers both a workspace root and a
 * package manager's install tree.
 */
export function findTsserverInTree(startDir: string): string | undefined {
	let dir = path.resolve(startDir);
	for (let depth = 0; depth < LOOKUP_DEPTH; depth++) {
		for (const candidate of [
			path.join(dir, "node_modules", "typescript", "lib", "tsserver.js"),
			path.join(dir, "typescript", "lib", "tsserver.js"),
		]) {
			try {
				if (fs.statSync(candidate).isFile()) return candidate;
			} catch {
				// Keep walking: a monorepo keeps node_modules above the workspace root.
			}
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/**
 * `typescript/lib/tsserver.js` the TypeScript install behind `command` uses on its
 * own (typescript-language-server depends on a TypeScript version, or resolves the
 * workspace's). Undefined when that server would initialize without tsserver.
 */
export function findTsserverForCommand(command: string): string | undefined {
	let realPath = command;
	try {
		realPath = fs.realpathSync(command);
	} catch {
		// Walk from the given path when the binary is not resolvable.
	}
	return findTsserverInTree(path.dirname(realPath));
}

/** A TypeScript server config to drive as Volar's companion, or why there is none. */
export interface VueCompanionResolution {
	config?: ServerConfig;
	/** Plain-language reason the companion is unusable, surfaced in `.vue` lsp results. */
	issue?: string;
}

/**
 * Build the TypeScript server config that answers Volar's `tsserver/request`s
 * for `cwd`, wiring in the Volar tsserver plugin.
 *
 * `typescriptConfig` is the project's `typescript-language-server` entry, which
 * may be absent when `selectTypescriptServer` preferred `tsc --lsp` (TypeScript 7)
 * — a server that cannot answer the bridge. A project-pinned tsserver-capable
 * TypeScript then lets us bring the wrapper back, pinned to that TypeScript;
 * without one there is nothing to bridge to, and the caller reports the reason
 * instead of waiting for Volar to time out.
 */
export function resolveVueCompanionConfig(options: {
	cwd: string;
	vueConfig: ServerConfig;
	typescriptConfig: ServerConfig | undefined;
	/** Config the defaults would use, restored when `typescriptConfig` was removed by server selection. */
	fallbackTypescriptConfig?: ServerConfig;
}): VueCompanionResolution {
	const { vueConfig } = options;
	// The project's own TypeScript wins: it is the version the code is written for,
	// and pinning it keeps a TypeScript 7 host from handing the wrapper a
	// tsserver-less install.
	const projectTsserver = findTsserverInTree(options.cwd);
	const override = vueConfig.vueTsPlugin;
	const configured = options.typescriptConfig;
	const typescriptConfig =
		configured ?? (projectTsserver === undefined ? undefined : options.fallbackTypescriptConfig);

	if (!typescriptConfig) {
		return {
			issue: projectTsserver
				? "typescript-language-server is not available; install it (>= 4.4) next to TypeScript so Vue type queries can be answered"
				: "Vue language features need typescript-language-server (>= 4.4) driven by a TypeScript 5.x/6.x install: TypeScript 7 only speaks `tsc --lsp` and cannot answer Volar's tsserver requests",
		};
	}

	// typescript-language-server *is* a tsserver wrapper: without a tsserver.js of
	// its own or the project's it fails at initialize, so a companion that cannot
	// start is no companion — report it plainly rather than hanging Volar.
	const installTsserver = findTsserverForCommand(typescriptConfig.resolvedCommand ?? typescriptConfig.command);
	if (projectTsserver === undefined && installTsserver === undefined) {
		return {
			issue: `${typescriptConfig.command} has no tsserver-capable TypeScript: install TypeScript 5.x/6.x in the project or next to it (TypeScript 7 only speaks \`tsc --lsp\` and cannot answer Volar's tsserver requests)`,
		};
	}

	const initOptions: Record<string, unknown> = { ...typescriptConfig.initOptions };
	if (projectTsserver !== undefined && initOptions.tsserver === undefined) {
		// Pin the project's TypeScript: the wrapper otherwise resolves whatever
		// `typescript` it can see, which on a TypeScript 7 host is a tsserver-less
		// install that fails at initialize.
		initOptions.tsserver = { path: projectTsserver };
	}

	let issue: string | undefined;
	if (override !== false) {
		const pluginName = override?.name ?? VUE_TS_PLUGIN_PACKAGE;
		const plugins = Array.isArray(initOptions.plugins) ? initOptions.plugins : [];
		const alreadyWired = plugins.some(
			plugin => typeof plugin === "object" && plugin !== null && "name" in plugin && plugin.name === pluginName,
		);
		if (!alreadyWired) {
			// Anchor on the Volar install (that is where Vue ships the plugin);
			// fall back to the TypeScript install for split package trees.
			const location =
				override?.location ??
				resolveVueTsPluginLocation(vueConfig.resolvedCommand ?? vueConfig.command) ??
				resolveVueTsPluginLocation(typescriptConfig.resolvedCommand ?? typescriptConfig.command);
			if (location === undefined) {
				// The companion still answers non-type requests (e.g. projectInfo);
				// Vue semantics degrade to null answers instead of hanging. Say so in
				// the same place a wholly missing companion is reported.
				issue = `${pluginName} was not found next to ${vueConfig.command} or ${typescriptConfig.command}; Vue type queries will return no results (set vueTsPlugin.location to point at it)`;
				logger.warn("Vue TypeScript plugin not found; Vue type queries will return no results.", {
					server: vueConfig.command,
					plugin: pluginName,
				});
			} else {
				initOptions.plugins = [
					...plugins,
					{ name: pluginName, location, languages: override?.languages ?? ["vue"] },
				];
			}
		}
	}

	return { config: { ...typescriptConfig, initOptions }, issue };
}

/**
 * Wire every Volar server in `servers` to a TypeScript companion.
 *
 * The companion is installed under its canonical key so the rest of the agent
 * (a `.ts` file open, a rename, a diagnostics wait) shares the very same client
 * instead of spawning a second TypeScript server without the plugin.
 */
export function attachVueCompanions(
	servers: Record<string, ServerConfig>,
	options: { cwd: string; defaults: Record<string, ServerConfig> },
): void {
	const vueNames = Object.keys(servers).filter(name => isVueLanguageServer(name, servers[name]));
	if (vueNames.length === 0) return;

	for (const name of vueNames) {
		const vueConfig = servers[name];
		const resolution = resolveVueCompanionConfig({
			cwd: options.cwd,
			vueConfig,
			typescriptConfig: servers[VUE_COMPANION_SERVER_NAME],
			fallbackTypescriptConfig: options.defaults[VUE_COMPANION_SERVER_NAME],
		});
		vueConfig.vueCompanion = resolution.config;
		vueConfig.vueCompanionIssue = resolution.issue;
		if (resolution.config) {
			servers[VUE_COMPANION_SERVER_NAME] = resolution.config;
			// The wrapper is the workspace's TypeScript server: keeping the native
			// `tsc --lsp` entry would fan every `.ts` request out to two servers that
			// answer the same files (possible when a TypeScript 7 host preferred it).
			delete servers[TYPESCRIPT_NATIVE_SERVER_NAME];
		}
	}
}
