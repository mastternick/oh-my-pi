#!/usr/bin/env bash
# Behavioural tests for install-ai-conflicts.sh.
#
# Only the systemd client is faked: a stub `systemctl` on PATH records its arguments.
# Every assertion reads resulting filesystem state, never the helper's source text.
# The covered invariants are the ones a user can be hurt by:
#   * enabling writes the marker, the unit, and the drop-in, and nothing else;
#   * a user's own drop-ins, the daily service/timer, and the timer symlink survive
#     enable, repeated enable, refresh, and disable;
#   * --refresh restores a missing install only while the marker exists, and can never
#     enable the resolver on its own (it only cleans up its own stale drop-in);
#   * --disable removes only its own drop-in and the marker;
#   * a missing controller/adapter refuses instead of half-enabling;
#   * a host with no reachable user manager still installs.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_HELPER="$here/install-ai-conflicts.sh"
[[ -f "$SRC_HELPER" ]] || { printf 'helper not found: %s\n' "$SRC_HELPER" >&2; exit 1; }
[[ -f "$here/systemd/omp-ai-conflicts.service" ]] || { printf 'unit source not found\n' >&2; exit 1; }
[[ -f "$here/systemd/omp-daily-update.service.d/10-ai-conflicts.conf" ]] || { printf 'drop-in source not found\n' >&2; exit 1; }

workroot="$(mktemp -d "${TMPDIR:-/dev/shm}/omp-ai-install-test.XXXXXX")"
trap 'rm -rf -- "$workroot"' EXIT

pass=0
failures=0
# Set by sandbox(); initialised so each name is assigned before any read.
HELPER="" UNITS="" OUR_UNIT="" OUR_DROPIN="" USER_DROPIN="" MARKER="" ENV_FILE=""
DAILY_UNIT="" DAILY_TIMER="" TIMER_LINK="" LOG="" RUN_RC=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { failures=$((failures + 1)); printf 'FAIL %s\n' "$1" >&2; }
is() { # label expected actual
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want '$2', got '$3')"; fi
}
exists() { if [[ -e "$2" ]]; then ok "$1"; else bad "$1 (missing $2)"; fi; }
absent() { if [[ ! -e "$2" ]]; then ok "$1"; else bad "$1 (unexpected $2)"; fi; }
same() { if cmp -s -- "$2" "$3"; then ok "$1"; else bad "$1 ($2 differs)"; fi; }

# sandbox <name>: private home, config root, install root, libexec, runtime dir, and a
# stub systemctl. <with-assets> also stages dummy controller/adapter assets next to a
# copy of the helper and its unit sources, so the test never depends on their content.
sandbox() {
  local name="$1" with_assets="$2" box
  box="$workroot/$name"
  mkdir -p "$box/home" "$box/config/systemd/user/omp-daily-update.service.d" \
    "$box/config/systemd/user/timers.target.wants" "$box/root" "$box/libexec" "$box/bin" "$box/run"
  # shellcheck disable=SC2016 # the generated stub expands $* when it runs, not now
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >>"%s"\n' "$box/systemctl.log" >"$box/bin/systemctl"
  chmod 755 "$box/bin/systemctl"

  # Content the helper must never touch.
  printf '[Unit]\nDescription=daily installer\n' >"$box/config/systemd/user/omp-daily-update.service"
  printf '[Timer]\nOnCalendar=*-*-* 05:40:00\n' >"$box/config/systemd/user/omp-daily-update.timer"
  printf '[Service]\nNice=5\n' >"$box/config/systemd/user/omp-daily-update.service.d/20-user-tuning.conf"
  ln -s ../omp-daily-update.timer "$box/config/systemd/user/timers.target.wants/omp-daily-update.timer"

  mkdir -p "$box/plugin/systemd/omp-daily-update.service.d"
  cp -- "$SRC_HELPER" "$box/plugin/install-ai-conflicts.sh"
  chmod 755 "$box/plugin/install-ai-conflicts.sh"
  cp -- "$here/systemd/omp-ai-conflicts.service" "$box/plugin/systemd/omp-ai-conflicts.service"
  cp -- "$here/systemd/omp-daily-update.service.d/10-ai-conflicts.conf" \
    "$box/plugin/systemd/omp-daily-update.service.d/10-ai-conflicts.conf"
  if [[ "$with_assets" == yes ]]; then
    printf '#!/bin/sh\nexit 0\n' >"$box/plugin/ai-conflict-controller.sh"
    printf '// test adapter placeholder\n' >"$box/plugin/ai-conflict-model.ts"
  fi

  export HOME="$box/home"
  export XDG_CONFIG_HOME="$box/config"
  export XDG_RUNTIME_DIR="$box/run"
  export OMP_CUSTOM_HOME="$box/root"
  export OMP_CUSTOM_LIBEXEC="$box/libexec"
  export PATH="$box/bin:$PATH"
  HELPER="$box/plugin/install-ai-conflicts.sh"
  UNITS="$box/config/systemd/user"
  OUR_UNIT="$UNITS/omp-ai-conflicts.service"
  OUR_DROPIN="$UNITS/omp-daily-update.service.d/10-ai-conflicts.conf"
  USER_DROPIN="$UNITS/omp-daily-update.service.d/20-user-tuning.conf"
  MARKER="$box/root/state/ai-conflicts/enabled"
  ENV_FILE="$box/config/omp-custom/ai-conflicts.env"
  DAILY_UNIT="$UNITS/omp-daily-update.service"
  DAILY_TIMER="$UNITS/omp-daily-update.timer"
  TIMER_LINK="$UNITS/timers.target.wants/omp-daily-update.timer"
  LOG="$box/systemctl.log"
}

