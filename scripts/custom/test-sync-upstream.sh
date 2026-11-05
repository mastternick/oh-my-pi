#!/usr/bin/env bash
# End-to-end tests for scripts/custom/sync-upstream.sh against real local git
# repositories (a bare "upstream" and a bare "origin") and a stateful fake `gh`.
# The fake models the GitHub API surfaces the pipeline trusts: workflow dispatch,
# run listing/polling, pull requests, and releases. Nothing here touches the network.
#
# Covered: clean merge + gate + fast-forward + tag + release; red/cancelled/timed-out
# CI; a run that tested the wrong commit; a concurrent advance of custom; already
# merged with a missing release; idempotent reruns; an explicitly requested new
# release; retrying a tag whose release failed; merge conflicts; reusing or
# refreshing a pre-existing sync branch without force-pushing or exiting early;
# refusing to reuse a lightweight tag at the candidate; a release API outage that must
# fail closed instead of reading as "no releases"; and a script argument that arrives
# relative, as CI passes it.
#
#   test-sync-upstream.sh [path/to/sync-upstream.sh]
set -uo pipefail
# shellcheck disable=SC2016 # jq programs are single-quoted on purpose
pass=0
fail=0
RC=0

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script_input="${1:-$script_dir/sync-upstream.sh}"
[[ -f "$script_input" ]] || { echo "missing script: $script_input" >&2; exit 1; }
# The runner below cds into fixture clones, so an argument that arrived relative to the
# caller's directory must be absolute before the first cd.
script="$(cd "$(dirname "$script_input")" && pwd)/$(basename "$script_input")"
# Set by the relative-argument check at the end of the suite: print the resolved path and
# exit before any fixture is created, so the check cannot recurse into the cases.
if [[ -n "${OMP_SYNC_TEST_RESOLVE_ONLY:-}" ]]; then
  printf '%s\n' "$script"
  exit 0
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/omp-sync-test.XXXXXX")"
trap '[[ -n "${KEEP:-}" ]] || rm -rf "$tmp"' EXIT
printf 'sandbox: %s\n' "$tmp"

export GIT_CONFIG_GLOBAL="$tmp/gitconfig"
export GIT_CONFIG_SYSTEM=/dev/null
git config --global user.name "omp sync test"
git config --global user.email "sync-test@example.invalid"
git config --global init.defaultBranch main
git config --global commit.gpgsign false
git config --global advice.detachedHead false

ok() { printf 'ok   %s\n' "$1"; pass=$((pass + 1)); }
bad() { printf 'FAIL %s: %s\n' "$1" "$2"; fail=$((fail + 1)); }

expect_rc() { # name expected actual
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "exit $3, want $2"; fi
}
expect_eq() { # name actual expected
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1" "want '$3', got '$2'"; fi
}
expect_nonempty() { # name value
  if [[ -n "$2" ]]; then ok "$1"; else bad "$1" "empty"; fi
}
expect_contains() { # name file needle
  if grep -qF -- "$3" "$2" 2>/dev/null; then
    ok "$1"
  else
    bad "$1" "missing '$3' in $2"
  fi
}
tag_commit() { # origin tag
  git --git-dir="$1" rev-parse --verify --quiet "refs/tags/$2^{commit}" || true
}
has_tag() { # origin tag
  git --git-dir="$1" show-ref --tags --verify --quiet "refs/tags/$2"
}
custom_sha() { git --git-dir="$1" rev-parse refs/heads/custom; }
count_runs() { # state-dir filter
  local file="$1/runs.json"
  if [[ -f "$file" ]]; then
    jq "[.[] | select($2)] | length" "$file"
  else
    echo 0
  fi
}

# --- fixtures ---------------------------------------------------------------------

up="$tmp/upstream.git"
git init -q --bare "$up"
seed="$tmp/seed"
git clone -q "$up" "$seed"
mkdir -p "$seed/packages/coding-agent"
printf '{"version":"18.15.0"}\n' > "$seed/packages/coding-agent/package.json"
printf 'base\n' > "$seed/shared.txt"
git -C "$seed" add -A
git -C "$seed" commit -qm "base 18.15"
git -C "$seed" tag v18.15.0
printf '{"version":"18.16.0"}\n' > "$seed/packages/coding-agent/package.json"
printf 'upstream 18.16\n' > "$seed/up-note.txt"
git -C "$seed" add -A
git -C "$seed" commit -qm "upstream 18.16"
git -C "$seed" tag v18.16.0
printf '{"version":"18.17.0"}\n' > "$seed/packages/coding-agent/package.json"
printf 'upstream conflict\n' > "$seed/shared.txt"
git -C "$seed" add -A
git -C "$seed" commit -qm "upstream 18.17"
git -C "$seed" tag v18.17.0
git -C "$seed" push -q origin 'refs/heads/*' 'refs/tags/*'

