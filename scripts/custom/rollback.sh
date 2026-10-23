#!/usr/bin/env bash
# Switch omp-custom back to the previously installed version.
#   rollback.sh                       swap current <-> previous; launcher and entrypoints unchanged
#   rollback.sh --restore-entrypoints also restore the entrypoint links recorded by install.sh
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$script_dir/lib.sh"

ROOT="${OMP_CUSTOM_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/omp-custom}"
restore=0
case "${1:-}" in
  "") ;;
  --restore-entrypoints) restore=1 ;;
  *) die "usage: rollback.sh [--restore-entrypoints]" ;;
esac

[[ -L "$ROOT/previous" && -L "$ROOT/current" ]] || die "no previous/current version recorded under $ROOT"
omp_custom_lock "$ROOT"

prev="$(readlink "$ROOT/previous")"
cur="$(readlink "$ROOT/current")"
[[ "$prev" != "$cur" ]] || die "previous equals current ($cur)"
[[ -f "$ROOT/$prev/.commit" ]] || die "$prev is not a verified install"

omp_custom_atomic_link "$cur" "$ROOT/previous"
omp_custom_atomic_link "$prev" "$ROOT/current"

cli="$ROOT/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"
echo "current -> $prev ($(bun "$cli" --version))"

if (( restore )); then
  while IFS=$'\t' read -r link orig; do
    if [[ -n "$orig" ]]; then
      omp_custom_atomic_link "$orig" "$link"
    else
      rm -f "$link"
    fi
    echo "restored entrypoint: $link -> ${orig:-(absent)}"
  done < "$ROOT/state/entrypoints.tsv"
fi
