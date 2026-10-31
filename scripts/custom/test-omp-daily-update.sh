#!/usr/bin/env bash
# test-omp-daily-update.sh — sandbox tests for omp-daily-update.sh.
# Uses fake gh/install.sh; never touches the live omp-custom install.
# Usage: test-omp-daily-update.sh <path-to-omp-daily-update.sh>
# shellcheck disable=SC2015,SC2016 # `A && check N 1 || check N 0` is the intended pass/fail idiom (check never fails); single-quoted env-var programs are intentional
set -uo pipefail

SCRIPT_INPUT="${1:?usage: $0 <path-to-omp-daily-update.sh>}"
SCRIPT="$(cd "$(dirname "$SCRIPT_INPUT")" && pwd)/$(basename "$SCRIPT_INPUT")"
[[ -x "$SCRIPT" ]] || { echo "error: script $SCRIPT not executable" >&2; exit 2; }

SANDBOX="$(mktemp -d /dev/shm/omp-daily-test.XXXXXX)"
trap 'rm -rf "$SANDBOX"' EXIT

export OMP_CUSTOM_HOME="$SANDBOX/root"
export OMP_DAILY_STATE_DIR="$SANDBOX/root/state"
export HOME="$SANDBOX/home"
mkdir -p "$SANDBOX/bin" "$HOME" "$SANDBOX/root"

pass=0; fail=0
check() {
  local name="$1" ok="$2"
  if [[ "$ok" == "1" ]]; then pass=$((pass+1)); echo "PASS $name";
  else fail=$((fail+1)); echo "FAIL $name"; fi
}

# Fake gh: handles `api repos/.../releases` with optional `--paginate` and `--jq <filter>`.
# Models real GitHub CLI multi-page behavior in pure bash+jq: evaluates `--jq` per page chunk.
cat > "$SANDBOX/bin/gh" <<'GHEOF'
#!/usr/bin/env bash
is_releases=0
filter=""
paginate=0
per_page=30

for arg in "$@"; do
  if [[ "$arg" == *"releases"* ]]; then
    is_releases=1
    if [[ "$arg" =~ per_page=([0-9]+) ]]; then
      per_page="${BASH_REMATCH[1]}"
    fi
  fi
  if [[ "$arg" == "--paginate" ]]; then paginate=1; fi
done

if [[ "${1:-}" == "api" && $is_releases -eq 1 ]]; then
  jqf="${FAKE_RELEASES:?FAKE_RELEASES not set}"
  args=("$@")
  for i in "${!args[@]}"; do
    if [[ "${args[$i]}" == "--jq" ]]; then filter="${args[$((i+1))]}"; fi
  done

  len="$(jq 'if type == "array" then length else 0 end' "$jqf")"
  if [[ $len -eq 0 ]]; then
    if [[ -n "$filter" ]]; then jq -r "$filter" "$jqf"; else cat "$jqf"; fi
    exit 0
  fi

  off=0
  while [[ $off -lt $len ]]; do
    page="$(jq -c --argjson o "$off" --argjson n "$per_page" '.[$o:($o+$n)]' "$jqf")"
    if [[ -n "$filter" ]]; then
      printf '%s\n' "$page" | jq -r "$filter"
    else
      printf '%s\n' "$page"
    fi
    if [[ $paginate -eq 0 ]]; then break; fi
    off=$((off + per_page))
  done
  exit 0
fi
exec /usr/bin/gh "$@"
GHEOF
chmod +x "$SANDBOX/bin/gh"

# Fake installer: simulates real install.sh by actively contending/acquiring $ROOT/.lock (fd 9)
cat > "$SANDBOX/bin/install.sh" <<'INSTEOF'
#!/usr/bin/env bash
if [[ "${INSTALL_FAIL:-0}" == "1" ]]; then
  echo "fake install failure" >&2
  exit 1
