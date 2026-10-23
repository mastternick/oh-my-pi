#!/usr/bin/env bash
# Switch omp-custom back to the previously installed version.
#   rollback.sh                       swap current <-> previous; launcher and entrypoints unchanged
#   rollback.sh --restore-entrypoints also restore the launcher config saved before the first custom install and the entrypoint links recorded by install.sh
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
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
LAUNCHER_DIR="${OMP_LAUNCHER_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/omp-launcher}"
pre_cfg="$ROOT/state/launcher-config.pre-custom"
if (( restore )); then [[ -f "$pre_cfg" ]] || die "$pre_cfg missing; cannot restore the launcher config"; fi
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
  # Undo everything install.sh changed in the launcher config, then the entrypoints.
  cp "$pre_cfg" "$LAUNCHER_DIR/config.new.$$"
  mv -f "$LAUNCHER_DIR/config.new.$$" "$LAUNCHER_DIR/config"
  echo "restored launcher config from $pre_cfg"
  while IFS=$'\t' read -r link orig; do
    if [[ -n "$orig" ]]; then
      omp_custom_atomic_link "$orig" "$link"
    else
      rm -f "$link"
    fi
    echo "restored entrypoint: $link -> ${orig:-(absent)}"
  done < "$ROOT/state/entrypoints.tsv"
fi
