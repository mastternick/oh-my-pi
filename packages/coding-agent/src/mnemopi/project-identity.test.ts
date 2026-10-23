import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { computeMnemopiBankScope, extendRecallWithLegacyBanks, projectBankSegment } from "./config";
import {
	normalizeGitRemoteUrl,
	PROJECT_IDENTITY_METADATA_KEY,
	projectIdentityBankSegment,
	resolveProjectIdentity,
} from "./project-identity";

let root: string;
const savedEnv = {
	GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
	GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM,
};

beforeAll(() => {
	process.env.GIT_CONFIG_GLOBAL = "/dev/null";
	process.env.GIT_CONFIG_NOSYSTEM = "1";
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-identity-")));
});

afterAll(() => {
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	fs.rmSync(root, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
	const proc = Bun.spawnSync(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${Buffer.from(proc.stderr).toString()}`);
	return Buffer.from(proc.stdout).toString().trim();
}

function makeRepo(dir: string, remote?: string): string {
	fs.mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q");
	if (remote) git(dir, "remote", "add", "origin", remote);
	return dir;
}

function commit(dir: string): void {
	git(dir, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init");
}

function bankOf(cwd: string): string {
	return computeMnemopiBankScope(undefined, cwd, "per-project").bank;
}

describe("normalizeGitRemoteUrl", () => {
	it("treats equivalent remote spellings as one project", () => {
		for (const url of [
			"https://github.com/org/app.git",
			"https://GitHub.com/Org/App/",
			"git@github.com:org/app.git",
			"ssh://git@github.com:22/org/app.git",
			"git://github.com/org/app",
			"https://user:s3cret@github.com/org/app.git?x=1#frag",
		]) {
			expect(normalizeGitRemoteUrl(url)).toBe("github.com/org/app");
		}
	});

	it("keeps non-default ports and maps local remotes to absolute paths", () => {
		expect(normalizeGitRemoteUrl("https://example.com:8443/o/r")).toBe("example.com:8443/o/r");
		expect(normalizeGitRemoteUrl(path.join(root, "x.git"))).toBe(`local:${path.join(root, "x.git")}`);
	});

	it("rejects relative and unparseable remotes", () => {
		expect(normalizeGitRemoteUrl("")).toBeUndefined();
		expect(normalizeGitRemoteUrl("relative/repo.git")).toBeUndefined();
		expect(normalizeGitRemoteUrl("https://[bad")).toBeUndefined();
	});

	it("keeps path case outside known case-insensitive hosts", () => {
		expect(normalizeGitRemoteUrl("https://git.example.com/Team/Foo")).toBe("git.example.com/Team/Foo");
		expect(normalizeGitRemoteUrl("https://git.example.com/Team/foo")).toBe("git.example.com/Team/foo");
	});

	it("drops only the scheme's default port", () => {
		expect(normalizeGitRemoteUrl("https://host.example:22/x")).toBe("host.example:22/x");
		expect(normalizeGitRemoteUrl("https://host.example:443/x")).toBe("host.example/x");
		expect(normalizeGitRemoteUrl("ssh://host.example:22/x")).toBe("host.example/x");
		expect(normalizeGitRemoteUrl("ssh://host.example:2222/x")).toBe("host.example:2222/x");
		expect(normalizeGitRemoteUrl("git@host.example:x")).toBe("host.example/x");
		expect(normalizeGitRemoteUrl("git://host.example/x")).toBe("host.example/x");
	});

	it("rejects unsupported schemes, transport helpers, and remote-host file URLs", () => {
		expect(normalizeGitRemoteUrl("ftp://host.example/x")).toBeUndefined();
		expect(normalizeGitRemoteUrl("ext::sh -c x")).toBeUndefined();
		expect(normalizeGitRemoteUrl("file://fileserver/srv/repo")).toBeUndefined();
		expect(normalizeGitRemoteUrl(`file://${path.join(root, "x.git")}`)).toBe(`local:${path.join(root, "x.git")}`);
	});
});