fi
if [[ "${INSTALL_CONTENTION:-0}" == "1" ]]; then
  echo "error: another omp-custom install or rollback is running" >&2
  exit 1
fi
# Real install.sh takes $ROOT/.lock via lib.sh (flock -n 9).
# If omp-daily-update.sh failed to close/release its lock on $ROOT/.lock, this fails!
# Also verify fd 8 (.daily-update.lock) was not leaked to child.
if { true >&8; } 2>/dev/null; then
  echo "error: fd 8 leaked to child installer" >&2
  exit 1
fi
exec 9>"${OMP_CUSTOM_HOME}/.lock"
if ! flock -n 9; then
  echo "error: lock contention in install.sh ($ROOT/.lock still held by parent)" >&2
  exit 1
fi
ver="${2#custom-v}"
old="$(readlink "$OMP_CUSTOM_HOME/current" 2>/dev/null || true)"
mkdir -p "$OMP_CUSTOM_HOME/versions/$ver"
if [[ -n "$old" ]]; then ln -sfn "$old" "$OMP_CUSTOM_HOME/previous"; fi
ln -sfn "versions/$ver" "$OMP_CUSTOM_HOME/current"
echo "$2" >> "${OMP_DAILY_STATE_DIR}/install-calls"
INSTEOF
chmod +x "$SANDBOX/bin/install.sh"

# Sibling libexec installer (for default path resolution test)
mkdir -p "$SANDBOX/libexec/omp-custom"
cp "$SANDBOX/bin/install.sh" "$SANDBOX/libexec/omp-custom/install.sh"
chmod +x "$SANDBOX/libexec/omp-custom/install.sh"

export PATH="$SANDBOX/bin:$PATH"
export OMP_INSTALL_SH="$SANDBOX/bin/install.sh"

# Base fixtures:
# Includes drafts, prereleases, and releases where created_at is NOT version order
cat > "$SANDBOX/releases.json" <<'EOF'
[
  {"tag_name": "custom-v18.12.6-c1", "draft": false, "prerelease": false, "created_at": "2026-10-20T10:00:00Z"},
  {"tag_name": "custom-v18.12.6-c4", "draft": false, "prerelease": false, "created_at": "2026-10-24T11:55:58Z"},
  {"tag_name": "custom-v18.12.6-c5", "draft": false, "prerelease": false, "created_at": "2026-10-26T12:47:08Z"},
  {"tag_name": "custom-v18.12.6-c3", "draft": false, "prerelease": false, "created_at": "2026-10-29T12:00:00Z"},
  {"tag_name": "custom-v18.14.0-rc1","draft": false, "prerelease": true,  "created_at": "2026-10-30T10:00:00Z"},
  {"tag_name": "draft-thing",         "draft": true,  "prerelease": false, "created_at": "2026-10-30T12:47:08Z"}
]
EOF
export FAKE_RELEASES="$SANDBOX/releases.json"

# 1. Fresh install picks highest semver non-draft, non-prerelease (c5 over recut c3 or rc1)
#    and fake installer takes $ROOT/.lock non-blocking (verifying lock handoff).
out="$("$SCRIPT" 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(cat "$OMP_DAILY_STATE_DIR/install-calls" 2>/dev/null)" == "custom-v18.12.6-c5" ]] \
  && check "1. installs newest semver non-draft/non-prerelease (lock handoff verified)" 1 \
  || { echo "$out"; check "1. installs newest semver non-draft/non-prerelease (lock handoff verified)" 0; }