# run <args...>: helper exit status, stderr swallowed into a per-box file.
run() {
  local rc=0
  "$HELPER" "$@" >"$workroot/out.log" 2>"$workroot/err.log" || rc=$?
  RUN_RC="$rc"
}

# --- main flow: enable / re-enable / refresh / disable ---------------------------------
sandbox main yes
cp -- "$DAILY_UNIT" "$workroot/daily.service.orig"
cp -- "$DAILY_TIMER" "$workroot/daily.timer.orig"
cp -- "$USER_DROPIN" "$workroot/user-dropinv.orig"

run --enable
is "enable exits 0" 0 "$RUN_RC"
exists "enable writes the opt-in marker" "$MARKER"
exists "enable installs the oneshot unit" "$OUR_UNIT"
exists "enable installs the daily drop-in" "$OUR_DROPIN"
exists "enable leaves the user drop-in" "$USER_DROPIN"
exists "enable leaves the timer symlink" "$TIMER_LINK"
same "enable leaves the daily service untouched" "$DAILY_UNIT" "$workroot/daily.service.orig"
same "enable leaves the daily timer untouched" "$DAILY_TIMER" "$workroot/daily.timer.orig"
same "enable leaves the user drop-in byte-identical" "$USER_DROPIN" "$workroot/user-dropinv.orig"
is "enable writes nothing else into the drop-in dir" "10-ai-conflicts.conf 20-user-tuning.conf" \
  "$(find "$UNITS/omp-daily-update.service.d" -maxdepth 1 -type f -printf '%f\n' | sort | tr '\n' ' ' | sed 's/ $//')"
is "enable asks the user manager to reload" 1 "$(grep -c 'daemon-reload' "$LOG" 2>/dev/null || true)"
exists "enable deploys the controller asset" "$OMP_CUSTOM_LIBEXEC/ai-conflict-controller.sh"
exists "enable deploys the adapter asset" "$OMP_CUSTOM_LIBEXEC/ai-conflict-model.ts"
exists "enable creates the env template" "$ENV_FILE"

run --enable
is "second enable exits 0" 0 "$RUN_RC"
exists "second enable keeps the marker" "$MARKER"
same "second enable leaves the user drop-in byte-identical" "$USER_DROPIN" "$workroot/user-dropinv.orig"
is "second enable keeps one drop-in of its own" 1 \
  "$(find "$UNITS/omp-daily-update.service.d" -maxdepth 1 -name '10-ai-conflicts.conf' | wc -l)"

rm -f -- "$OUR_UNIT" "$OUR_DROPIN"
run --refresh
is "refresh while opted in exits 0" 0 "$RUN_RC"
exists "refresh restores the unit" "$OUR_UNIT"
exists "refresh restores the drop-in" "$OUR_DROPIN"
exists "refresh keeps the marker" "$MARKER"
same "refresh leaves the user drop-in byte-identical" "$USER_DROPIN" "$workroot/user-dropinv.orig"

printf 'settings kept by the user\n' >"$ENV_FILE"
run --disable
is "disable exits 0" 0 "$RUN_RC"
absent "disable removes the marker" "$MARKER"
absent "disable removes its own drop-in" "$OUR_DROPIN"
exists "disable keeps the user drop-in" "$USER_DROPIN"
same "disable leaves the user drop-in byte-identical" "$USER_DROPIN" "$workroot/user-dropinv.orig"
exists "disable keeps the daily service" "$DAILY_UNIT"
same "disable leaves the daily timer untouched" "$DAILY_TIMER" "$workroot/daily.timer.orig"
exists "disable keeps the timer symlink" "$TIMER_LINK"
is "disable keeps the user's env settings" "settings kept by the user" "$(cat "$ENV_FILE")"
is "disable is limited to its own files" "20-user-tuning.conf" \
  "$(find "$UNITS/omp-daily-update.service.d" -maxdepth 1 -type f -printf '%f\n' | sort | tr '\n' ' ' | sed 's/ $//')"

