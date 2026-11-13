import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "@oh-my-pi/pi-coding-agent/lsp/config";
import DEFAULTS from "../../src/lsp/defaults.json" with { type: "json" };
import { TempDir } from "@oh-my-pi/pi-utils";

const tempDirs: TempDir[] = [];
const SERVER_NAME = "python-fallback-fixture";

function write(file: string, content = ""): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, content);
}

interface RepoOptions {
	git?: boolean;
	/** Files (relative to the repo root) to create. */
	files?: string[];
	/** Extra root marker the project ships instead of relying on the fallback. */
	pyproject?: boolean;
}

/** A checkout whose only Python-ish signal is the files it contains. */
function createRepo(options: RepoOptions = {}): string {
	const tempDir = TempDir.createSync("@omp-python-fallback-");
	tempDirs.push(tempDir);
	const dir = tempDir.path();
	if (options.git) fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	if (options.pyproject) write(path.join(dir, "pyproject.toml"), "[project]\nname = 'x'\n");
	for (const file of options.files ?? []) write(path.join(dir, file), "print('hi')\n");
	fs.writeFileSync(
		path.join(dir, "lsp.json"),
		JSON.stringify({
			servers: {
				[SERVER_NAME]: {
					command: process.execPath,
					args: [],
					fileTypes: [".py"],
					rootMarkers: ["pyproject.toml"],
					rootFallback: { markers: [".git"], fileExtensions: [".py", ".pyi"] },
				},
			},
		}),
	);
	return dir;
}

function hasFixtureServer(dir: string): boolean {
	return Object.keys(loadConfig(dir).servers).includes(SERVER_NAME);
}

/**
 * The same checkout with a config whose `rootFallback` is malformed: the loader
 * runs while a session is created, so it must not throw on it.
 */
function createMalformedFallbackRepo(rootFallback: unknown): string {
	const dir = createRepo({ git: true, files: ["run.py"] });
	fs.writeFileSync(
		path.join(dir, "lsp.json"),
		JSON.stringify({
			servers: {
				[SERVER_NAME]: {
					command: process.execPath,
					args: [],
					fileTypes: [".py"],
					rootMarkers: ["pyproject.toml"],
					rootFallback,
				},
			},
		}),
	);
	return dir;
}

afterEach(async () => {
	for (const tempDir of tempDirs.splice(0)) await tempDir.remove();
});

describe("python root fallback", () => {
	it("starts in a plain git checkout that contains Python sources", () => {
		expect(hasFixtureServer(createRepo({ git: true, files: ["scripts/run.py"] }))).toBe(true);
	});

	it("does not start in a git checkout without Python sources", () => {
		expect(hasFixtureServer(createRepo({ git: true, files: ["README.md", "scripts/run.js"] }))).toBe(false);
	});

	it("does not start without the fallback marker, even when Python files exist", () => {
		expect(hasFixtureServer(createRepo({ files: ["run.py"] }))).toBe(false);
	});

	it("ignores Python sources inside dependency and build directories", () => {
		expect(
			hasFixtureServer(
				createRepo({
					git: true,
					files: [".venv/lib/python3.11/site-packages/pkg/module.py", "node_modules/pkg/index.py"],
				}),
			),
		).toBe(false);
	});

	it("keeps the ordinary manifest gate working", () => {
		expect(hasFixtureServer(createRepo({ pyproject: true }))).toBe(true);
	});

	it("treats a malformed rootFallback as absent instead of throwing", () => {
		const malformed: unknown[] = [
			{ fileExtensions: ".py" },
			{ markers: [".git"] },
			{},
			{ markers: [".git"], fileExtensions: [] },
			{ markers: [7], fileExtensions: [".py"] },
			"not-an-object",
		];
		for (const rootFallback of malformed) {
			const dir = createMalformedFallbackRepo(rootFallback);
			expect(() => loadConfig(dir)).not.toThrow();
			// Without a usable gate the fallback marker and source file do not matter.
			expect(hasFixtureServer(dir)).toBe(false);
		}
	});
});

interface DefaultServer {
	rootMarkers: string[];
	rootFallback?: { markers: string[]; fileExtensions: string[] };
}

/** The bundled defaults, typed for the fields this suite inspects. */
const defaults: Record<string, DefaultServer> = DEFAULTS;

describe("default Python servers", () => {
	it("declare the git fallback for script checkouts", () => {
		for (const name of ["pyright", "basedpyright"]) {
			const config = defaults[name];
			expect(config.rootFallback?.markers).toContain(".git");
			expect(config.rootFallback?.fileExtensions).toEqual([".py", ".pyi"]);
			// The manifest markers stay first: a project with one prefers its own config root.
			expect(config.rootMarkers.length).toBeGreaterThan(0);
		}
	});
});
