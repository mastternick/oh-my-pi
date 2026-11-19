/**
 * Detection of omp's custom distribution channel.
 *
 * A custom-channel install is built by `scripts/custom/install.sh`: its releases
 * are GitHub `custom-v*` tags and its builds live under `<install root>/versions/
 * <label>`, with `<install root>/current` a symlink to the active one. npm has no
 * such channel — its `latest` is upstream omp — so the startup version notice and
 * `omp update` must recognise this install *before* consulting npm or a package
 * manager, or they would advertise and install upstream over the custom build
 * the timer maintains.
 *
 * The `versions/<label>` layout is the reliable marker: Bun resolves the module
 * through that realpath, so `import.meta.dir` always names it. `current` is what a
 * shell path spells, and `OMP_REAL_BIN` is exported only by a launcher installed
 * fresh (install.sh never overwrites an existing launcher), so neither can be
 * assumed on an upgraded box.
 *
 * Everything here is a pure function of paths and environment values, so the
 * callers' real layout can be asserted without touching the filesystem.
 */
import * as os from "node:os";
import * as path from "node:path";

/** Env marker a freshly installed custom launcher exports: the entry point it exec's. */
export const CUSTOM_REAL_BIN_ENV = "OMP_REAL_BIN";
/** Overrides the deployed updater path (`~/.local/bin/omp-daily-update.sh`). */
export const CUSTOM_UPDATER_ENV = "OMP_DAILY_UPDATE_SH";
/** Install layout as a shell sees it: `<root>/current/<package>/…`. */
const CUSTOM_CURRENT_SEGMENT = "/omp-custom/current/";
/** The same tree after realpath: `<root>/versions/<label>/<package>/…`. */
const CUSTOM_VERSION_SEGMENT = /\/omp-custom\/versions\/[^/]+\//;

/** Inputs {@link isCustomChannelInstall} inspects; all paths and env values, no I/O. */
export interface CustomChannelProbe {
	/** Environment to read; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
	/** The `omp` a shell resolved from PATH, when one is known. */
	ompPath?: string;
	/** Directory of the running build; defaults to this module's own directory. */
	modulePath?: string;
}

/**
 * Whether `filePath` sits inside a custom install's tree, on any platform: under
 * `<root>/current` as the launcher spells it, or under `<root>/versions/<label>`
 * as Bun's realpath of that symlink spells it.
 */
export function isCustomChannelPath(filePath: string | undefined): boolean {
	if (filePath === undefined) return false;
	const normalized = `/${filePath.replaceAll("\\", "/").replace(/^\/+/, "")}/`;
	return normalized.includes(CUSTOM_CURRENT_SEGMENT) || CUSTOM_VERSION_SEGMENT.test(normalized);
}

/**
 * Whether this process runs a custom-channel install.
 *
 * A non-empty `OMP_REAL_BIN` marks the channel when a launcher exports it (the
 * fresh-install launcher does; an upgraded box's may not). The path checks cover
 * every install without that variable: `versions/<label>` from the module's
 * realpath (always true in production), or `current` from a shell path.
 */
export function isCustomChannelInstall(probe: CustomChannelProbe = {}): boolean {
	const env = probe.env ?? process.env;
	if ((env[CUSTOM_REAL_BIN_ENV] ?? "").trim().length > 0) return true;
	return isCustomChannelPath(probe.ompPath) || isCustomChannelPath(probe.modulePath ?? import.meta.dir);
}

/**
 * Custom install root: `OMP_CUSTOM_HOME`, else `${XDG_DATA_HOME:-~/.local/share}/omp-custom`.
 * Mirrors `scripts/custom/install.sh` and `omp-daily-update.sh`.
 */
export function customInstallRoot(env: Record<string, string | undefined> = process.env): string {
	const explicit = env.OMP_CUSTOM_HOME?.trim();
	if (explicit) return explicit;
	const dataHome = env.XDG_DATA_HOME?.trim() || path.join(env.HOME?.trim() || os.homedir(), ".local", "share");
	return path.join(dataHome, "omp-custom");
}

/** Deployed custom updater: `OMP_DAILY_UPDATE_SH`, else `~/.local/bin/omp-daily-update.sh`. */
export function customUpdaterPath(env: Record<string, string | undefined> = process.env): string {
	const override = env[CUSTOM_UPDATER_ENV]?.trim();
	if (override) return override;
	return path.join(env.HOME?.trim() || os.homedir(), ".local", "bin", "omp-daily-update.sh");
}