run --disable
is "second disable exits 0" 0 "$RUN_RC"
exists "second disable keeps the user drop-in" "$USER_DROPIN"

run --refresh
is "refresh while opted out exits 0" 0 "$RUN_RC"
absent "refresh while opted out creates no marker" "$MARKER"
absent "refresh while opted out creates no drop-in" "$OUR_DROPIN"
exists "refresh while opted out keeps the user drop-in" "$USER_DROPIN"

# A stale drop-in left by hand is cleaned up, but that must not opt the user in.
printf '[Unit]\nWants=omp-ai-conflicts.service\n' >"$OUR_DROPIN"
run --refresh
is "refresh removes a stale drop-in" 0 "$RUN_RC"
absent "refresh removes only the stale drop-in" "$OUR_DROPIN"
exists "refresh keeps the user drop-in next to it" "$USER_DROPIN"
absent "refresh never enables on its own" "$MARKER"

# --- the shape install.sh uses: helper run from the deployed libexec dir ---------------
sandbox deployed yes
mkdir -p "$OMP_CUSTOM_LIBEXEC/systemd/omp-daily-update.service.d"
cp -- "$here/systemd/omp-ai-conflicts.service" "$OMP_CUSTOM_LIBEXEC/systemd/omp-ai-conflicts.service"
cp -- "$here/systemd/omp-daily-update.service.d/10-ai-conflicts.conf" \
  "$OMP_CUSTOM_LIBEXEC/systemd/omp-daily-update.service.d/10-ai-conflicts.conf"
cp -- "$SRC_HELPER" "$OMP_CUSTOM_LIBEXEC/install-ai-conflicts.sh"
chmod 755 "$OMP_CUSTOM_LIBEXEC/install-ai-conflicts.sh"
printf '#!/bin/sh\nexit 0\n' >"$OMP_CUSTOM_LIBEXEC/ai-conflict-controller.sh"
printf '// deployed adapter placeholder\n' >"$OMP_CUSTOM_LIBEXEC/ai-conflict-model.ts"
chmod 755 "$OMP_CUSTOM_LIBEXEC/ai-conflict-controller.sh"
cp -- "$OMP_CUSTOM_LIBEXEC/ai-conflict-controller.sh" "$workroot/deployed-controller.orig"
HELPER="$OMP_CUSTOM_LIBEXEC/install-ai-conflicts.sh"

mkdir -p "$(dirname "$MARKER")"
printf 'enabled\n' >"$MARKER"
run --enable
is "deployed enable exits 0" 0 "$RUN_RC"
same "deployed enable does not rewrite the asset in place" "$OMP_CUSTOM_LIBEXEC/ai-conflict-controller.sh" \
  "$workroot/deployed-controller.orig"
rm -f -- "$OUR_UNIT" "$OUR_DROPIN"
run --refresh
is "deployed refresh exits 0" 0 "$RUN_RC"
exists "deployed refresh restores the unit from libexec" "$OUR_UNIT"
exists "deployed refresh restores the drop-in from libexec" "$OUR_DROPIN"
exists "deployed refresh keeps the marker" "$MARKER"
same "deployed refresh leaves the user drop-in byte-identical" "$USER_DROPIN" "$workroot/user-dropinv.orig"

# --- a missing asset refuses instead of half-enabling ---------------------------------
sandbox noassets no
run --enable
if [[ "$RUN_RC" -ne 0 ]]; then ok "enable without the controller refuses"; else bad "enable without the controller refuses (exit 0)"; fi
absent "refused enable writes no marker" "$MARKER"
absent "refused enable writes no unit" "$OUR_UNIT"
absent "refused enable writes no drop-in" "$OUR_DROPIN"
exists "refused enable keeps the user drop-in" "$USER_DROPIN"

# --- no reachable user manager --------------------------------------------------------
sandbox nomanager yes
export XDG_RUNTIME_DIR="$workroot/nomanager/absent-runtime"
run --enable
is "enable without a reachable user manager exits 0" 0 "$RUN_RC"
exists "enable without a user manager still installs the marker" "$MARKER"
exists "enable without a user manager still installs the drop-in" "$OUR_DROPIN"
absent "enable without a user manager calls no systemctl" "$LOG"

printf '\n%d passed, %d failed\n' "$pass" "$failures"
[[ "$failures" -eq 0 ]]