# 1b. Numeric semver sort: c10 > c9 even if c9 was created later (proves numeric, not lexicographic/timestamp).
cat > "$SANDBOX/c10_releases.json" <<'EOF'
[
  {"tag_name": "custom-v18.12.6-c9",  "draft": false, "prerelease": false, "created_at": "2026-10-31T12:00:00Z"},
  {"tag_name": "custom-v18.12.6-c10", "draft": false, "prerelease": false, "created_at": "2026-10-25T12:00:00Z"}
]
EOF
export FAKE_RELEASES="$SANDBOX/c10_releases.json"
rm -f "$OMP_DAILY_STATE_DIR/installed-tag"
out="$("$SCRIPT" 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(tail -n1 "$OMP_DAILY_STATE_DIR/install-calls")" == "custom-v18.12.6-c10" ]] \
  && check "1b. numeric semver sort (c10 > c9, ignoring lexicographic & timestamp order)" 1 \
  || { echo "$out"; check "1b. numeric semver sort (c10 > c9, ignoring lexicographic & timestamp order)" 0; }
export FAKE_RELEASES="$SANDBOX/releases.json"
echo "custom-v18.12.6-c5" > "$OMP_DAILY_STATE_DIR/installed-tag"

# 2. Idempotency: second run makes no installer call.
before="$(wc -l < "$OMP_DAILY_STATE_DIR/install-calls")"
out="$("$SCRIPT" 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(wc -l < "$OMP_DAILY_STATE_DIR/install-calls")" == "$before" ]] \
  && check "2. idempotent second run" 1 || check "2. idempotent second run" 0

# 3. Regression guard: refuses when discovered tag is older than installed-tag.
echo "custom-v18.13.0" > "$OMP_DAILY_STATE_DIR/installed-tag"
out="$("$SCRIPT" 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"refusing regression"* && "$(wc -l < "$OMP_DAILY_STATE_DIR/install-calls")" == "$before" ]] \
  && check "3. regression guard refuses older release" 1 \
  || { echo "$out"; check "3. regression guard refuses older release" 0; }
echo "custom-v18.12.6-c5" > "$OMP_DAILY_STATE_DIR/installed-tag"

# 4. Prerelease and draft filtering:
#    Part A: prereleases excluded even when tag is BOTH highest semver and newest timestamp
#            (custom-v18.14.0-rc1 alongside custom-v18.12.6-c5).
cat > "$SANDBOX/prerelease_test.json" <<'EOF'
[
  {"tag_name": "custom-v18.14.0-rc1", "draft": false, "prerelease": true,  "created_at": "2026-10-30T12:00:00Z"},
  {"tag_name": "custom-v18.12.6-c5",  "draft": false, "prerelease": false, "created_at": "2026-10-26T12:00:00Z"},
  {"tag_name": "custom-v18.12.6-c1",  "draft": false, "prerelease": false, "created_at": "2026-10-20T10:00:00Z"}
]
EOF
export FAKE_RELEASES="$SANDBOX/prerelease_test.json"
rm -f "$OMP_DAILY_STATE_DIR/installed-tag"
out_a="$("$SCRIPT" 2>&1)"; rc_a=$?
call_a="$(tail -n1 "$OMP_DAILY_STATE_DIR/install-calls" 2>/dev/null)"

#    Part B: drafts and prereleases with valid semver tag regex are both filtered out;
#            refuses with descriptive error when no published non-draft/non-prerelease exists.
cat > "$SANDBOX/draft_prerelease_only.json" <<'EOF'
[
  {"tag_name": "custom-v19.0.0",     "draft": true,  "prerelease": false, "created_at": "2026-10-30T12:00:00Z"},
  {"tag_name": "custom-v19.0.0-rc1", "draft": false, "prerelease": true,  "created_at": "2026-10-30T10:00:00Z"}
]
EOF
export FAKE_RELEASES="$SANDBOX/draft_prerelease_only.json"
rm -f "$OMP_DAILY_STATE_DIR/installed-tag"
out_b="$("$SCRIPT" 2>&1)"; rc_b=$?

[[ $rc_a -eq 0 && "$call_a" == "custom-v18.12.6-c5" \
   && $rc_b -ne 0 && "$out_b" == *"no published custom-v* release found"* ]] \
  && check "4. prereleases and drafts filtered out (including empty discovery die path)" 1 \
  || { echo "Part A: rc=$rc_a out=$out_a"; echo "Part B: rc=$rc_b out=$out_b"; check "4. prereleases and drafts filtered out (including empty discovery die path)" 0; }
