#!/usr/bin/env bash
# omp-daily-update.sh — install the newest published omp-custom release, daily.
#
# Delegates every authenticity check to scripts/custom/install.sh:
#   tag commit on origin/custom + git/API agreement, successful custom-release
#   workflow for that commit, SHA256SUMS verification, byte-for-byte bundle
#   match, and smoke test before the atomic switch. This script adds:
#   - release discovery (newest published custom-v* release, sorted by semver)
#   - idempotency & regression guard (no work when current; refuses older tags)
#   - a disk-space guard before any download/unpack
#   - a concurrency lock (safe against timer + manual overlap)
#   - rollback preservation: all installed versions and rollback symlinks preserved
#   - failure notification (status file + optional command + desktop notify)
#
# Nothing is merged, tagged, or published here; this only CONSUMES releases.
# Environment:
#   OMP_CUSTOM_HOME        install root (default ${XDG_DATA_HOME:-~/.local/share}/omp-custom)
#   OMP_CUSTOM_REPO        GitHub repo (default mastternick/oh-my-pi)
#   OMP_INSTALL_SH         path to scripts/custom/install.sh (default: searches
#                          ../libexec/omp-custom, $ROOT/scripts, adjacent dir)
#   OMP_DAILY_MIN_FREE     minimum free bytes on the install root (default 1610612736 = 1.5 GiB;
#                          a release unpacks to ~1 GiB of real copies plus a ~24 MB bundle)
#   OMP_DAILY_NOTIFY_CMD   optional shell command run on failure with $MESSAGE and $TAG set
#   OMP_DAILY_STATE_DIR    state dir (default $ROOT/state)
set -euo pipefail

REPO="${OMP_CUSTOM_REPO:-mastternick/oh-my-pi}"
ROOT="${OMP_CUSTOM_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/omp-custom}"
STATE="${OMP_DAILY_STATE_DIR:-$ROOT/state}"
MIN_FREE="${OMP_DAILY_MIN_FREE:-1610612736}"

# Ensure bun is on PATH if installed under ~/.bun/bin
if [[ -d "$HOME/.bun/bin" && ":$PATH:" != *":$HOME/.bun/bin:"* ]]; then
  PATH="$HOME/.bun/bin:$PATH"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -n "${OMP_INSTALL_SH:-}" ]]; then
  INSTALL_SH="$OMP_INSTALL_SH"
elif [[ -x "$script_dir/../libexec/omp-custom/install.sh" ]]; then
  INSTALL_SH="$script_dir/../libexec/omp-custom/install.sh"
elif [[ -x "$ROOT/scripts/install.sh" ]]; then
  INSTALL_SH="$ROOT/scripts/install.sh"
elif [[ -x "$ROOT/libexec/install.sh" ]]; then
  INSTALL_SH="$ROOT/libexec/install.sh"
elif [[ -x "$script_dir/install.sh" ]]; then
  INSTALL_SH="$script_dir/install.sh"
elif [[ -x "$script_dir/../scripts/custom/install.sh" ]]; then
  INSTALL_SH="$script_dir/../scripts/custom/install.sh"
else
  INSTALL_SH="${OMP_INSTALL_SH:-$script_dir/../libexec/omp-custom/install.sh}"
fi

tag=""

notify_failure() {
  local msg="$*" ts
  ts="$(date -Is 2>/dev/null || date)"
  mkdir -p "$STATE" 2>/dev/null || true
  printf '%s\t%s\t%s\n' "$ts" "${tag:-unknown}" "$msg" >> "$STATE/last-failure" 2>/dev/null || true
  printf 'omp-daily-update FAILED (%s): %s\n' "${tag:-no-tag}" "$msg" >&2
  if [[ -n "${OMP_DAILY_NOTIFY_CMD:-}" ]]; then
    MESSAGE="omp-daily-update failed for ${tag:-no-tag}: $msg" TAG="${tag:-}" \
      sh -c "$OMP_DAILY_NOTIFY_CMD" 8>&- 9>&- || printf 'warning: OMP_DAILY_NOTIFY_CMD failed\n' >&2
  fi
  if command -v notify-send >/dev/null 2>&1 && [[ -n "${DBUS_SESSION_BUS_ADDRESS:-}" ]]; then
    notify-send -u critical "omp daily update failed" "$msg" 8>&- 9>&- 2>/dev/null || true
  fi
}

die() { notify_failure "$*"; exit 1; }

