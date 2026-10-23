/**
 * Canonical logical-project identity for Mnemopi banks.
 *
 * Identity follows the repository, not the directory:
 * - git work trees (including subdirectories and linked worktrees) resolve through
 *   the repository's normalized `origin` remote (or the first remote by name);
 * - repositories without a usable remote fall back to their shared git common dir,
 *   which is shared by linked worktrees but never by independent clones;
 * - non-git directories use their real path, so unrelated directories never share a bank.
 *
 * Remote URLs are normalized conservatively (see {@link normalizeGitRemoteUrl}).
 * Identity keys and labels are never logged.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { readIsolationOwnerSync } from "../task/isolation-ownership";

/** Mount dir name `ensureIsolation` materialises under each task-isolation base (see task/worktree.ts). */
const ISOLATION_MOUNT_NAME = "m";

/** Memory metadata key new retains should carry so legacy verification can match rows without path re-derivation. */
export const PROJECT_IDENTITY_METADATA_KEY = "project_identity";

export type ProjectIdentityKind = "git-remote" | "git-common-dir" | "path";

export interface ProjectIdentity {
	kind: ProjectIdentityKind;
	/**
	 * Credential-free canonical identity; equal keys mean the same logical project.
	 * Path keys are absolute paths (they start with "/"), so they cannot collide with git keys.
	 */
	key: string;
	/** Readable name used only as a bank-name prefix. */
	label: string;
}

/** Default port per supported remote scheme. An explicit port equal to this default is dropped from the identity. */
const DEFAULT_PORT_BY_SCHEME: Record<string, string> = {
	http: "80",
	https: "443",
	git: "9418",
	ssh: "22",
	"git+ssh": "22",
	"ssh+git": "22",
};
/** Hosts whose owner/repo path segments are case-insensitive. Every other host keeps path case. */
const CASE_INSENSITIVE_PATH_HOSTS: Record<string, true> = { "github.com": true };
const GIT_LOCATION_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE", "GIT_NAMESPACE"];

/** Resolve the logical project for `cwd`. Synchronous; never throws. */
export function resolveProjectIdentity(cwd: string): ProjectIdentity {
	const dir = canonicalPath(cwd || ".");
	return deriveProjectIdentity(isolationSourceRoot(dir) ?? dir);
}

/**
 * Task-isolation mounts (`<base>/m`) record their source checkout as `sourceRoot` in the owner
 * marker `<base>/.omp-isolation-owner.json`. Resolving through it gives an isolated worker its
 * parent's logical project, whatever its own git metadata looks like (copy, linked, or native).
 * Walks ancestors so nested directories inside the mount resolve too.
 */
