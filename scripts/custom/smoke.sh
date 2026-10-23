#!/usr/bin/env bash
# Install a release bundle into a scratch dir and run the packaged CLI.
#   smoke.sh <omp-custom-*.tgz>
set -euo pipefail

[[ $# -eq 1 ]] || { echo "usage: smoke.sh <bundle.tgz>" >&2; exit 2; }
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
. "$script_dir/lib.sh"

bundle="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
[[ -f "$bundle" ]] || die "no such bundle: $bundle"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

omp_custom_install_bundle "$bundle" "$work/install"
omp_custom_smoke "$work/install"
echo "smoke ok: $(basename "$bundle") ($(omp_custom_pkg_version "$work/install"))"
