# Shared helpers for scripts/custom/*. Sourced, never executed.

OMP_CUSTOM_PKG="@oh-my-pi/pi-coding-agent"

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# Refuse a packed tarball whose dependency fields still hold workspace/catalog/file/git specs, or whose
# @oh-my-pi/pi-natives pin is not exact. Every dependency must resolve from a bundled tarball or npm.
# usage: omp_custom_check_deps <tarball>
omp_custom_check_deps() {
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

# Unpack a release bundle into <dir> and install its pinned lockfile without lifecycle scripts.
# usage: omp_custom_install_bundle <bundle.tgz> <dir>
omp_custom_install_bundle() {
  mkdir -p "$2"
  tar -xzf "$1" -C "$2"
  (cd "$2" && bun install --frozen-lockfile --ignore-scripts >/dev/null)
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