for cmd in gh df flock bun jq; do
  command -v "$cmd" >/dev/null || die "missing required command: $cmd"
done
[[ -x "$INSTALL_SH" ]] || die "installer not found at $INSTALL_SH (set OMP_INSTALL_SH or place install.sh in ~/.local/libexec/omp-custom/ or next to omp-daily-update.sh)"

mkdir -p "$ROOT" "$STATE"

# Concurrency: one daily-update at a time (its own lock), and never overlap an
# install/rollback (they share $ROOT/.lock; we take it for the decision, then
# release it before calling install.sh, which takes $ROOT/.lock itself with a
# non-blocking flock).
exec 8>"$ROOT/.daily-update.lock"
flock -n 8 || die "another omp-daily-update is already running"
exec 9>"$ROOT/.lock"
if ! flock -n 9; then
  echo "an omp-custom install or rollback is in progress; skipping this run"
  exit 0
fi

# 1. Discover the newest published custom release (paginating across all releases,
#    filtering out drafts and prereleases, and sorting globally by semver components).
tag="$(gh api "repos/$REPO/releases" --paginate --jq '
  .[] | select(.draft == false and .prerelease == false and (.tag_name | test("^custom-v[0-9]+\\.[0-9]+\\.[0-9]+(-c[0-9]+)?$"))) | .tag_name' | jq -R -s -r '
  split("\n") | map(select(length > 0))
  | map({
      tag: .,
      ver: (capture("^custom-v(?<maj>[0-9]+)\\.(?<min>[0-9]+)\\.(?<patch>[0-9]+)(-c(?<custom>[0-9]+))?$")
        | [ (.maj|tonumber), (.min|tonumber), (.patch|tonumber), ((.custom // "0")|tonumber) ])
    })
  | sort_by(.ver)
  | last | .tag // empty')" || die "could not list releases for $REPO"
[[ -n "$tag" ]] || die "no published custom-v* release found on $REPO"

# 2. Idempotency & regression guard: skip when already current; refuse older releases.
installed_marker="$STATE/installed-tag"
if [[ -f "$installed_marker" ]]; then
  installed_tag="$(tr -d '[:space:]' < "$installed_marker")"
  if [[ "$installed_tag" == "$tag" ]]; then
    echo "newest release $tag is already installed; nothing to do"
    exit 0
  fi
  is_older="$(jq -n --arg cur "$installed_tag" --arg new "$tag" '
    def parse_ver(v):
      v | capture("^custom-v(?<maj>[0-9]+)\\.(?<min>[0-9]+)\\.(?<patch>[0-9]+)(-c(?<custom>[0-9]+))?$")
      | [ (.maj|tonumber), (.min|tonumber), (.patch|tonumber), ((.custom // "0")|tonumber) ];
    try (
      (parse_ver($new) < parse_ver($cur))
    ) catch false
  ')"
  if [[ "$is_older" == "true" ]]; then
    die "discovered release $tag is older than installed tag $installed_tag; refusing regression"
  fi
fi

# 3. Disk guard: refuse before downloading anything.
avail="$(df --output=avail -B1 "$ROOT" | tail -n1)"
if [[ "$avail" -lt "$MIN_FREE" ]]; then
  die "disk guard: $avail bytes free on $(df --output=target "$ROOT" | tail -n1), need >= $MIN_FREE (OMP_DAILY_MIN_FREE); free space or raise the limit deliberately"
fi

# 4. Install; install.sh performs all verification and keeps previous as rollback.
#    Close fd 9 to release the lock and avoid leaking the descriptor to the child.
#    install.sh will acquire $ROOT/.lock itself.
exec 9>&-
echo "installing $tag"
install_output=""
if ! install_output="$("$INSTALL_SH" --tag "$tag" 8>&- 9>&- 2>&1)"; then
  echo "$install_output" >&2
  if [[ "$install_output" == *"another omp-custom install or rollback is running"* ]]; then
    echo "an omp-custom install or rollback began concurrently; skipping this run"
    exit 0
  fi
  die "install.sh failed for $tag; current installation is unchanged (rollback target kept)"
fi
echo "$install_output"
printf '%s\n' "$tag" > "$installed_marker"
rm -f "$STATE/last-failure"

# 5. Versions and rollback: preserve all installed versions and rollback symlinks.
#    Automatic version deletion is disabled by design to preserve complete rollback history.

echo "omp-daily-update: $tag installed; previous retained for rollback (scripts/custom/rollback.sh)"