# new_origin <dir> <base-ref> <sync|merged>: custom branch diverged from upstream.
new_origin() {
  local dir="$1" base="$2" mode="$3" work
  git init -q --bare "$dir"
  git -C "$dir" symbolic-ref HEAD refs/heads/custom
  work="$tmp/origin-work.$RANDOM"
  git clone -q "$up" "$work"
  git -C "$work" checkout -q -b custom "$base"
  printf 'custom marker\n' > "$work/custom-note.txt"
  if [[ "$mode" == "sync" ]]; then
    # Touched by upstream v18.17.0, so merging that tag conflicts.
    printf 'custom line\n' > "$work/shared.txt"
  fi
  git -C "$work" add -A
  git -C "$work" commit -qm "custom change"
  git -C "$work" push -q "$dir" custom
  rm -rf "$work"
}

# --- stateful fake gh -------------------------------------------------------------

mkdir -p "$tmp/bin"
cat > "$tmp/bin/gh" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
state="${FAKE_GH_STATE:?}"
mkdir -p "$state"
runs="$state/runs.json"; [[ -f "$runs" ]] || echo '[]' > "$runs"
releases="$state/releases.json"; [[ -f "$releases" ]] || echo '[]' > "$releases"
prs="$state/prs.json"; [[ -f "$prs" ]] || echo '[]' > "$prs"
counter="$state/counter"; [[ -f "$counter" ]] || echo 1000 > "$counter"

resolve_ref() { # branch-or-tag -> commit sha (annotated tags peel to their commit)
  local ref="$1" sha
  sha="$(git --git-dir="$FAKE_ORIGIN" rev-parse --verify --quiet "refs/heads/$ref" || true)"
  if [[ -z "$sha" ]]; then
    sha="$(git --git-dir="$FAKE_ORIGIN" rev-parse --verify --quiet "refs/tags/$ref^{commit}" || true)"
  fi
  printf '%s\n' "$sha"
}

