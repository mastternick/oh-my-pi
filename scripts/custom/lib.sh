# shellcheck shell=bash
# Shared helpers for scripts/custom/*. Sourced, never executed.

OMP_CUSTOM_PKG="@oh-my-pi/pi-coding-agent"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Refuse a packed tarball whose dependency fields still hold workspace/catalog/file/git specs, or whose
# @oh-my-pi/pi-natives pin is not exact. Every dependency must resolve from a bundled tarball or npm.
# usage: omp_custom_check_deps <tarball>
omp_custom_check_deps() {
  # shellcheck disable=SC2016 # the node program is single-quoted on purpose
  tar -xzOf "$1" package/package.json | bun -e '
let text = "";
process.stdin.on("data", chunk => (text += chunk)).on("end", () => {
	const manifest = JSON.parse(text);
	const bad = [];
	for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
		for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
			if (/^(workspace|catalog|file|link|git\+|github):/.test(spec)) bad.push(`${field}: ${name}@${spec}`);
			if (name === "@oh-my-pi/pi-natives" && !/^\d+\.\d+\.\d+$/.test(spec)) bad.push(`${field}: ${name} must be exact, got ${spec}`);
		}
	}
	if (bad.length > 0) {
		console.error(bad.join("\n"));
		process.exit(1);
	}
});
' || die "$1 has unresolved or non-exact dependency specs (listed above)"
}

# Unpack a release bundle into <dir>, install its pinned lockfile without lifecycle scripts, and verify the
# result. bun caches file: tarball deps by tarball name, not content, and a same-version re-release (cN)
# reuses those names, so each install gets a private cache that is removed afterwards.
# usage: omp_custom_install_bundle <bundle.tgz> <dir>
omp_custom_install_bundle() {
  mkdir -p "$2"
  tar -xzf "$1" -C "$2"
  (
    cache="$(mktemp -d "$2.bun-cache.XXXXXX")"
    trap 'rm -rf "$cache"' EXIT
    cd "$2" && BUN_INSTALL_CACHE_DIR="$cache" bun install --frozen-lockfile --ignore-scripts >/dev/null
  ) || die "bun install failed for $1"
  omp_custom_bundle_matches "$2" || die "could not verify $2 against bundle $1 (mismatch or unreadable package)"
}

# Checks that every @oh-my-pi package the bundle declares as file:./<tgz> is installed byte-for-byte under
# node_modules (files and symlink targets). Prints each mismatch to stderr. Returns 1 on any mismatch,
# missing package, or empty declaration list.
# usage: omp_custom_bundle_matches <install-dir>
omp_custom_bundle_matches() {
  bun -e '
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const dir = process.argv[1];
const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
const specs = Object.entries({ ...manifest.dependencies, ...manifest.overrides }).filter(([, spec]) => spec.startsWith("file:./"));
const tree = root => {
	const out = new Map();
	const walk = current => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			const rel = path.relative(root, full);
			// a nested node_modules holds the deps of other packages, not the files of this package
			if (entry.isDirectory()) { if (entry.name !== "node_modules") walk(full); }
			else if (entry.isSymbolicLink()) out.set(rel, `symlink:${fs.readlinkSync(full)}`);
			else out.set(rel, crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
		}
	};
	walk(root);
	return out;
};
const bad = specs.length === 0 ? ["bundle declares no file: packages"] : [];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-custom-verify-"));
try {
	for (const [name, spec] of specs) {
		const tarball = path.join(dir, spec.slice("file:./".length));
		const installed = path.join(dir, "node_modules", name);
		if (!fs.existsSync(installed)) {
			bad.push(`${name}: not installed`);
			continue;
		}
		const unpacked = fs.mkdtempSync(path.join(tmp, "x-"));
		execFileSync("tar", ["-xzf", tarball, "-C", unpacked]);
		const want = tree(path.join(unpacked, "package"));
		const got = tree(installed);
		const differ = [...new Set([...want.keys(), ...got.keys()])].filter(file => want.get(file) !== got.get(file));
		if (differ.length > 0) bad.push(`${name}: ${differ.length} file(s) differ from ${spec.slice("file:./".length)}, first: ${differ[0]}`);
	}
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
if (bad.length > 0) {
	console.error(bad.join("\n"));
	process.exit(1);
}
' "$1"
}

# usage: omp_custom_pkg_version <install-dir>
omp_custom_pkg_version() {
  bun -e 'process.stdout.write(require(process.argv[1]).version)' \
    "$1/node_modules/$OMP_CUSTOM_PKG/package.json"
}

# Runs the packaged CLI from an install dir and checks identity and basic entry points.
# usage: omp_custom_smoke <install-dir>
omp_custom_smoke() {
  local cli ver got
  cli="$1/node_modules/$OMP_CUSTOM_PKG/dist/cli.js"
  [[ -f "$cli" ]] || die "missing CLI entry: $cli"
  ver="$(omp_custom_pkg_version "$1")"
  got="$(bun "$cli" --version)"
  [[ "$got" == "omp/$ver" ]] || die "version mismatch: got '$got', want 'omp/$ver'"
  bun "$cli" --help >/dev/null
  bun "$cli" --smoke-test >/dev/null
}

# Atomically point <link> at <target> (GNU mv -T rename of a temp symlink).
# usage: omp_custom_atomic_link <target> <link>
omp_custom_atomic_link() {
  local tmp="$2.new.$$"
  ln -sfn "$1" "$tmp"
  mv -Tf "$tmp" "$2"
}

# Serialize installs/rollbacks on one root. No-op where flock is unavailable.
# usage: omp_custom_lock <root>
omp_custom_lock() {
  command -v flock >/dev/null || return 0
  exec 9>"$1/.lock"
  flock -n 9 || die "another omp-custom install or rollback is running"
}
