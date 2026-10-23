#!/usr/bin/env bash
# Build the release bundle <out-dir>/omp-custom-<label>.tgz.
#   pack.sh <out-dir> <version-label>      label: <X.Y.Z> or <X.Y.Z>-c<N>
# The bundle is a gzip tarball with package.json (install manifest), bun.lock, and one tarball per public
# @oh-my-pi workspace package. The workspace tarballs come from `ci-release-publish.ts --pack-only`, so they
# carry the publish topology (bin -> dist/cli.js, dist types) and resolved catalog/workspace specs.
# @oh-my-pi/pi-natives is not bundled: the install takes it from npm at the pinned version.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$script_dir/lib.sh"

[[ $# -eq 2 ]] || die "usage: pack.sh <out-dir> <version-label>"
label="$2"
[[ "$label" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-c[0-9]+)?$ ]] || die "version label must look like 18.12.6 or 18.12.6-c1"
root="$(cd "$script_dir/../.." && pwd)"
mkdir -p "$1"
out="$(cd "$1" && pwd)"
asset="omp-custom-$label.tgz"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/tarballs" "$work/bundle"

(cd "$root" && bun run gen:tool-views && bun scripts/ci-release-publish.ts --pack-only "$work/tarballs")

for tgz in "$work"/tarballs/*.tgz; do omp_custom_check_deps "$tgz"; done

# Root dependency is the coding agent; every other workspace tarball overrides its @oh-my-pi/* dependency,
# so the install runs exactly the packed sources.
OMP_CUSTOM_TARBALLS="$work/tarballs" OMP_CUSTOM_BUNDLE="$work/bundle" OMP_CUSTOM_PKG="$OMP_CUSTOM_PKG" bun -e '
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const tarballs = process.env.OMP_CUSTOM_TARBALLS;
const bundle = process.env.OMP_CUSTOM_BUNDLE;
const pkg = process.env.OMP_CUSTOM_PKG;
const dependencies = {};
const overrides = {};
for (const file of fs.readdirSync(tarballs).filter(entry => entry.endsWith(".tgz")).sort()) {
	const manifest = JSON.parse(execFileSync("tar", ["-xOzf", path.join(tarballs, file), "package/package.json"]).toString());
	fs.copyFileSync(path.join(tarballs, file), path.join(bundle, file));
	if (manifest.name === pkg) dependencies[pkg] = `file:./${file}`;
	else overrides[manifest.name] = `file:./${file}`;
}
if (!dependencies[pkg]) throw new Error(`no packed tarball for ${pkg}`);
fs.writeFileSync(
	path.join(bundle, "package.json"),
	`${JSON.stringify({ name: "omp-custom-install", private: true, dependencies, overrides }, null, "\t")}\n`,
);
'

(cd "$work/bundle" && bun install --ignore-scripts >/dev/null)
rm -rf "$work/bundle/node_modules"
tar -C "$work/bundle" -czf "$out/$asset" .
echo "$out/$asset"