cmd="${1:-}"; shift || true
case "$cmd" in
  workflow)
    sub="${1:-}"; shift
    [[ "$sub" == "run" ]] || { echo "fake gh: unsupported workflow $sub" >&2; exit 1; }
    wf="${1:-}"; shift
    ref=""; input=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --ref) ref="$2"; shift 2 ;;
        -f) input="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    sha="$(resolve_ref "$ref")"
    [[ -n "$sha" ]] || { echo "fake gh: unknown ref $ref" >&2; exit 1; }
    case "$wf" in
      custom-ci.yml) result="${FAKE_CI_RESULT:-success}" ;;
      custom-release.yml) result="${FAKE_RELEASE_RESULT:-success}" ;;
      *) echo "fake gh: unknown workflow $wf" >&2; exit 1 ;;
    esac
    status="completed"; conclusion="success"
    case "$result" in
      success) ;;
      failure) conclusion="failure" ;;
      cancelled) conclusion="cancelled" ;;
      timeout) status="in_progress"; conclusion="" ;;
      wrongsha) sha="ffffffffffffffffffffffffffffffffffffffff" ;;
      *) echo "fake gh: unknown result $result" >&2; exit 1 ;;
    esac
    id="$(cat "$counter")"
    echo $((id + 1)) > "$counter"
    jq --argjson id "$id" --arg path ".github/workflows/$wf" --arg event workflow_dispatch \
      --arg branch "$ref" --arg sha "$sha" --arg status "$status" --arg conclusion "$conclusion" \
      '. + [{id:$id, path:$path, event:$event, head_branch:$branch, head_sha:$sha, status:$status, conclusion:$conclusion}]' \
      "$runs" > "$runs.tmp"
    mv "$runs.tmp" "$runs"
    if [[ "$wf" == "custom-release.yml" && "$result" == "success" && -n "$input" ]]; then
      tag="${input#tag=}"
      jq --arg t "$tag" '. + [{tag_name:$t, draft:false, prerelease:false}]' "$releases" > "$releases.tmp"
      mv "$releases.tmp" "$releases"
    fi
    exit 0
    ;;
  api)
    path="${1:-}"; shift
    jqf=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --jq) jqf="$2"; shift 2 ;;
        --paginate) shift ;;
        *) shift ;;
      esac
    done
    case "$path" in
      *"/actions/workflows/"*"/runs"*)
        data="$(jq '{total_count:(length), workflow_runs:.}' "$runs")"
        ;;
      *"/actions/runs/"*)
        id="${path##*/}"
        data="$(jq --argjson id "$id" 'map(select(.id == $id))[0] // {}' "$runs")"
        if [[ -n "${FAKE_RACE_REF:-}" && ! -f "$state/race-done" ]] \
          && [[ "$(jq -r '.status // ""' <<<"$data")" == "completed" ]] \
          && [[ "$(jq -r '.conclusion // ""' <<<"$data")" == "success" ]]; then
          race_sha="$(resolve_ref "$FAKE_RACE_REF")"
          git --git-dir="$FAKE_ORIGIN" update-ref refs/heads/custom "$race_sha"
          : > "$state/race-done"
        fi
        ;;
      *"/releases"*)
        if [[ -n "${FAKE_RELEASES_FAIL:-}" ]]; then
          echo "fake gh: releases api unavailable" >&2
          exit 1
        fi
        data="$(cat "$releases")"
        ;;
      *)
        echo "fake gh: unsupported api path $path" >&2
        exit 1
        ;;
    esac
    if [[ -n "$jqf" ]]; then
      printf '%s' "$data" | jq -r "$jqf"
    else
      printf '%s\n' "$data"
    fi
    exit 0
    ;;
  pr)
    sub="${1:-}"; shift
    case "$sub" in
      list)
        head=""; jqf=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --head) head="$2"; shift 2 ;;
            --state) shift 2 ;;
            --json) shift 2 ;;
            --jq) jqf="$2"; shift 2 ;;
            *) shift ;;
          esac
        done
        data="$(jq --arg h "$head" '[.[] | select(.head == $h and .state == "open")]' "$prs")"
        if [[ -n "$jqf" ]]; then printf '%s' "$data" | jq -r "$jqf"; else printf '%s\n' "$data"; fi
        exit 0
        ;;
      create)
        head=""
        while [[ $# -gt 0 ]]; do
          case "$1" in
            --head) head="$2"; shift 2 ;;
            --base|--title|--body-file) shift 2 ;;
            *) shift ;;
          esac
        done
        id="$(jq 'length + 1' "$prs")"
        jq --arg h "$head" --argjson id "$id" '. + [{number:$id, head:$h, state:"open"}]' "$prs" > "$prs.tmp"
        mv "$prs.tmp" "$prs"
        echo "https://example.invalid/pull/$id"
        exit 0
        ;;
      *) echo "fake gh: unsupported pr $sub" >&2; exit 1 ;;
    esac
    ;;
  *) echo "fake gh: unsupported command $cmd" >&2; exit 1 ;;
esac
FAKE
chmod 755 "$tmp/bin/gh"

# --- runner -----------------------------------------------------------------------