export FAKE_RELEASES="$SANDBOX/releases.json"
# 5. Pagination: fake gh serves >30 releases across multiple pages; highest semver is discovered
#    even when adversarial (highest semver on page 1, page 2 has lower-but-newer-on-page tags).
jq -n '
  [
    {"tag_name": "custom-v18.12.50", "draft": false, "prerelease": false, "created_at": "2026-10-30T00:00:00Z"}
  ] + [
    range(1; 30) | {"tag_name": "custom-v18.12.\(.)", "draft": false, "prerelease": false, "created_at": "2026-10-01T00:00:00Z"}
  ] + [
    range(30; 35) | {"tag_name": "custom-v18.12.\(.)", "draft": false, "prerelease": false, "created_at": "2026-10-15T00:00:00Z"}
  ]
' > "$SANDBOX/paged_releases.json"
export FAKE_RELEASES="$SANDBOX/paged_releases.json"
rm -f "$OMP_DAILY_STATE_DIR/installed-tag"
out="$("$SCRIPT" 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(tail -n1 "$OMP_DAILY_STATE_DIR/install-calls")" == "custom-v18.12.50" ]] \
  && check "5. multi-page pagination discovers release across >30 items (adversarial page order)" 1 \
  || { echo "$out"; check "5. multi-page pagination discovers release across >30 items (adversarial page order)" 0; }
export FAKE_RELEASES="$SANDBOX/releases.json"

# 6. Lock hand-off contention handling (D4):
# If another process grabs lock during hand-off, wrapper exits 0 with graceful skip.
rm -f "$OMP_DAILY_STATE_DIR/installed-tag"
export INSTALL_CONTENTION=1
out="$("$SCRIPT" 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" == *"began concurrently; skipping"* ]] \
  && check "6. lock hand-off contention skips gracefully (exit 0)" 1 \
  || { echo "$out"; check "6. lock hand-off contention skips gracefully (exit 0)" 0; }
unset INSTALL_CONTENTION

# 7. Concurrency: holding $ROOT/.lock makes the wrapper skip immediately (exit 0).
(
  flock 9
  out="$("$SCRIPT" 2>&1)"; rc=$?
  [[ $rc -eq 0 && "$out" == *"in progress; skipping"* ]] && echo skipped-ok
) 9>"$OMP_CUSTOM_HOME/.lock" > "$SANDBOX/skip.out"
grep -q skipped-ok "$SANDBOX/skip.out" && check "7. skips when install lock held" 1 || check "7. skips when install lock held" 0

# 8. Disk guard: absurd minimum free refuses before any installer call.
export OMP_DAILY_MIN_FREE=999999999999999
rm -f "$OMP_DAILY_STATE_DIR/installed-tag"
call_count_before="$(wc -l < "$OMP_DAILY_STATE_DIR/install-calls")"
out="$("$SCRIPT" 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"disk guard"* && "$(wc -l < "$OMP_DAILY_STATE_DIR/install-calls")" == "$call_count_before" ]] \
  && check "8. disk guard refuses" 1 || check "8. disk guard refuses" 0
[[ -s "$OMP_DAILY_STATE_DIR/last-failure" ]] \
  && check "8b. disk guard writes failure state" 1 || check "8b. disk guard writes failure state" 0
unset OMP_DAILY_MIN_FREE

# 9. Failure notification: installer failure records state and keeps marker absent.
export INSTALL_FAIL=1
out="$("$SCRIPT" 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"install.sh failed"* ]] && check "9. installer failure reported" 1 || check "9. installer failure reported" 0
grep -q "install.sh failed" "$OMP_DAILY_STATE_DIR/last-failure" && check "9b. failure state recorded" 1 || check "9b. failure state recorded" 0
[[ ! -f "$OMP_DAILY_STATE_DIR/installed-tag" ]] && check "9c. marker not written on failure" 1 || check "9c. marker not written on failure" 0
unset INSTALL_FAIL