function isolationSourceRoot(dir: string): string | undefined {
	for (let current = dir; ;) {
		if (path.basename(current) === ISOLATION_MOUNT_NAME) {
			const owner = readIsolationOwnerSync(path.dirname(current));
			if (owner) return validSourceRoot(owner.sourceRoot);
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** Accepts an existing source root that is not itself inside a sandbox mount (no chained resolution). */
function validSourceRoot(sourceRoot: string | undefined): string | undefined {
	if (!sourceRoot || !path.isAbsolute(sourceRoot) || !fs.existsSync(sourceRoot)) return undefined;
	const root = canonicalPath(sourceRoot);
	return isInsideIsolationMount(root) ? undefined : root;
}

function isInsideIsolationMount(dir: string): boolean {
	for (let current = dir; ;) {
		if (path.basename(current) === ISOLATION_MOUNT_NAME && readIsolationOwnerSync(path.dirname(current))) return true;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

function deriveProjectIdentity(dir: string): ProjectIdentity {
	const commonDir = gitCommonDir(dir);
	if (commonDir) {
		const remote = gitRemoteKey(dir);
		if (remote) {
			const label = path.posix.basename(remote).replace(/\.git$/, "");
			return { kind: "git-remote", key: `git-remote:${remote}`, label };
		}
		const label =
			path.basename(commonDir) === ".git"
				? path.basename(path.dirname(commonDir))
				: path.basename(commonDir).replace(/\.git$/, "");
		return { kind: "git-common-dir", key: `git-common-dir:${commonDir}`, label };
	}
	return { kind: "path", key: dir, label: path.basename(dir) };
}

/**
 * Root for repo-relative condition fingerprints: the current git worktree root
 * (`git rev-parse --show-toplevel`, correct inside linked worktrees and
 * subdirectories), else the canonical non-git cwd. Bounded: one `runGit`
 * probe; never throws.
 */
export function resolveProjectRepoRoot(cwd: string): string {
	const dir = canonicalPath(cwd || ".");
	const toplevel = runGit(dir, ["rev-parse", "--show-toplevel"]);
	if (toplevel) return canonicalPath(toplevel);
	// No worktree (bare repo, GIT_DIR-only, or plain directory).
	return dir;
}

/** Bank-name segment `<label>-<hash>` for an identity, clamped to the bank-name limit. */
export function projectIdentityBankSegment(identity: ProjectIdentity): string {
	const label = sanitizeBankName(identity.label) ?? "default";
	return limitBankName(`${label}-${Bun.hash(identity.key).toString(36)}`);
}

/**
 * Normalize a git remote URL to `host[:port]/path` or `local:/abs/path`.
 *
 * - Supported schemes: http, https, git, ssh, git+ssh, ssh+git, file (local only). Anything else returns undefined.
 * - scp-like `[user@]host:path` is ssh with the default port, so it equals `ssh://host/path`.
 * - Userinfo, query, and fragment are dropped. Host is lowercased.
 * - A port equal to the scheme's default is dropped; any other explicit port is kept, so `https://host:22` differs from `https://host`.
 * - Path case is preserved, except on {@link CASE_INSENSITIVE_PATH_HOSTS} (GitHub owner/repo names are case-insensitive).
 * - A trailing `.git` and slashes are dropped.
 * - `file://` is local only (empty host or `localhost`); a remote-host `file://` URL is not conflated with a local path and returns undefined.
 * - Transport helpers (`ext::`), relative paths, and unparseable input return undefined.
 */
export function normalizeGitRemoteUrl(raw: string): string | undefined {
	const url = raw.trim();
	if (!url || /^[a-z][a-z0-9+.-]*::/i.test(url)) return undefined;
	let host: string;
	let port = "";
	let repoPath: string;
	const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
	if (schemeMatch) {
		const scheme = schemeMatch[1].toLowerCase();
		let parsed: URL;
		try {
			parsed = new URL(url);
		} catch {
			return undefined;
		}
		if (scheme === "file") {
			if (parsed.hostname !== "" && parsed.hostname !== "localhost") return undefined;
			return `local:${canonicalPath(safeDecode(parsed.pathname))}`;
		}
		if (!Object.hasOwn(DEFAULT_PORT_BY_SCHEME, scheme)) return undefined;
		host = parsed.hostname.toLowerCase();
		port = parsed.port === DEFAULT_PORT_BY_SCHEME[scheme] ? "" : parsed.port;
		repoPath = safeDecode(parsed.pathname);
	} else if (path.isAbsolute(url)) {
		return `local:${canonicalPath(url)}`;
	} else {
		// scp-like: [user@]host:path. Two-character minimum host rejects Windows drive letters.
		const scp = /^(?:[^@/\s]+@)?([^:/@\s]{2,}):([^:].*)$/.exec(url);
		if (!scp) return undefined;
		host = scp[1].toLowerCase();
		repoPath = scp[2];
	}
	const repo = repoPath
		.replace(/^\/+|\/+$/g, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/g, "");
	const normalizedRepo = CASE_INSENSITIVE_PATH_HOSTS[host] === true ? repo.toLowerCase() : repo;
	if (!host || !normalizedRepo) return undefined;
	return `${host}${port ? `:${port}` : ""}/${normalizedRepo}`;
}

/**
 * Sanitize a free-form name into a bank-name fragment (`[A-Za-z0-9_-]`, bounded length).
 * Returns undefined when nothing usable remains.
 */
export function sanitizeBankName(value: string | undefined): string | undefined {
	const raw = value?.trim();
	if (!raw) return undefined;
	const sanitized = raw.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized ? limitBankName(sanitized) : undefined;
}

export function limitBankName(name: string): string {
	if (name.length <= 64) return name;
	const hash = Bun.hash(name).toString(36);
	const prefixLength = Math.max(1, 63 - hash.length);
	const prefix = name.slice(0, prefixLength).replace(/-+$/g, "") || "bank";
	return `${prefix}-${hash}`;
}

function canonicalPath(p: string): string {
	const resolved = path.resolve(p);
	try {
		return fs.realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function gitCommonDir(dir: string): string | undefined {
	const out = runGit(dir, ["rev-parse", "--git-common-dir"]);
	return out ? canonicalPath(path.resolve(dir, out)) : undefined;
}

/** Normalized key of the repository's canonical remote: `origin`, else the first remote by name. */
function gitRemoteKey(dir: string): string | undefined {
	const names = (runGit(dir, ["remote"]) ?? "")
		.split("\n")
		.map(name => name.trim())
		.filter(Boolean);
	if (names.length === 0) return undefined;
	const name = names.includes("origin") ? "origin" : [...names].sort()[0];
	const url = runGit(dir, ["remote", "get-url", name]);
	return url ? normalizeGitRemoteUrl(url) : undefined;
}

function runGit(cwd: string, args: string[]): string | undefined {
	const env: Record<string, string | undefined> = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
	for (const key of GIT_LOCATION_ENV) delete env[key];
	try {
		const proc = Bun.spawnSync(["git", ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
		if (proc.exitCode !== 0) return undefined;
		return Buffer.from(proc.stdout).toString("utf8").trim() || undefined;
	} catch {
		return undefined;
	}
}
