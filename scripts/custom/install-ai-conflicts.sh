#!/usr/bin/env bash
# Opt this user in to (or out of) the daily AI conflict resolver.
#
#   install-ai-conflicts.sh --enable    install the oneshot unit, the weak dependency
#                                       drop-in the daily installer reads, and the marker
#   install-ai-conflicts.sh --disable   remove only that drop-in and the marker
#   install-ai-conflicts.sh --refresh   re-apply the current opt-in state from the assets
#                                       next to this script (install.sh calls this)
#
# The resolver never gets enabled for a user who did not ask for it: only --enable creates
# ROOT/state/ai-conflicts/enabled, and --refresh does nothing while that marker is absent
# beyond removing its own stale drop-in. Nothing here starts a job, enables a timer,
# rewrites the daily installer, or touches an unrelated drop-in. No secret is read or
# written: the unit takes credentials from the existing gh login, and the optional
# ~/.config/omp-custom/ai-conflicts.env file is for account and repository settings only.
#
# Writes, and nothing else:
#   <root>/state/ai-conflicts/enabled                      the opt-in marker
#   <config>/systemd/user/omp-ai-conflicts.service          the oneshot unit
#   <config>/systemd/user/omp-daily-update.service.d/10-ai-conflicts.conf
#   <config>/omp-custom/ai-conflicts.env                    template, created once, never overwritten
#   <libexec>/ai-conflict-controller.sh, ai-conflict-model.ts   deployed only if missing
#
# No lock: install.sh holds its install lock while calling --refresh, and this script
# only replaces whole files, so it must not try to take that lock again.
#
# Environment:
#   OMP_CUSTOM_HOME     install root (default ${XDG_DATA_HOME:-~/.local/share}/omp-custom)
#   OMP_CUSTOM_LIBEXEC  deployed asset dir (default ~/.local/libexec/omp-custom)
#   XDG_CONFIG_HOME     config root (default ~/.config)
#
# Exit codes: 0 done; 2 bad usage; 1 refused or failed.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

ROOT="${OMP_CUSTOM_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/omp-custom}"
LIBEXEC="${OMP_CUSTOM_LIBEXEC:-$HOME/.local/libexec/omp-custom}"
CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}"
UNITS="$CONFIG/systemd/user"
DROPIN_DIR="$UNITS/omp-daily-update.service.d"
OUR_UNIT="$UNITS/omp-ai-conflicts.service"
OUR_DROPIN="$DROPIN_DIR/10-ai-conflicts.conf"
MARKER="$ROOT/state/ai-conflicts/enabled"
ENV_FILE="$CONFIG/omp-custom/ai-conflicts.env"

UNIT_SRC="$script_dir/systemd/omp-ai-conflicts.service"
DROPIN_SRC="$script_dir/systemd/omp-daily-update.service.d/10-ai-conflicts.conf"
CONTROLLER="ai-conflict-controller.sh"
ADAPTER="ai-conflict-model.ts"