# 10. Notify command is invoked with MESSAGE and TAG on failure.
export OMP_DAILY_NOTIFY_CMD='echo "NOTIFY:$TAG:$MESSAGE" >> "$FAKE_NOTIFY_OUT"'
export FAKE_NOTIFY_OUT="$SANDBOX/notify.out"
export INSTALL_FAIL=1
"$SCRIPT" >/dev/null 2>&1 || true
grep -q "NOTIFY:custom-v18.12.6-c5:" "$SANDBOX/notify.out" 2>/dev/null \
  && check "10. OMP_DAILY_NOTIFY_CMD invoked with TAG and MESSAGE" 1 \
  || check "10. OMP_DAILY_NOTIFY_CMD invoked with TAG and MESSAGE" 0
unset INSTALL_FAIL OMP_DAILY_NOTIFY_CMD FAKE_NOTIFY_OUT

# 11. Success clears state/last-failure (D11).
[[ -f "$OMP_DAILY_STATE_DIR/last-failure" ]] || echo "dummy failure" > "$OMP_DAILY_STATE_DIR/last-failure"
out="$("$SCRIPT" 2>&1)"; rc=$?
[[ $rc -eq 0 && ! -f "$OMP_DAILY_STATE_DIR/last-failure" ]] \
  && check "11. successful install clears state/last-failure" 1 \
  || check "11. successful install clears state/last-failure" 0

# 12. Versions and rollback preservation (no automatic version deletion):
# Creates versions c1, c2, c3, c4, c5. Current=c5, Previous=c4.
# Verifies all seeded versions and symlinks remain intact post-install, exit code is 0,
# and no "pruning" message appears in output.
mkdir -p "$OMP_CUSTOM_HOME/versions"/{18.12.6-c1,18.12.6-c2,18.12.6-c3,18.12.6-c4,18.12.6-c5}
ln -sfn "versions/18.12.6-c5" "$OMP_CUSTOM_HOME/current"
ln -sfn "versions/18.12.6-c4" "$OMP_CUSTOM_HOME/previous"
rm -f "$OMP_DAILY_STATE_DIR/installed-tag"
out="$("$SCRIPT" 2>&1)"; rc=$?
[[ $rc -eq 0 && "$out" != *"pruning"* \
   && -d "$OMP_CUSTOM_HOME/versions/18.12.6-c5" && -d "$OMP_CUSTOM_HOME/versions/18.12.6-c4" \
   && -d "$OMP_CUSTOM_HOME/versions/18.12.6-c3" \
   && -d "$OMP_CUSTOM_HOME/versions/18.12.6-c2" && -d "$OMP_CUSTOM_HOME/versions/18.12.6-c1" \
   && "$(readlink "$OMP_CUSTOM_HOME/current")" == "versions/18.12.6-c5" \
   && "$(readlink "$OMP_CUSTOM_HOME/previous")" == "versions/18.12.6-c4" ]] \
  && check "12. all installed versions and rollback links preserved (no automatic deletion)" 1 \
  || { echo "$out"; check "12. all installed versions and rollback links preserved (no automatic deletion)" 0; }
unset OMP_INSTALL_SH
WRAPPER_TEST_DIR="$SANDBOX/local/bin"
mkdir -p "$WRAPPER_TEST_DIR" "$SANDBOX/local/libexec/omp-custom"
cp "$SCRIPT" "$WRAPPER_TEST_DIR/omp-daily-update.sh"
cp "$SANDBOX/bin/install.sh" "$SANDBOX/local/libexec/omp-custom/install.sh"
chmod +x "$WRAPPER_TEST_DIR/omp-daily-update.sh" "$SANDBOX/local/libexec/omp-custom/install.sh"

