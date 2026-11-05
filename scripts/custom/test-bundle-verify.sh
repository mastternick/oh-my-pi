#!/usr/bin/env bash
# Regression for bundle install verification (lib.sh). Installing a bundle with bun makes the installer
# write its own marker, node_modules/<pkg>/.bun-tag, holding the sha512 integrity of the tarball it
# unpacked; the packed files never contain it. A fresh bundle install must therefore still verify clean,
# while any changed packaged file, or a marker that does not match the bundle tarball, must fail.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
. "$script_dir/lib.sh"

pass=0
fail=0

check() { # name expected actual
	if [[ "$2" == "$3" ]]; then
		printf 'ok   %s\n' "$1"
		pass=$((pass + 1))
	else
		printf 'FAIL %s (want %s, got %s)\n' "$1" "$2" "$3"
		fail=$((fail + 1))
	fi
}

yes_no() { # path
	[[ -f "$1" ]] && echo yes || echo no
}

install_rc() { # dir -> exit status of a bundle install into it
	( omp_custom_install_bundle "$work/bundle.tgz" "$1" ) >/dev/null 2>&1
	printf '%s' "$?"
}

verify_rc() { # install-dir -> exit status of the byte-for-byte verification
	( omp_custom_bundle_matches "$1" ) >/dev/null 2>&1
	printf '%s' "$?"
}

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# Stand-in for a packed workspace package: an entry file, plus a nested file that shares the marker name
# so the exemption stays limited to the package root.
mkdir -p "$work/src/lib" "$work/bundle"
cat > "$work/src/package.json" <<'EOF'
{ "name": "@fx/verify-pkg", "version": "1.0.0", "main": "index.js", "files": ["index.js", "lib/.bun-tag"] }
EOF
printf 'module.exports = 1;\n' > "$work/src/index.js"
printf 'nested marker is package content\n' > "$work/src/lib/.bun-tag"

(cd "$work/src" && bun pm pack --destination "$work/bundle" >/dev/null 2>&1) \
	|| { echo "bun pm pack failed" >&2; exit 1; }
shopt -s nullglob
tarballs=("$work"/bundle/*.tgz)
shopt -u nullglob
[[ ${#tarballs[@]} -eq 1 ]] || { printf 'expected one tarball, got %d\n' "${#tarballs[@]}" >&2; exit 1; }
tgz="${tarballs[0]}"

# Same bundle shape as pack.sh: a manifest pinning the tarball, the lockfile bun generated for it, and
# the tarball itself.
cat > "$work/bundle/package.json" <<EOF
{ "name": "omp-custom-install", "private": true, "dependencies": { "@fx/verify-pkg": "file:./$(basename "$tgz")" } }
EOF
(cd "$work/bundle" && BUN_INSTALL_CACHE_DIR="$work/pack-cache" bun install --ignore-scripts >/dev/null 2>&1) \
	|| { echo "bundle install failed" >&2; exit 1; }
rm -rf "$work/bundle/node_modules"
tar -C "$work/bundle" -czf "$work/bundle.tgz" .

base="$work/install"
check "fresh bundle install verifies" 0 "$(install_rc "$base")"
pkg="$base/node_modules/@fx/verify-pkg"
marker="$pkg/.bun-tag"
check "installer wrote its marker" yes "$(yes_no "$marker")"
check "nested marker-named file installed" yes "$(yes_no "$pkg/lib/.bun-tag")"
# shellcheck disable=SC2016 # the node program is single-quoted on purpose
integrity="$(bun -e 'process.stdout.write(`sha512-${require("node:crypto").createHash("sha512").update(require("node:fs").readFileSync(process.argv[1])).digest("base64")}`)' "$tgz")"
check "marker holds the tarball integrity" "$integrity" "$(cat "$marker" 2>/dev/null)"

cp -a "$base" "$work/tampered-file"
rm -f "$work/tampered-file/node_modules/@fx/verify-pkg/index.js"
printf 'tampered\n' > "$work/tampered-file/node_modules/@fx/verify-pkg/index.js"
check "changed packaged file fails verification" 1 "$(verify_rc "$work/tampered-file")"

cp -a "$base" "$work/tampered-nested"
rm -f "$work/tampered-nested/node_modules/@fx/verify-pkg/lib/.bun-tag"
printf 'tampered\n' > "$work/tampered-nested/node_modules/@fx/verify-pkg/lib/.bun-tag"
check "changed nested marker-named file fails verification" 1 "$(verify_rc "$work/tampered-nested")"

cp -a "$base" "$work/stale-marker"
rm -f "$work/stale-marker/node_modules/@fx/verify-pkg/.bun-tag"
printf 'sha512-stale\n' > "$work/stale-marker/node_modules/@fx/verify-pkg/.bun-tag"
check "marker not matching the bundle tarball fails" 1 "$(verify_rc "$work/stale-marker")"

cp -a "$base" "$work/no-marker"
rm -f "$work/no-marker/node_modules/@fx/verify-pkg/.bun-tag"
check "absent marker is not a verification failure" 0 "$(verify_rc "$work/no-marker")"

if (( fail > 0 )); then
	printf 'test-bundle-verify: %d failed, %d passed\n' "$fail" "$pass"
	exit 1
fi
printf 'test-bundle-verify: all %d checks passed\n' "$pass"