describe("resolveProjectIdentity", () => {
	it("gives clones with equivalent remotes one bank, regardless of directory", () => {
		const a = makeRepo(path.join(root, "t1", "a", "app"), "git@github.com:Org/App.git");
		const b = makeRepo(path.join(root, "t1", "b", "renamed"), "https://github.com/org/app");
		expect(resolveProjectIdentity(a).kind).toBe("git-remote");
		expect(resolveProjectIdentity(a).key).toBe(resolveProjectIdentity(b).key);
		expect(bankOf(a)).toBe(bankOf(b));
	});

	it("gives unrelated repos with the same basename different banks", () => {
		const a = makeRepo(path.join(root, "t2", "c", "app"), "https://github.com/alice/app");
		const b = makeRepo(path.join(root, "t2", "d", "app"), "https://github.com/bob/app");
		expect(resolveProjectIdentity(a).label).toBe("app");
		expect(bankOf(a)).not.toBe(bankOf(b));
	});

	it("gives subdirectories and linked worktrees the same bank", () => {
		const repo = makeRepo(path.join(root, "t3", "svc"), "https://github.com/org/svc");
		commit(repo);
		const deep = path.join(repo, "src", "deep");
		fs.mkdirSync(deep, { recursive: true });
		const wt = path.join(root, "t3", "svc-wt");
		git(repo, "worktree", "add", "-q", "-b", "feature", wt);
		expect(bankOf(deep)).toBe(bankOf(repo));
		expect(bankOf(wt)).toBe(bankOf(repo));
	});

	it("without a remote: independent clones differ, linked worktrees match", () => {
		const r1 = makeRepo(path.join(root, "t4", "local1"));
		commit(r1);
		const r2 = makeRepo(path.join(root, "t4", "local2"));
		commit(r2);
		const wt = path.join(root, "t4", "local1-wt");
		git(r1, "worktree", "add", "-q", "-b", "feature", wt);
		expect(resolveProjectIdentity(r1).kind).toBe("git-common-dir");
		expect(bankOf(r1)).not.toBe(bankOf(r2));
		expect(bankOf(wt)).toBe(bankOf(r1));
	});

	it("non-git directories: distinct dirs differ, a symlink to the same dir matches", () => {
		const d1 = path.join(root, "t5", "g", "proj");
		const d2 = path.join(root, "t5", "h", "proj");
		fs.mkdirSync(d1, { recursive: true });
		fs.mkdirSync(d2, { recursive: true });
		const link = path.join(root, "t5", "proj-link");
		fs.symlinkSync(d1, link, "dir");
		expect(resolveProjectIdentity(d1).kind).toBe("path");
		expect(bankOf(d1)).not.toBe(bankOf(d2));
		expect(bankOf(link)).toBe(bankOf(d1));
	});

	it("non-git bank name matches the legacy path-keyed segment, so existing banks are reused", () => {
		const dir = path.join(root, "t6", "legacy-proj");
		fs.mkdirSync(dir, { recursive: true });
		expect(bankOf(dir)).toBe(projectBankSegment(dir));
		expect(projectIdentityBankSegment(resolveProjectIdentity(dir))).toBe(projectBankSegment(dir));
	});

	it("never leaks credentials into key, label, or bank name", () => {
		const repo = makeRepo(path.join(root, "t7", "cred"), "https://user:s3cret@github.com/org/app.git");
		const identity = resolveProjectIdentity(repo);
		expect(identity.key).not.toContain("s3cret");
		expect(identity.label).not.toContain("s3cret");
		expect(bankOf(repo)).not.toContain("s3cret");
	});

	it("is stable across processes", () => {
		const repo = makeRepo(path.join(root, "t8", "restart"), "https://github.com/org/restart");
		const modulePath = path.join(import.meta.dir, "project-identity.ts");
		const script = `import(${JSON.stringify(modulePath)}).then(m => process.stdout.write(m.projectIdentityBankSegment(m.resolveProjectIdentity(${JSON.stringify(repo)}))));`;
		const proc = Bun.spawnSync([process.execPath, "-e", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
		expect(proc.exitCode).toBe(0);
		expect(Buffer.from(proc.stdout).toString()).toBe(projectIdentityBankSegment(resolveProjectIdentity(repo)));
	});
});

describe("extendRecallWithLegacyBanks", () => {
	let dbPath = "";
	let banksDir = "";
	let repoA = "";
	let repoA2 = "";
	let repoU = "";
	let keyA = "";
	let deadDir = "";

	function writeLegacyBank(name: string, metadata: Array<string | null>): void {
		const dir = path.join(banksDir, name);
		fs.mkdirSync(dir, { recursive: true });
		const db = new Database(path.join(dir, "mnemopi.db"));
		db.run("CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, metadata_json TEXT)");
		metadata.forEach((meta, i) => {
			db.run("INSERT INTO working_memory (id, content, metadata_json) VALUES (?, ?, ?)", [`m${i}`, "x", meta]);
		});
		db.close();
	}

	beforeAll(() => {
		dbPath = path.join(root, "t9", "mnemopi.db");
		banksDir = path.join(root, "t9", "banks");
		repoA = makeRepo(path.join(root, "t9", "a", "app"), "https://github.com/org/app");
		repoA2 = makeRepo(path.join(root, "t9", "a2", "app"), "git@github.com:Org/App.git");
		repoU = makeRepo(path.join(root, "t9", "u", "app"), "https://github.com/other/app");
		keyA = resolveProjectIdentity(repoA).key;
		deadDir = path.join(root, "t9", "gone");
		fs.mkdirSync(path.join(repoA, "src"), { recursive: true });
		writeLegacyBank("good-cwd", [
			JSON.stringify({ cwd: path.join(repoA, "src") }),
			JSON.stringify({ cwd: repoA }),
		]);
		writeLegacyBank("good-pid", [JSON.stringify({ [PROJECT_IDENTITY_METADATA_KEY]: keyA, cwd: deadDir })]);
		writeLegacyBank("unrelated", [JSON.stringify({ cwd: repoU })]);
		writeLegacyBank("mixed", [JSON.stringify({ cwd: repoA }), JSON.stringify({ cwd: repoU })]);
		writeLegacyBank("pid-mismatch", [
			JSON.stringify({ [PROJECT_IDENTITY_METADATA_KEY]: "git-remote:github.com/nobody/none", cwd: repoA }),
		]);
		writeLegacyBank("no-metadata", [null]);
		writeLegacyBank("deleted", [JSON.stringify({ cwd: deadDir })]);
		writeLegacyBank("empty", []);
		writeLegacyBank(
			"over-cap",
			Array.from({ length: 33 }, (_, i) =>
				JSON.stringify({ [PROJECT_IDENTITY_METADATA_KEY]: keyA, cwd: path.join(deadDir, String(i)) }),
			),
		);
		fs.mkdirSync(path.join(banksDir, "corrupt"), { recursive: true });
		fs.writeFileSync(path.join(banksDir, "corrupt", "mnemopi.db"), "not a sqlite database");
	});

	it("includes banks whose rows verifiably belong to the same logical project", () => {
		const found = extendRecallWithLegacyBanks([], dbPath, repoA2);
		expect([...found].sort()).toEqual(["good-cwd", "good-pid"]);
	});

	it("excludes unrelated, mixed, mismatched, unverifiable, empty, corrupt, and over-cap banks", () => {
		const found = extendRecallWithLegacyBanks([], dbPath, repoU);
		expect([...found].sort()).toEqual(["unrelated"]);
	});

	it("does not duplicate banks already in the recall set", () => {
		const found = extendRecallWithLegacyBanks(["good-cwd"], dbPath, repoA2);
		expect(found[0]).toBe("good-cwd");
		expect(found.filter(name => name === "good-cwd")).toHaveLength(1);
		expect([...found].sort()).toEqual(["good-cwd", "good-pid"]);
	});
});

describe("consumer-visible bank isolation", () => {
	it("keeps path case significant on non-GitHub hosts", () => {
		const upper = makeRepo(path.join(root, "t10", "upper"), "https://git.example.com/Team/Foo");
		const lower = makeRepo(path.join(root, "t10", "lower"), "https://git.example.com/Team/foo");
		expect(bankOf(upper)).not.toBe(bankOf(lower));
	});

	it("treats GitHub owner/repo case as insignificant", () => {
		const a = makeRepo(path.join(root, "t10", "gh-a"), "https://github.com/Team/Foo");
		const b = makeRepo(path.join(root, "t10", "gh-b"), "https://github.com/team/foo");
		expect(bankOf(a)).toBe(bankOf(b));
	});

	it("isolates an explicit non-default port from the default-port URL", () => {
		const explicit = makeRepo(path.join(root, "t10", "port-22"), "https://host.example:22/x/y");
		const plain = makeRepo(path.join(root, "t10", "port-plain"), "https://host.example/x/y");
		expect(bankOf(explicit)).not.toBe(bankOf(plain));
	});

	it("shares a bank between scp-like and ssh:// spellings with the default port", () => {
		const scp = makeRepo(path.join(root, "t10", "scp"), "git@host.example:x/y.git");
		const ssh = makeRepo(path.join(root, "t10", "ssh"), "ssh://git@host.example:22/x/y");
		expect(bankOf(scp)).toBe(bankOf(ssh));
	});

	it("does not conflate a remote-host file URL with a local path", () => {
		const shared = path.join(root, "t10", "shared", "repo");
		const remoteFile = makeRepo(path.join(root, "t10", "rfile"), `file://fileserver${shared}`);
		const localPath = makeRepo(path.join(root, "t10", "lpath"), shared);
		expect(resolveProjectIdentity(remoteFile).kind).toBe("git-common-dir");
		expect(bankOf(remoteFile)).not.toBe(bankOf(localPath));
	});

	it("falls back to clone identity for unsupported-scheme remotes", () => {
		const a = makeRepo(path.join(root, "t10", "ftp-a"), "ftp://host.example/x/y");
		const b = makeRepo(path.join(root, "t10", "ftp-b"), "ftp://host.example/x/y");
		expect(resolveProjectIdentity(a).kind).toBe("git-common-dir");
		expect(bankOf(a)).not.toBe(bankOf(b));
	});

	it("isolates the same path on different hosts", () => {
		const one = makeRepo(path.join(root, "t10", "one"), "https://one.example/org/app");
		const two = makeRepo(path.join(root, "t10", "two"), "https://two.example/org/app");
		expect(bankOf(one)).not.toBe(bankOf(two));
	});

	it("legacy recall never crosses a case-variant project", () => {
		const upper = makeRepo(path.join(root, "t11", "upper"), "https://git.example.com/Team/Foo");
		const variant = makeRepo(path.join(root, "t11", "lower"), "https://git.example.com/Team/foo");
		const banks = path.join(root, "t11", "banks", "upper-bank");
		fs.mkdirSync(banks, { recursive: true });
		const db = new Database(path.join(banks, "mnemopi.db"));
		db.run("CREATE TABLE working_memory (id TEXT PRIMARY KEY, content TEXT NOT NULL, metadata_json TEXT)");
		db.run("INSERT INTO working_memory (id, content, metadata_json) VALUES (?, ?, ?)", [
			"m0",
			"x",
			JSON.stringify({ [PROJECT_IDENTITY_METADATA_KEY]: resolveProjectIdentity(upper).key }),
		]);
		db.close();
		const dbPath = path.join(root, "t11", "mnemopi.db");
		expect(extendRecallWithLegacyBanks([], dbPath, variant)).toEqual([]);
		expect(extendRecallWithLegacyBanks([], dbPath, upper)).toEqual(["upper-bank"]);
	});
});