rm -f "$OMP_DAILY_STATE_DIR/installed-tag"
out="$("$WRAPPER_TEST_DIR/omp-daily-update.sh" 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(tail -n1 "$OMP_DAILY_STATE_DIR/install-calls")" == "custom-v18.12.6-c5" ]] \
  && check "13. resolves default installer at ../libexec/omp-custom/install.sh" 1 \
  || { echo "$out"; check "13. resolves default installer at ../libexec/omp-custom/install.sh" 0; }

# 14. Missing installer diagnostic (D1):
rm -f "$SANDBOX/local/libexec/omp-custom/install.sh"
rm -f "$OMP_DAILY_STATE_DIR/installed-tag"
out="$("$WRAPPER_TEST_DIR/omp-daily-update.sh" 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"installer not found"* ]] \
  && check "14. missing installer fails with descriptive error" 1 \
  || { echo "$out"; check "14. missing installer fails with descriptive error" 0; }

# 15. Missing required command check (D2):
# Test when bun is not in PATH and not in ~/.bun/bin.
NO_BUN_HOME="$SANDBOX/no-bun-home"
mkdir -p "$NO_BUN_HOME"
out="$(HOME="$NO_BUN_HOME" PATH="/bin:/usr/bin" "$SCRIPT" 2>&1)"; rc=$?
[[ $rc -ne 0 && "$out" == *"missing required command: bun"* ]] \
  && check "15. missing required command aborts early" 1 \
  || { echo "$out"; check "15. missing required command aborts early" 0; }

export OMP_INSTALL_SH="$SANDBOX/bin/install.sh"
# 16. current already equals newest release with no marker (installed by hand): marker is
#     recorded, installer is NOT called, and previous (rollback target) stays untouched.
mkdir -p "$OMP_CUSTOM_HOME/versions"/{18.12.6-c4,18.12.6-c5}
ln -sfn "versions/18.12.6-c5" "$OMP_CUSTOM_HOME/current"
ln -sfn "versions/18.12.6-c4" "$OMP_CUSTOM_HOME/previous"
rm -f "$OMP_DAILY_STATE_DIR/installed-tag"
export FAKE_RELEASES="$SANDBOX/releases.json"
before="$(wc -l < "$OMP_DAILY_STATE_DIR/install-calls")"
out="$("$SCRIPT" 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(wc -l < "$OMP_DAILY_STATE_DIR/install-calls")" == "$before" \
   && "$(readlink "$OMP_CUSTOM_HOME/previous")" == "versions/18.12.6-c4" \
   && "$(cat "$OMP_DAILY_STATE_DIR/installed-tag")" == "custom-v18.12.6-c5" ]] \
  && check "16. current==newest without marker: marker written, no installer call, previous kept" 1 \
  || { echo "$out"; check "16. current==newest without marker: marker written, no installer call, previous kept" 0; }

# 16b. Fake installer relinks like the real one: previous <- old current, current <- new.
ln -sfn "versions/18.12.6-c4" "$OMP_CUSTOM_HOME/current"
ln -sfn "versions/18.12.6-c1" "$OMP_CUSTOM_HOME/previous"
rm -f "$OMP_DAILY_STATE_DIR/installed-tag"
out="$("$SCRIPT" 2>&1)"; rc=$?
[[ $rc -eq 0 && "$(tail -n1 "$OMP_DAILY_STATE_DIR/install-calls")" == "custom-v18.12.6-c5" \
   && "$(readlink "$OMP_CUSTOM_HOME/previous")" == "versions/18.12.6-c4" \
   && "$(readlink "$OMP_CUSTOM_HOME/current")" == "versions/18.12.6-c5" ]] \
  && check "16b. installer relinks previous<-old current, current<-new" 1 \
  || { echo "$out"; check "16b. installer relinks previous<-old current, current<-new" 0; }

echo "---"
echo "passed=$pass failed=$fail"
exit "$((fail > 0))"