run_sync() { # dir origin [tag] [ENV=VAL...]
  local dir="$1" origin="$2" tagarg=""
  shift 2
  if [[ $# -gt 0 && "$1" != *=* ]]; then
    tagarg="$1"
    shift
  fi
  mkdir -p "$dir/state"
  rm -rf "$dir/work"
  git clone -q "$origin" "$dir/work"
  (
    cd "$dir/work" || exit 1
    env \
      PATH="$tmp/bin:$PATH" \
      FAKE_GH_STATE="$dir/state" \
      FAKE_ORIGIN="$origin" \
      GITHUB_STEP_SUMMARY="$dir/summary.md" \
      OMP_UPSTREAM_URL="$up" \
      OMP_SYNC_POLL=0.2 \
      OMP_SYNC_TIMEOUT=30 \
      "$@" \
      bash "$script" "$tagarg"
  ) >"$dir/out.log" 2>&1
  RC=$?
}

new_race_branch() { # origin
  local work
  work="$tmp/race.$RANDOM"
  git clone -q "$1" "$work"
  git -C "$work" checkout -q -b race origin/custom
  printf 'race\n' > "$work/race.txt"
  git -C "$work" add -A
  git -C "$work" commit -qm "race advance"
  git -C "$work" push -q origin race
  rm -rf "$work"
}

# --- 1. clean path ----------------------------------------------------------------
d="$tmp/cases/clean"; origin="$tmp/o-clean.git"
new_origin "$origin" v18.15.0 sync
before="$(custom_sha "$origin")"
run_sync "$d" "$origin" v18.16.0
expect_rc "clean: exits 0" 0 "$RC"
after="$(custom_sha "$origin")"
if [[ "$after" != "$before" ]]; then ok "clean: custom advanced"; else bad "clean: custom advanced" "still $after"; fi
expect_eq "clean: custom merge has two parents" "$(git --git-dir="$origin" cat-file -p "$after" | grep -c '^parent ')" 2
expect_eq "clean: tag points at the tested commit" "$(tag_commit "$origin" custom-v18.16.0-c1)" "$after"
expect_eq "clean: tag is annotated" "$(git --git-dir="$origin" cat-file -t refs/tags/custom-v18.16.0-c1)" "tag"
expect_eq "clean: one green ci run for the commit" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml" and .conclusion == "success" and .head_sha == "'"$after"'"')" 1
expect_eq "clean: one release run on the tag" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-release.yml" and .head_branch == "custom-v18.16.0-c1" and .conclusion == "success"')" 1
expect_eq "clean: release recorded" "$(jq -r '[.[] | select(.tag_name == "custom-v18.16.0-c1")] | length' "$d/state/releases.json")" 1
expect_eq "clean: sync branch pushed" \
  "$(git --git-dir="$origin" rev-parse --verify --quiet refs/heads/sync/upstream-v18.16.0 >/dev/null && echo yes || echo no)" "yes"
expect_eq "clean: sync PR opened" "$(jq 'length' "$d/state/prs.json")" 1
expect_contains "clean: reports the release" "$d/out.log" "release published"

# --- 2. red CI ---------------------------------------------------------------------
d="$tmp/cases/ci-failure"; origin="$tmp/o-ci-failure.git"
new_origin "$origin" v18.15.0 sync
before="$(custom_sha "$origin")"
run_sync "$d" "$origin" v18.16.0 FAKE_CI_RESULT=failure
expect_rc "red ci: exits non-zero" 1 "$RC"
expect_eq "red ci: custom unchanged" "$(custom_sha "$origin")" "$before"
expect_eq "red ci: no custom release tag" "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0
expect_contains "red ci: summary names the conclusion" "$d/summary.md" "concluded 'failure'"
expect_eq "red ci: no release dispatched" "$(count_runs "$d/state" '.path == ".github/workflows/custom-release.yml"')" 0

# --- 3. cancelled CI --------------------------------------------------------------
d="$tmp/cases/ci-cancel"; origin="$tmp/o-ci-cancel.git"
new_origin "$origin" v18.15.0 sync
before="$(custom_sha "$origin")"
run_sync "$d" "$origin" v18.16.0 FAKE_CI_RESULT=cancelled
expect_rc "cancelled ci: exits non-zero" 1 "$RC"
expect_eq "cancelled ci: custom unchanged" "$(custom_sha "$origin")" "$before"
expect_contains "cancelled ci: summary names the conclusion" "$d/summary.md" "concluded 'cancelled'"

# --- 4. CI timeout -----------------------------------------------------------------
d="$tmp/cases/ci-timeout"; origin="$tmp/o-ci-timeout.git"
new_origin "$origin" v18.15.0 sync
before="$(custom_sha "$origin")"
run_sync "$d" "$origin" v18.16.0 FAKE_CI_RESULT=timeout OMP_SYNC_TIMEOUT=1
expect_rc "timeout: exits non-zero" 1 "$RC"
expect_eq "timeout: custom unchanged" "$(custom_sha "$origin")" "$before"
expect_contains "timeout: summary reports the deadline" "$d/summary.md" "did not reach a successful conclusion"

# --- 5. run tested the wrong SHA ---------------------------------------------------
d="$tmp/cases/wrong-sha"; origin="$tmp/o-wrong-sha.git"
new_origin "$origin" v18.15.0 sync
before="$(custom_sha "$origin")"
run_sync "$d" "$origin" v18.16.0 FAKE_CI_RESULT=wrongsha
expect_rc "wrong sha: exits non-zero" 1 "$RC"
expect_eq "wrong sha: custom unchanged" "$(custom_sha "$origin")" "$before"
expect_contains "wrong sha: summary names the exact-SHA gate" "$d/summary.md" "not the exact candidate"
expect_eq "wrong sha: no tag" "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0

# --- 6. custom advanced while the gate ran ----------------------------------------
d="$tmp/cases/race"; origin="$tmp/o-race.git"
new_origin "$origin" v18.15.0 sync
new_race_branch "$origin"
run_sync "$d" "$origin" v18.16.0 FAKE_RACE_REF=race
expect_rc "race: exits non-zero" 1 "$RC"
expect_contains "race: summary refuses the untested advance" "$d/summary.md" "moved to"
expect_eq "race: custom is the concurrent tip" "$(custom_sha "$origin")" "$(git --git-dir="$origin" rev-parse refs/heads/race)"
expect_eq "race: no tag published" "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0

# --- 7. already merged, no release yet; then idempotent rerun ----------------------
d="$tmp/cases/merged"; origin="$tmp/o-merged.git"
new_origin "$origin" v18.16.0 merged
before="$(custom_sha "$origin")"
run_sync "$d" "$origin" v18.16.0
expect_rc "merged: exits 0" 0 "$RC"
expect_eq "merged: custom not rewound or advanced" "$(custom_sha "$origin")" "$before"
expect_eq "merged: tag points at the current custom HEAD" "$(tag_commit "$origin" custom-v18.16.0-c1)" "$before"
expect_eq "merged: release recorded" "$(jq -r '[.[] | select(.tag_name == "custom-v18.16.0-c1")] | length' "$d/state/releases.json")" 1
expect_eq "merged: ci dispatched on custom" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml" and .head_branch == "custom" and .head_sha == "'"$before"'"')" 1

runs_before="$(jq 'length' "$d/state/runs.json")"
tags_before="$(git --git-dir="$origin" tag -l 'custom-v*' | sort)"
run_sync "$d" "$origin" v18.16.0
expect_rc "rerun: exits 0" 0 "$RC"
expect_eq "rerun: no new workflow runs" "$(jq 'length' "$d/state/runs.json")" "$runs_before"
expect_eq "rerun: no new tags" "$(git --git-dir="$origin" tag -l 'custom-v*' | sort)" "$tags_before"
expect_contains "rerun: reports a no-op" "$d/out.log" "nothing to do"
expect_contains "rerun: summary marks the no-op" "$d/summary.md" "no-op"

# --- 8. explicitly requested new release ------------------------------------------
run_sync "$d" "$origin" v18.16.0 OMP_SYNC_FORCE_RELEASE=1
expect_rc "force release: exits 0" 0 "$RC"
expect_eq "force release: second tag at the same commit" "$(tag_commit "$origin" custom-v18.16.0-c2)" "$before"
expect_eq "force release: original tag preserved" "$(tag_commit "$origin" custom-v18.16.0-c1)" "$before"
expect_eq "force release: new release recorded" "$(jq -r '[.[] | select(.tag_name == "custom-v18.16.0-c2")] | length' "$d/state/releases.json")" 1
expect_eq "force release: green CI reused" "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 1
expect_eq "force release: release dispatched once more" "$(count_runs "$d/state" '.path == ".github/workflows/custom-release.yml"')" 2

# --- 9. failed release retried without duplicating tags or CI ----------------------
d="$tmp/cases/retry-release"; origin="$tmp/o-retry-release.git"
new_origin "$origin" v18.16.0 merged
before="$(custom_sha "$origin")"
run_sync "$d" "$origin" v18.16.0 FAKE_RELEASE_RESULT=failure
expect_rc "failed release: exits non-zero" 1 "$RC"
expect_eq "failed release: tag already published for retry" "$(tag_commit "$origin" custom-v18.16.0-c1)" "$before"
expect_eq "failed release: no release recorded" "$(jq 'length' "$d/state/releases.json")" 0
run_sync "$d" "$origin" v18.16.0
expect_rc "release retry: exits 0" 0 "$RC"
expect_eq "release retry: tag reused, not duplicated" "$(git --git-dir="$origin" tag -l 'custom-v18.16.0-c*' | wc -l | tr -d ' ')" 1
expect_eq "release retry: green CI reused" "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 1
expect_eq "release retry: release now recorded" "$(jq -r '[.[] | select(.tag_name == "custom-v18.16.0-c1")] | length' "$d/state/releases.json")" 1

# --- 10. release run for the wrong commit -----------------------------------------
d="$tmp/cases/release-wrong-sha"; origin="$tmp/o-release-wrong-sha.git"
new_origin "$origin" v18.16.0 merged
run_sync "$d" "$origin" v18.16.0 FAKE_RELEASE_RESULT=wrongsha
expect_rc "release wrong sha: exits non-zero" 1 "$RC"
expect_contains "release wrong sha: summary names the exact-SHA gate" "$d/summary.md" "not the exact candidate"
expect_eq "release wrong sha: no release recorded" "$(jq 'length' "$d/state/releases.json")" 0

# --- 11. merge conflict -----------------------------------------------------------
d="$tmp/cases/conflict"; origin="$tmp/o-conflict.git"
new_origin "$origin" v18.15.0 sync
before="$(custom_sha "$origin")"
run_sync "$d" "$origin" v18.17.0
expect_rc "conflict: exits non-zero" 1 "$RC"
expect_eq "conflict: custom unchanged" "$(custom_sha "$origin")" "$before"
expect_contains "conflict: summary is actionable" "$d/summary.md" "conflicts"
expect_eq "conflict: no sync branch pushed" \
  "$(git --git-dir="$origin" rev-parse --verify --quiet refs/heads/sync/upstream-v18.17.0 >/dev/null && echo yes || echo no)" "no"

# --- 12. pre-existing manually resolved sync branch is reused, not force-pushed ----
d="$tmp/cases/manual-branch"; origin="$tmp/o-manual-branch.git"
new_origin "$origin" v18.15.0 sync
work="$tmp/manual.$RANDOM"
git clone -q "$origin" "$work"
git -C "$work" checkout -q -b sync/upstream-v18.16.0 origin/custom
git -C "$work" fetch -q "$up" '+refs/tags/v*:refs/tags/v*'
git -C "$work" merge -q --no-ff --no-edit v18.16.0
printf 'manual resolution\n' > "$work/manual.txt"
git -C "$work" add -A
git -C "$work" commit -qm "manual fix"
git -C "$work" push -q origin sync/upstream-v18.16.0
old_tip="$(git --git-dir="$origin" rev-parse refs/heads/sync/upstream-v18.16.0)"
rm -rf "$work"
run_sync "$d" "$origin" v18.16.0
expect_rc "manual branch: exits 0" 0 "$RC"
after="$(custom_sha "$origin")"
expect_eq "manual branch: manual work preserved on custom" \
  "$(git --git-dir="$origin" cat-file -p "refs/heads/custom:manual.txt")" "manual resolution"
expect_eq "manual branch: push was a fast-forward of the old tip" \
  "$(git --git-dir="$origin" merge-base --is-ancestor "$old_tip" refs/heads/sync/upstream-v18.16.0 && echo yes || echo no)" "yes"
expect_eq "manual branch: tag points at the advanced custom" "$(tag_commit "$origin" custom-v18.16.0-c1)" "$after"

# --- 13. stale sync branch is refreshed instead of wedging the run -----------------
d="$tmp/cases/stale-branch"; origin="$tmp/o-stale-branch.git"
new_origin "$origin" v18.15.0 sync
work="$tmp/stale.$RANDOM"
git clone -q "$origin" "$work"
git -C "$work" checkout -q -b sync/upstream-v18.16.0 origin/custom
printf 'stale work\n' > "$work/stale.txt"
git -C "$work" add -A
git -C "$work" commit -qm "stale attempt"
git -C "$work" push -q origin sync/upstream-v18.16.0
rm -rf "$work"
run_sync "$d" "$origin" v18.16.0
expect_rc "stale branch: exits 0" 0 "$RC"
expect_eq "stale branch: stale work preserved" \
  "$(git --git-dir="$origin" cat-file -p "refs/heads/custom:stale.txt")" "stale work"
expect_eq "stale branch: released" "$(tag_commit "$origin" custom-v18.16.0-c1)" "$(custom_sha "$origin")"
expect_eq "stale branch: release dispatched for the tag" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-release.yml" and .head_branch == "custom-v18.16.0-c1"')" 1

# --- 14. a lightweight tag at the candidate is not reused -------------------------
# custom-release rejects non-annotated tags, so reusing one would dispatch a run that
# can only fail; the pipeline must publish the next cN instead.
d="$tmp/cases/lightweight-tag"; origin="$tmp/o-lightweight-tag.git"
new_origin "$origin" v18.16.0 merged
before="$(custom_sha "$origin")"
git --git-dir="$origin" tag custom-v18.16.0-c1 "$before"
run_sync "$d" "$origin" v18.16.0
expect_rc "lightweight tag: exits 0" 0 "$RC"
expect_eq "lightweight tag: left untouched" \
  "$(git --git-dir="$origin" cat-file -t refs/tags/custom-v18.16.0-c1)" "commit"
expect_eq "lightweight tag: next cN published at the candidate" \
  "$(tag_commit "$origin" custom-v18.16.0-c2)" "$before"
expect_eq "lightweight tag: new tag is annotated" \
  "$(git --git-dir="$origin" cat-file -t refs/tags/custom-v18.16.0-c2)" "tag"
expect_eq "lightweight tag: release recorded on the new tag" \
  "$(jq -r '[.[] | select(.tag_name == "custom-v18.16.0-c2")] | length' "$d/state/releases.json")" 1

# --- 15. release API outage is not read as "nothing published" ---------------------
# A failed release listing must abort before tagging or publishing: an empty list would
# make the pipeline publish a duplicate tag and release for a version that is already out.
d="$tmp/cases/releases-down"; origin="$tmp/o-releases-down.git"
new_origin "$origin" v18.16.0 merged
before="$(custom_sha "$origin")"
run_sync "$d" "$origin" v18.16.0 FAKE_RELEASES_FAIL=1
expect_rc "release api outage: exits non-zero" 1 "$RC"
expect_eq "release api outage: custom unchanged" "$(custom_sha "$origin")" "$before"
expect_eq "release api outage: no tag published" \
  "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0
expect_eq "release api outage: no ci dispatched" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 0
expect_eq "release api outage: no release dispatched" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-release.yml"')" 0
expect_eq "release api outage: no release recorded" "$(jq 'length' "$d/state/releases.json")" 0
expect_contains "release api outage: summary says why" "$d/summary.md" "release API error"

d="$tmp/cases/releases-down-sync"; origin="$tmp/o-releases-down-sync.git"
new_origin "$origin" v18.15.0 sync
run_sync "$d" "$origin" v18.16.0 FAKE_RELEASES_FAIL=1
expect_rc "release api outage on sync: exits non-zero" 1 "$RC"
expect_eq "release api outage on sync: gated commit still advanced custom" \
  "$(custom_sha "$origin")" "$(git --git-dir="$origin" rev-parse refs/heads/sync/upstream-v18.16.0)"
expect_eq "release api outage on sync: no tag published" \
  "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0
expect_eq "release api outage on sync: no release dispatched" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-release.yml"')" 0

# --- 16. a relative script argument resolves before the runner cds ------------------
# CI calls this suite as `scripts/custom/test-sync-upstream.sh scripts/custom/sync-upstream.sh`
# from the repository root, and the runner cds into each fixture clone, so the argument
# has to be absolute before the first cd. The nested run uses the resolution-only mode,
# which exits before any case, so it cannot recurse.
self_path="$script_dir/$(basename "${BASH_SOURCE[0]}")"
rel_self="$(cd "$tmp" && realpath --relative-to="$PWD" "$self_path")"
rel_script="$(cd "$tmp" && realpath --relative-to="$PWD" "$script")"
resolved="$(cd "$tmp" && OMP_SYNC_TEST_RESOLVE_ONLY=1 bash "$rel_self" "$rel_script" 2>&1)"
expect_eq "relative argument: resolves to the absolute script path" "$resolved" "$script"

# --- summary ----------------------------------------------------------------------
if (( fail > 0 )); then
  printf 'test-sync-upstream: %d failed, %d passed\n' "$fail" "$pass"
  exit 1
fi
printf 'test-sync-upstream: all %d checks passed\n' "$pass"