usage() {
  printf 'usage: %s --enable|--disable|--refresh\n' "$(basename "$0")" >&2
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup_tmp=""
trap '[[ -n "$cleanup_tmp" ]] && rm -f -- "$cleanup_tmp"' EXIT

write_atomic() { # src dest mode
  cleanup_tmp="$2.new.$$"
  cp -- "$1" "$cleanup_tmp"
  chmod "$3" "$cleanup_tmp"
  mv -f -- "$cleanup_tmp" "$2"
  cleanup_tmp=""
}

reload() {
  command -v systemctl >/dev/null 2>&1 || return 0
  # A user manager that is not reachable (no session, no runtime dir) needs no reload.
  [[ -n "${XDG_RUNTIME_DIR:-}" && -d "${XDG_RUNTIME_DIR:-}" ]] || return 0
  systemctl --user daemon-reload >/dev/null 2>&1 \
    || printf 'warning: systemctl --user daemon-reload failed; run it by hand\n' >&2
  return 0
}

require_sources() {
  [[ -f "$UNIT_SRC" ]] || die "missing unit source: $UNIT_SRC"
  [[ -f "$DROPIN_SRC" ]] || die "missing drop-in source: $DROPIN_SRC"
}

deploy_assets() {
  local name
  mkdir -p "$LIBEXEC"
  for name in "$CONTROLLER" "$ADAPTER"; do
    [[ -f "$script_dir/$name" ]] || die "missing $name next to $(basename "$0")"
    [[ "$script_dir/$name" -ef "$LIBEXEC/$name" ]] && continue
    [[ -f "$LIBEXEC/$name" ]] || write_atomic "$script_dir/$name" "$LIBEXEC/$name" 644
  done
  chmod 755 "$LIBEXEC/$CONTROLLER"
  for name in "$CONTROLLER" "$ADAPTER"; do
    [[ -f "$LIBEXEC/$name" ]] || die "missing $LIBEXEC/$name after deploy"
  done
}

install_wiring() {
  require_sources
  mkdir -p "$DROPIN_DIR"
  write_atomic "$UNIT_SRC" "$OUR_UNIT" 644
  write_atomic "$DROPIN_SRC" "$OUR_DROPIN" 644
}

write_env_template() {
  [[ -f "$ENV_FILE" ]] && return 0
  mkdir -p "$(dirname "$ENV_FILE")"
  cleanup_tmp="$ENV_FILE.new.$$"
  cat >"$cleanup_tmp" <<'EOF'
# Settings for omp-ai-conflicts.service. Non-secret values only: account and repository
# settings. Credentials are never read from here; the resolver uses the existing gh login.
#
#   OMP_AI_CONFLICTS_GH_USER=mastternick
#   OMP_CUSTOM_REPO=mastternick/oh-my-pi
#   OMP_CUSTOM_BRANCH=custom
#   OMP_AI_CONFLICTS_TMPDIR=/dev/shm
EOF
  chmod 600 "$cleanup_tmp"
  mv -f -- "$cleanup_tmp" "$ENV_FILE"
  cleanup_tmp=""
}

enable() {
  deploy_assets
  install_wiring
  write_env_template
  mkdir -p "$(dirname "$MARKER")"
  [[ -f "$MARKER" ]] || printf 'enabled\n' >"$MARKER"
  reload
  printf 'enabled: %s\n' "$MARKER"
  printf 'unit: %s\n' "$OUR_UNIT"
  printf 'wired into the existing daily timer through %s\n' "$OUR_DROPIN"
  printf 'next timer run: systemctl --user list-timers omp-daily-update.timer\n'
  printf 'run it once now: systemctl --user start omp-ai-conflicts.service\n'
  printf 'status: journalctl --user -u omp-ai-conflicts.service\n'
}

disable() {
  if [[ -f "$OUR_DROPIN" ]]; then
    rm -f -- "$OUR_DROPIN"
    rmdir --ignore-fail-on-non-empty "$DROPIN_DIR" 2>/dev/null || true
  fi
  rm -f -- "$MARKER"
  rmdir --ignore-fail-on-non-empty "$(dirname "$MARKER")" 2>/dev/null || true
  reload
  printf 'disabled: removed %s and %s\n' "$OUR_DROPIN" "$MARKER"
  printf 'kept: %s, %s, the daily timer, and every other drop-in\n' "$OUR_UNIT" "$ENV_FILE"
  printf 'a run already in flight is left alone; it reports on omp-ai-conflicts.service\n'
}

refresh() {
  if [[ -f "$MARKER" ]]; then
    if [[ -f "$UNIT_SRC" && -f "$DROPIN_SRC" ]]; then
      install_wiring
      reload
    else
      printf 'warning: opt-in is on but %s is missing; left as is\n' "$script_dir/systemd" >&2
    fi
    return 0
  fi
  # Not opted in: drop only a drop-in a previous opt-in may have left behind.
  if [[ -f "$OUR_DROPIN" ]]; then
    rm -f -- "$OUR_DROPIN"
    rmdir --ignore-fail-on-non-empty "$DROPIN_DIR" 2>/dev/null || true
    reload
  fi
  return 0
}

case "${1:-}" in
  --enable) enable ;;
  --disable) disable ;;
  --refresh) refresh ;;
  -h | --help) usage; exit 0 ;;
  *)
    usage
    exit 2
    ;;
esac
