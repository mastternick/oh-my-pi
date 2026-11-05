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
# fail closed instead of reading as "no releases"; workflow dispatch and PR commands
# that must name the fork explicitly because gh otherwise resolves the upstream project
# from this fork checkout; a dispatch rejected for missing permissions that must publish
# nothing; a script argument that arrives relative, as CI passes it; and review guards
# (expected base/tree SHAs) that accept exactly the reviewed candidate, reuse a green
# gate, and reject stale bases, wrong trees, refresh drift, malformed or half-supplied
# values, and any use on the release-only path instead of ignoring them; and a concurrent
# advance to a strict descendant of the gated candidate, which pushes and rewrites
# nothing yet still publishes exactly the reviewed/tested commit; and a release-only rerun
# after a failed release, which must reuse the unpublished tag at the tested candidate
# (never a new cN at the newer tip, never a lightweight or ungated tag, highest cN first).
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
count_releases() { # state-dir
  local file="$1/releases.json"
  if [[ -f "$file" ]]; then jq 'length' "$file"; else echo 0; fi
}
# The tree the script itself will build for a clean sync: merge origin/custom with the
# upstream tag exactly as the script does, so a guard test can name the reviewed tree.
merge_tree() { # origin tag
  local origin="$1" tag="$2" work tree
  work="$tmp/probe.$RANDOM"
  git clone -q "$origin" "$work"
  git -C "$work" checkout -q -B probe origin/custom
  git -C "$work" fetch -q "$up" '+refs/tags/v*:refs/tags/v*'
  git -C "$work" merge -q --no-ff --no-edit -m probe "refs/tags/$tag" >/dev/null 2>&1
  tree="$(git -C "$work" rev-parse 'HEAD^{tree}')"
  rm -rf "$work"
  printf '%s\n' "$tree"
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

# gh resolves the repository from the checkout when --repo/-R is absent. In a fork
# checkout that resolution can land on the upstream project, which is exactly the bug
# these tests pin: only an explicit --repo may reach the fixture fork.
trusted_repo="${FAKE_GH_REPO:?}"
implicit_repo="${FAKE_GH_IMPLICIT_REPO:-$trusted_repo}"
repo=""
args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    -R|--repo) repo="${2:-}"; shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
if (( ${#args[@]} )); then
  set -- "${args[@]}"
else
  set --
fi
target_repo="${repo:-$implicit_repo}"

require_trusted_repo() { # surface -> dies like gh when the target is not the fork
  [[ "$target_repo" == "$trusted_repo" ]] && return 0
  echo "fake gh: HTTP 404: $1 not found in $target_repo (https://api.github.com/repos/$target_repo)" >&2
  exit 1
}

case "$cmd" in
  workflow)
    sub="${1:-}"; shift
    [[ "$sub" == "run" ]] || { echo "fake gh: unsupported workflow $sub" >&2; exit 1; }
    wf="${1:-}"; shift
    require_trusted_repo "workflow $wf"
    if [[ -n "${FAKE_GH_DENY_DISPATCH:-}" ]]; then
      echo "HTTP 403: Resource not accessible by integration (https://api.github.com/repos/$target_repo/actions/workflows/$wf/dispatches)" >&2
      exit 1
    fi
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
      --arg repo "$target_repo" \
      '. + [{id:$id, path:$path, event:$event, head_branch:$branch, head_sha:$sha, status:$status, conclusion:$conclusion, repo:$repo}]' \
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
    [[ "$path" == "repos/$trusted_repo/"* ]] \
      || { echo "fake gh: HTTP 404: Not Found (https://api.github.com/$path)" >&2; exit 1; }
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
        if [[ -n "${FAKE_RUNS_FAIL:-}" ]]; then
          echo "fake gh: runs api unavailable" >&2
          exit 1
        fi
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
        if [[ -n "${FAKE_RACE_DESCENDANT:-}" && ! -f "$state/race-done" ]] \
          && [[ "$(jq -r '.path // ""' <<<"$data")" == ".github/workflows/custom-ci.yml" ]] \
          && [[ "$(jq -r '.status // ""' <<<"$data")" == "completed" ]] \
          && [[ "$(jq -r '.conclusion // ""' <<<"$data")" == "success" ]]; then
          # A concurrent actor lands one more commit directly on top of the commit that
          # was just gated, so origin/custom becomes a strict descendant of the candidate.
          tested="$(jq -r '.head_sha // ""' <<<"$data")"
          tested_tree="$(git --git-dir="$FAKE_ORIGIN" rev-parse "$tested^{tree}")"
          later="$(printf 'concurrent advance\n' \
            | git --git-dir="$FAKE_ORIGIN" commit-tree "$tested_tree" -p "$tested")"
          git --git-dir="$FAKE_ORIGIN" update-ref refs/heads/custom "$later"
          printf '%s\n' "$later" > "$state/race-descendant-sha"
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
    require_trusted_repo "pull request $sub"
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
      FAKE_GH_REPO=mastternick/oh-my-pi \
      FAKE_GH_IMPLICIT_REPO=can1357/oh-my-pi \
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
expect_eq "clean: both dispatches recorded in the fork" \
  "$(count_runs "$d/state" '.repo == "mastternick/oh-my-pi"')" 2
expect_eq "clean: nothing dispatched to upstream" \
  "$(count_runs "$d/state" '.repo == "can1357/oh-my-pi"')" 0
# The fixture only catches unqualified dispatches if gh's implicit resolution lands on
# upstream here (as it did on the real fork checkout), so pin that the refusal is live.
if (FAKE_GH_STATE="$d/state" FAKE_ORIGIN="$origin" FAKE_GH_REPO=mastternick/oh-my-pi \
  FAKE_GH_IMPLICIT_REPO=can1357/oh-my-pi \
  "$tmp/bin/gh" workflow run custom-ci.yml --ref custom) >"$d/unqualified.log" 2>&1; then
  bad "clean: unqualified dispatch is refused" "it succeeded"
else
  ok "clean: unqualified dispatch is refused"
fi
expect_contains "clean: refusal names the upstream repo" "$d/unqualified.log" "can1357/oh-my-pi"
expect_eq "clean: refused dispatch recorded no run" "$(jq 'length' "$d/state/runs.json")" 2
expect_eq "clean: refused dispatch recorded no release" "$(jq 'length' "$d/state/releases.json")" 1

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

# --- 16. a dispatch rejected for missing permissions publishes nothing -------------
# gh can refuse a dispatch (403) after the merge and sync-branch push; that refusal must
# fail the run without advancing custom, tagging, or creating a release.
d="$tmp/cases/dispatch-denied"; origin="$tmp/o-dispatch-denied.git"
new_origin "$origin" v18.15.0 sync
before="$(custom_sha "$origin")"
run_sync "$d" "$origin" v18.16.0 FAKE_GH_DENY_DISPATCH=1
expect_rc "dispatch denied: exits non-zero" 1 "$RC"
expect_eq "dispatch denied: custom unchanged" "$(custom_sha "$origin")" "$before"
expect_eq "dispatch denied: no tag published" \
  "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0
expect_eq "dispatch denied: no run recorded" "$(jq 'length' "$d/state/runs.json")" 0
expect_eq "dispatch denied: no release recorded" "$(jq 'length' "$d/state/releases.json")" 0
expect_eq "dispatch denied: no release dispatched" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-release.yml"')" 0
expect_contains "dispatch denied: error names the workflow and repo" "$d/out.log" \
  "could not dispatch custom-ci.yml on sync/upstream-v18.16.0 in mastternick/oh-my-pi"
expect_contains "dispatch denied: summary is actionable" "$d/summary.md" \
  "could not dispatch custom-ci.yml"

# --- 17. a relative script argument resolves before the runner cds ------------------
# CI calls this suite as `scripts/custom/test-sync-upstream.sh scripts/custom/sync-upstream.sh`
# from the repository root, and the runner cds into each fixture clone, so the argument
# has to be absolute before the first cd. The nested run uses the resolution-only mode,
# which exits before any case, so it cannot recurse.
self_path="$script_dir/$(basename "${BASH_SOURCE[0]}")"
rel_self="$(cd "$tmp" && realpath --relative-to="$PWD" "$self_path")"
rel_script="$(cd "$tmp" && realpath --relative-to="$PWD" "$script")"
resolved="$(cd "$tmp" && OMP_SYNC_TEST_RESOLVE_ONLY=1 bash "$rel_self" "$rel_script" 2>&1)"
expect_eq "relative argument: resolves to the absolute script path" "$resolved" "$script"

# --- 18. matched review guards accept exactly the reviewed candidate --------------
# A controller that resolved a conflicted merge supplies the base it resolved against
# and the tree it reviewed; when both match, the normal candidate flow runs unchanged.
d="$tmp/cases/review-guards"; origin="$tmp/o-review-guards.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(merge_tree "$origin" v18.16.0)"
run_sync "$d" "$origin" v18.16.0 \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$gtree"
expect_rc "guards: matched base and tree exit 0" 0 "$RC"
gafter="$(custom_sha "$origin")"
if [[ "$gafter" != "$gbase" ]]; then ok "guards: custom advanced"; else bad "guards: custom advanced" "still $gafter"; fi
expect_eq "guards: candidate tree is the reviewed tree" \
  "$(git --git-dir="$origin" rev-parse 'refs/heads/custom^{tree}')" "$gtree"
expect_eq "guards: reviewed base is an ancestor of the published commit" \
  "$(git --git-dir="$origin" merge-base --is-ancestor "$gbase" refs/heads/custom && echo yes || echo no)" "yes"
expect_eq "guards: tag points at the gated candidate" "$(tag_commit "$origin" custom-v18.16.0-c1)" "$gafter"
expect_eq "guards: one green ci run for the candidate" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml" and .conclusion == "success" and .head_sha == "'"$gafter"'"')" 1
expect_eq "guards: release recorded once" "$(count_releases "$d/state")" 1
expect_contains "guards: reports the release" "$d/out.log" "release published"

# --- 19. a base that advanced after the review rejects before any candidate work ---
# The stale base is a real commit: origin/custom moved on after the tree was reviewed.
d="$tmp/cases/review-stale-base"; origin="$tmp/o-review-stale-base.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(merge_tree "$origin" v18.16.0)"
work="$tmp/later.$RANDOM"
git clone -q "$origin" "$work"
git -C "$work" checkout -q custom
printf 'later custom\n' > "$work/later.txt"
git -C "$work" add -A
git -C "$work" commit -qm "later custom work"
git -C "$work" push -q origin custom
rm -rf "$work"
moved="$(custom_sha "$origin")"
run_sync "$d" "$origin" v18.16.0 \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$gtree"
expect_rc "stale base: exits non-zero" 1 "$RC"
expect_contains "stale base: names the reviewed base" "$d/summary.md" "does not match origin/custom"
expect_eq "stale base: custom untouched" "$(custom_sha "$origin")" "$moved"
expect_eq "stale base: no sync branch pushed" \
  "$(git --git-dir="$origin" rev-parse --verify --quiet refs/heads/sync/upstream-v18.16.0 >/dev/null && echo yes || echo no)" "no"
expect_eq "stale base: no ci dispatched" "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 0
expect_eq "stale base: no tag published" "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0
expect_eq "stale base: no release recorded" "$(count_releases "$d/state")" 0

# --- 20. a tree that is not the reviewed one is never pushed or gated --------------
d="$tmp/cases/review-wrong-tree"; origin="$tmp/o-review-wrong-tree.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
wrong_tree="$(git --git-dir="$origin" rev-parse 'refs/heads/custom^{tree}')"
run_sync "$d" "$origin" v18.16.0 \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$wrong_tree"
expect_rc "wrong tree: exits non-zero" 1 "$RC"
expect_contains "wrong tree: names the reviewed tree" "$d/summary.md" "not the reviewed tree"
expect_eq "wrong tree: custom unchanged" "$(custom_sha "$origin")" "$gbase"
expect_eq "wrong tree: no sync branch pushed" \
  "$(git --git-dir="$origin" rev-parse --verify --quiet refs/heads/sync/upstream-v18.16.0 >/dev/null && echo yes || echo no)" "no"
expect_eq "wrong tree: no ci dispatched" "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 0
expect_eq "wrong tree: no tag published" "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0
expect_eq "wrong tree: no release recorded" "$(count_releases "$d/state")" 0

# --- 21. malformed guard values fail before anything is fetched or dispatched ------
d="$tmp/cases/review-malformed"; origin="$tmp/o-review-malformed.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(merge_tree "$origin" v18.16.0)"
run_sync "$d" "$origin" v18.16.0 \
  OMP_SYNC_EXPECTED_BASE_SHA="${gbase:0:12}" OMP_SYNC_EXPECTED_TREE_SHA="$gtree"
expect_rc "malformed base: exits non-zero" 1 "$RC"
expect_contains "malformed base: rejects a short SHA" "$d/summary.md" "not a full git commit SHA"
run_sync "$d" "$origin" v18.16.0 \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="HEAD"
expect_rc "malformed tree: exits non-zero" 1 "$RC"
expect_contains "malformed tree: rejects a non-SHA" "$d/summary.md" "not a full git tree SHA"
expect_eq "malformed guards: custom unchanged" "$(custom_sha "$origin")" "$gbase"
expect_eq "malformed guards: no sync branch pushed" \
  "$(git --git-dir="$origin" rev-parse --verify --quiet refs/heads/sync/upstream-v18.16.0 >/dev/null && echo yes || echo no)" "no"
expect_eq "malformed guards: no run recorded" "$(count_runs "$d/state" 'true')" 0
expect_eq "malformed guards: no tag published" "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0

# --- 22. a partial pair is rejected instead of half-applied -------------------------
d="$tmp/cases/review-partial"; origin="$tmp/o-review-partial.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(merge_tree "$origin" v18.16.0)"
run_sync "$d" "$origin" v18.16.0 OMP_SYNC_EXPECTED_BASE_SHA="$gbase"
expect_rc "partial base: exits non-zero" 1 "$RC"
expect_contains "partial base: requires the pair" "$d/summary.md" "must be supplied together"
run_sync "$d" "$origin" v18.16.0 OMP_SYNC_EXPECTED_TREE_SHA="$gtree"
expect_rc "partial tree: exits non-zero" 1 "$RC"
expect_contains "partial tree: requires the pair" "$d/summary.md" "must be supplied together"
expect_eq "partial guards: custom unchanged" "$(custom_sha "$origin")" "$gbase"
expect_eq "partial guards: no run recorded" "$(count_runs "$d/state" 'true')" 0
expect_eq "partial guards: no tag published" "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0

# --- 23. a refresh that would change the reviewed tree is rejected ------------------
# Work pushed to the sync branch after the review changes the refreshed tree; the tree
# guard must stop the run before that candidate is pushed or gated.
d="$tmp/cases/review-refresh-drift"; origin="$tmp/o-review-refresh-drift.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(merge_tree "$origin" v18.16.0)"
work="$tmp/drift.$RANDOM"
git clone -q "$origin" "$work"
git -C "$work" checkout -q -b sync/upstream-v18.16.0 origin/custom
printf 'unreviewed\n' > "$work/unreviewed.txt"
git -C "$work" add -A
git -C "$work" commit -qm "unreviewed sync work"
git -C "$work" push -q origin sync/upstream-v18.16.0
rm -rf "$work"
sync_tip="$(git --git-dir="$origin" rev-parse refs/heads/sync/upstream-v18.16.0)"
run_sync "$d" "$origin" v18.16.0 \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$gtree"
expect_rc "refresh drift: exits non-zero" 1 "$RC"
expect_contains "refresh drift: names the reviewed tree" "$d/summary.md" "not the reviewed tree"
expect_eq "refresh drift: custom unchanged" "$(custom_sha "$origin")" "$gbase"
expect_eq "refresh drift: sync branch not rewritten" \
  "$(git --git-dir="$origin" rev-parse refs/heads/sync/upstream-v18.16.0)" "$sync_tip"
expect_eq "refresh drift: no ci dispatched" "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 0
expect_eq "refresh drift: no tag published" "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0

# --- 24. the reviewed base still has to hold when the gate passes ------------------
d="$tmp/cases/review-race"; origin="$tmp/o-review-race.git"
new_origin "$origin" v18.15.0 sync
new_race_branch "$origin"
gbase="$(custom_sha "$origin")"
gtree="$(merge_tree "$origin" v18.16.0)"
run_sync "$d" "$origin" v18.16.0 FAKE_RACE_REF=race \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$gtree"
expect_rc "guarded race: exits non-zero" 1 "$RC"
expect_contains "guarded race: names the stale reviewed base" "$d/summary.md" "reviewed base"
expect_eq "guarded race: custom is the concurrent tip" \
  "$(custom_sha "$origin")" "$(git --git-dir="$origin" rev-parse refs/heads/race)"
expect_eq "guarded race: no tag published" "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0
expect_eq "guarded race: no release dispatched" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-release.yml"')" 0

# --- 25. release-only runs reject guards instead of ignoring them ------------------
# When upstream is already merged there is no conflicted candidate to bind; accepting
# the guards here would falsely assure the caller that a reviewed tree was published.
d="$tmp/cases/review-release-only"; origin="$tmp/o-review-release-only.git"
new_origin "$origin" v18.16.0 merged
gbase="$(custom_sha "$origin")"
gtree="$(git --git-dir="$origin" rev-parse 'refs/heads/custom^{tree}')"
run_sync "$d" "$origin" v18.16.0 \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$gtree"
expect_rc "release-only guards: exits non-zero" 1 "$RC"
expect_contains "release-only guards: says upstream is already merged" "$d/summary.md" "already merged"
expect_contains "release-only guards: says the guards were not ignored" "$d/summary.md" "refusing to accept guards"
expect_eq "release-only guards: custom unchanged" "$(custom_sha "$origin")" "$gbase"
expect_eq "release-only guards: no ci dispatched" "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 0
expect_eq "release-only guards: no tag published" "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0
expect_eq "release-only guards: no release recorded" "$(count_releases "$d/state")" 0

# --- 26. guards keep the green-gate reuse path bound to the reviewed base ----------
# A run that passed the gate and then died must be able to reuse that green run instead
# of paying for CI twice; pinned commit dates make the second run build the identical
# candidate, so the base and tree guards must still hold across the reuse.
d="$tmp/cases/review-ci-reuse"; origin="$tmp/o-review-ci-reuse.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(merge_tree "$origin" v18.16.0)"
pin=2026-01-01T00:00:00Z
run_sync "$d" "$origin" v18.16.0 GIT_AUTHOR_DATE="$pin" GIT_COMMITTER_DATE="$pin" \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$gtree" \
  FAKE_RELEASE_RESULT=failure
expect_rc "guarded retry: the first run fails at release" 1 "$RC"
candidate_now="$(custom_sha "$origin")"
expect_eq "guarded retry: the reviewed candidate was gated and advanced" \
  "$(git --git-dir="$origin" merge-base --is-ancestor "$gbase" refs/heads/custom && echo yes || echo no)" "yes"
expect_eq "guarded retry: candidate carries the reviewed tree" \
  "$(git --git-dir="$origin" rev-parse 'refs/heads/custom^{tree}')" "$gtree"
# Rewind the fixture to the reviewed base, drop the tag and the pushed sync branch, and
# keep the green CI run so the retry must reuse it.
git --git-dir="$origin" update-ref refs/heads/custom "$gbase"
git --git-dir="$origin" tag -d custom-v18.16.0-c1 >/dev/null
git --git-dir="$origin" update-ref -d refs/heads/sync/upstream-v18.16.0
run_sync "$d" "$origin" v18.16.0 GIT_AUTHOR_DATE="$pin" GIT_COMMITTER_DATE="$pin" \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$gtree"
expect_rc "guarded retry: exits 0" 0 "$RC"
expect_eq "guarded retry: lands the same reviewed candidate" "$(custom_sha "$origin")" "$candidate_now"
expect_eq "guarded retry: green ci reused, not dispatched twice" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 1
expect_eq "guarded retry: tag published at the candidate" \
  "$(tag_commit "$origin" custom-v18.16.0-c1)" "$candidate_now"
expect_eq "guarded retry: release recorded" "$(count_releases "$d/state")" 1

# --- 27. a pre-resolved conflicted sync branch passes the guards and publishes -----
# The reviewed resolution lives on the sync branch: seeded from origin/custom it merges
# v18.16.0 for real, conflicts on the package version, and commits the resolved content.
# The guards describe that base and that tree, so the guarded run must publish exactly
# the reviewed resolution without force-pushing the branch it came from.
d="$tmp/cases/review-resolved-branch"; origin="$tmp/o-review-resolved-branch.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
work="$tmp/resolved.$RANDOM"
git clone -q "$origin" "$work"
git -C "$work" checkout -q -b sync/upstream-v18.16.0 origin/custom
git -C "$work" fetch -q "$up" '+refs/tags/v*:refs/tags/v*'
printf '{"version":"18.15.0","custom":"reviewed resolution"}\n' \
  > "$work/packages/coding-agent/package.json"
git -C "$work" commit -qam "custom package marker"
if git -C "$work" merge -q --no-ff --no-edit v18.16.0 >/dev/null 2>&1; then
  bad "resolved branch: fixture merge conflicts" "v18.16.0 merged without a conflict"
else
  ok "resolved branch: fixture merge conflicts"
fi
printf '{"version":"18.16.0","custom":"reviewed resolution"}\n' \
  > "$work/packages/coding-agent/package.json"
git -C "$work" add -A
git -C "$work" commit -qm "resolve the v18.16.0 version conflict"
git -C "$work" push -q origin sync/upstream-v18.16.0
sync_tip="$(git --git-dir="$origin" rev-parse refs/heads/sync/upstream-v18.16.0)"
gtree="$(git --git-dir="$origin" rev-parse "$sync_tip^{tree}")"
rm -rf "$work"
run_sync "$d" "$origin" v18.16.0 \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$gtree"
expect_rc "resolved branch: exits 0" 0 "$RC"
gcustom="$(custom_sha "$origin")"
if [[ "$gcustom" != "$gbase" ]]; then
  ok "resolved branch: custom advanced"
else
  bad "resolved branch: custom advanced" "still $gcustom"
fi
expect_eq "resolved branch: custom holds the reviewed tree" \
  "$(git --git-dir="$origin" rev-parse 'refs/heads/custom^{tree}')" "$gtree"
expect_eq "resolved branch: reviewed base is an ancestor of custom" \
  "$(git --git-dir="$origin" merge-base --is-ancestor "$gbase" refs/heads/custom && echo yes || echo no)" "yes"
expect_eq "resolved branch: resolution content survived on custom" \
  "$(git --git-dir="$origin" show 'refs/heads/custom:packages/coding-agent/package.json')" \
  '{"version":"18.16.0","custom":"reviewed resolution"}'
expect_eq "resolved branch: sync branch fast-forwarded, not forced" \
  "$(git --git-dir="$origin" merge-base --is-ancestor "$sync_tip" refs/heads/sync/upstream-v18.16.0 && echo yes || echo no)" "yes"
expect_eq "resolved branch: exactly one green ci run for the candidate" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml" and .conclusion == "success" and .head_sha == "'"$gcustom"'"')" 1
expect_eq "resolved branch: tag published at the candidate" \
  "$(tag_commit "$origin" custom-v18.16.0-c1)" "$gcustom"
expect_eq "resolved branch: release recorded" "$(count_releases "$d/state")" 1

# --- 28. a guarded run survives a concurrent advance that already contains it ------
# origin/custom gains one commit directly on top of the exact gated candidate while the
# gate runs. The candidate is then an ancestor of the new tip: nothing to push and
# nothing to rewrite, no stale-base failure, and the reviewed/tested commit is still the
# one that gets tagged and released (never the newer, ungated tip).
d="$tmp/cases/review-race-descendant"; origin="$tmp/o-review-race-descendant.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(merge_tree "$origin" v18.16.0)"
run_sync "$d" "$origin" v18.16.0 FAKE_RACE_DESCENDANT=1 \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$gtree"
expect_rc "descendant race: exits 0" 0 "$RC"
tested="$(git --git-dir="$origin" rev-parse refs/heads/sync/upstream-v18.16.0)"
descendant="$(cat "$d/state/race-descendant-sha" 2>/dev/null || true)"
expect_nonempty "descendant race: the concurrent commit happened" "$descendant"
expect_eq "descendant race: custom is the concurrent tip, not rewritten" \
  "$(custom_sha "$origin")" "$descendant"
expect_eq "descendant race: the tip strictly descends from the tested candidate" \
  "$(git --git-dir="$origin" merge-base --is-ancestor "$tested" refs/heads/custom && echo yes || echo no)" "yes"
if [[ "$descendant" != "$tested" ]]; then
  ok "descendant race: custom was not reset to the candidate"
else
  bad "descendant race: custom was not reset to the candidate" "custom is the candidate"
fi
expect_eq "descendant race: candidate carries the reviewed tree" \
  "$(git --git-dir="$origin" rev-parse "$tested^{tree}")" "$gtree"
expect_eq "descendant race: tag points at the tested candidate" \
  "$(tag_commit "$origin" custom-v18.16.0-c1)" "$tested"
expect_eq "descendant race: exactly one green ci run, for the candidate" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml" and .conclusion == "success" and .head_sha == "'"$tested"'"')" 1
expect_eq "descendant race: no second ci dispatch" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 1
expect_eq "descendant race: release recorded once" "$(count_releases "$d/state")" 1
expect_eq "descendant race: release dispatched on the tag" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-release.yml" and .head_branch == "custom-v18.16.0-c1"')" 1
expect_contains "descendant race: reports the contained commit" "$d/out.log" \
  "already contains the tested commit"
expect_contains "descendant race: reports the release" "$d/out.log" "release published"

# --- 29. a failed release after a guarded containment run is retried on the same tag --
# The guarded sync gates the reviewed candidate, a concurrent actor adds a commit on top
# of it, the guards accept the contained candidate, the tag is pushed, and the release
# dispatch then fails. The next release-only rerun must publish that unpublished tag at
# the tested candidate: never a new cN at the newer, ungated tip, and never a rewrite.
d="$tmp/cases/reuse-release-after-failure"; origin="$tmp/o-reuse-release-after-failure.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(merge_tree "$origin" v18.16.0)"
run_sync "$d" "$origin" v18.16.0 FAKE_RACE_DESCENDANT=1 FAKE_RELEASE_RESULT=failure \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$gtree"
expect_rc "reuse: the guarded run dies at release" 1 "$RC"
tested="$(git --git-dir="$origin" rev-parse refs/heads/sync/upstream-v18.16.0)"
descendant="$(cat "$d/state/race-descendant-sha" 2>/dev/null || true)"
expect_nonempty "reuse: the concurrent descendant exists" "$descendant"
expect_eq "reuse: custom is the concurrent tip" "$(custom_sha "$origin")" "$descendant"
expect_eq "reuse: the tag was pushed at the tested candidate" \
  "$(tag_commit "$origin" custom-v18.16.0-c1)" "$tested"
expect_eq "reuse: the failed release published nothing" "$(count_releases "$d/state")" 0
run_sync "$d" "$origin" v18.16.0
expect_rc "reuse: the unguarded release-only retry exits 0" 0 "$RC"
expect_eq "reuse: custom keeps the concurrent tip" "$(custom_sha "$origin")" "$descendant"
expect_eq "reuse: no second tag was allocated" \
  "$(git --git-dir="$origin" tag -l 'custom-v18.16.0-c*' | wc -l | tr -d ' ')" 1
expect_eq "reuse: custom-v18.16.0-c2 was never created" \
  "$(git --git-dir="$origin" rev-parse --verify --quiet refs/tags/custom-v18.16.0-c2 >/dev/null && echo yes || echo no)" "no"
expect_eq "reuse: the tag was not moved" "$(tag_commit "$origin" custom-v18.16.0-c1)" "$tested"
expect_eq "reuse: green ci for the candidate reused, not dispatched again" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 1
expect_eq "reuse: release recorded on the reused tag" \
  "$(jq -r '[.[] | select(.tag_name == "custom-v18.16.0-c1")] | length' "$d/state/releases.json")" 1
expect_eq "reuse: released exactly once" "$(count_releases "$d/state")" 1
expect_eq "reuse: release dispatched on the reused tag" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-release.yml" and .head_branch == "custom-v18.16.0-c1" and .conclusion == "success"')" 1
expect_contains "reuse: reports the reused tag" "$d/out.log" \
  "reusing existing unpublished tag custom-v18.16.0-c1"
expect_contains "reuse: reports the tagged commit as contained" "$d/out.log" \
  "already contains the tagged commit"
expect_contains "reuse: reports the release" "$d/out.log" "release published"

# --- 30. an unpublished tag without an exact green CI run is never selected ----------
# The tag names a real ancestor of custom that contains the upstream commit, but that
# commit was never gated, so publishing it would ship untested code. The rerun must leave
# it unpublished and release a freshly gated commit instead.
d="$tmp/cases/reuse-needs-green-ci"; origin="$tmp/o-reuse-needs-green-ci.git"
new_origin "$origin" v18.16.0 merged
tip="$(custom_sha "$origin")"
ungated="$(git --git-dir="$origin" rev-parse "$tip^")"
git --git-dir="$origin" tag -a custom-v18.16.0-c1 -m "ungated candidate" "$ungated"
run_sync "$d" "$origin" v18.16.0
expect_rc "ungated tag: exits 0" 0 "$RC"
expect_eq "ungated tag: not selected, still unpublished" \
  "$(jq -r '[.[] | select(.tag_name == "custom-v18.16.0-c1")] | length' "$d/state/releases.json")" 0
expect_eq "ungated tag: left at its original commit" \
  "$(tag_commit "$origin" custom-v18.16.0-c1)" "$ungated"
expect_eq "ungated tag: the gated tip was released as the next cN" \
  "$(tag_commit "$origin" custom-v18.16.0-c2)" "$tip"
expect_eq "ungated tag: release recorded for the gated commit" \
  "$(jq -r '[.[] | select(.tag_name == "custom-v18.16.0-c2")] | length' "$d/state/releases.json")" 1
expect_eq "ungated tag: the tip was gated by ci" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml" and .conclusion == "success" and .head_sha == "'"$tip"'"')" 1
if grep -qF "reusing existing unpublished tag" "$d/out.log" 2>/dev/null; then
  bad "ungated tag: the ungated tag was not reused" "the run reused an ungated tag"
else
  ok "ungated tag: the ungated tag was not reused"
fi

# --- 31. the highest matching unpublished cN is chosen deterministically -------------
# Two unpublished tags name the same tested candidate. The retry must pick the higher cN,
# so a rerun after a partially created tag can never silently publish the older label.
d="$tmp/cases/reuse-highest-tag"; origin="$tmp/o-reuse-highest-tag.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(merge_tree "$origin" v18.16.0)"
run_sync "$d" "$origin" v18.16.0 FAKE_RACE_DESCENDANT=1 FAKE_RELEASE_RESULT=failure \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$gtree"
expect_rc "highest tag: the guarded run dies at release" 1 "$RC"
tested="$(git --git-dir="$origin" rev-parse refs/heads/sync/upstream-v18.16.0)"
git --git-dir="$origin" tag -a custom-v18.16.0-c3 -m "higher candidate label" "$tested"
run_sync "$d" "$origin" v18.16.0
expect_rc "highest tag: the retry exits 0" 0 "$RC"
expect_eq "highest tag: the highest unpublished cN was reused" \
  "$(jq -r '[.[] | select(.tag_name == "custom-v18.16.0-c3")] | length' "$d/state/releases.json")" 1
expect_eq "highest tag: the lower cN stayed unpublished" \
  "$(jq -r '[.[] | select(.tag_name == "custom-v18.16.0-c1")] | length' "$d/state/releases.json")" 0
expect_eq "highest tag: no fourth tag was allocated" \
  "$(git --git-dir="$origin" rev-parse --verify --quiet refs/tags/custom-v18.16.0-c4 >/dev/null && echo yes || echo no)" "no"
expect_eq "highest tag: both tags still name the tested candidate" \
  "$(tag_commit "$origin" custom-v18.16.0-c3)" "$tested"

# --- 32. an unreadable CI history never degrades into tagging the tip ---------------
# The only candidate tag cannot be checked for a green run. Reading that error as "not
# gated" would publish a new cN at the tip, so the run must fail closed instead.
d="$tmp/cases/reuse-runs-down"; origin="$tmp/o-reuse-runs-down.git"
new_origin "$origin" v18.16.0 merged
tip="$(custom_sha "$origin")"
git --git-dir="$origin" tag -a custom-v18.16.0-c1 -m "candidate" "$tip"
run_sync "$d" "$origin" v18.16.0 FAKE_RUNS_FAIL=1
expect_rc "runs api outage: exits non-zero" 1 "$RC"
expect_contains "runs api outage: names the unreadable run list" "$d/summary.md" \
  "while checking custom-v18.16.0-c1 for reuse"
expect_eq "runs api outage: custom unchanged" "$(custom_sha "$origin")" "$tip"
expect_eq "runs api outage: no new tag allocated" \
  "$(git --git-dir="$origin" tag -l 'custom-v18.16.0-c*' | wc -l | tr -d ' ')" 1
expect_eq "runs api outage: no release dispatched" \
  "$(count_runs "$d/state" '.path == ".github/workflows/custom-release.yml"')" 0
expect_eq "runs api outage: no release recorded" "$(count_releases "$d/state")" 0

# --- 33. AI review certificates bind the scheduled run without guard inputs --------
# ai-conflict-controller.sh records its reviewed merge as OMP-AI-* trailers on the sync
# branch. These helpers write the same shape: a commit whose tree is the reviewed tree,
# parented on origin/custom and the upstream tag, carrying the controller's trailers.
cert_model="opencode-go/deepseek-v4.1-flash"
cert_block() { # review base tree model
  printf 'OMP-AI-Conflict-Review: %s\nOMP-AI-Reviewed-Base: %s\nOMP-AI-Reviewed-Tree: %s\nOMP-AI-Model: %s\n' "$1" "$2" "$3" "$4"
}
reviewed_tree() { # origin -> tree of custom with the v18.16.0 resolution applied
  local origin="$1" work t
  work="$tmp/rt.$RANDOM"
  git clone -q "$origin" "$work"
  git -C "$work" checkout -q --detach origin/custom
  printf '{"version":"18.16.0"}\n' > "$work/packages/coding-agent/package.json"
  printf 'reviewed resolution\n' > "$work/shared.txt"
  git -C "$work" add -A
  t="$(git -C "$work" write-tree)"
  rm -rf "$work"
  printf '%s\n' "$t"
}
publish_cert_branch() { # origin trailers [bury] -> prints the pushed sync branch tip
  local origin="$1" trailers="$2" work base up_c tree msg tip
  work="$tmp/cert.$RANDOM"
  git clone -q "$origin" "$work"
  git -C "$work" fetch -q "$up" '+refs/tags/v*:refs/tags/v*'
  base="$(git -C "$work" rev-parse origin/custom)"
  up_c="$(git -C "$work" rev-parse 'refs/tags/v18.16.0^{commit}')"
  git -C "$work" checkout -q --detach "$base"
  printf '{"version":"18.16.0"}\n' > "$work/packages/coding-agent/package.json"
  printf 'reviewed resolution\n' > "$work/shared.txt"
  git -C "$work" add -A
  tree="$(git -C "$work" write-tree)"
  msg="$tmp/cert-msg.$RANDOM"
  printf 'chore(sync): merge upstream v18.16.0\n\n%s\n' "$trailers" > "$msg"
  tip="$(git -C "$work" commit-tree "$tree" -p "$base" -p "$up_c" -F "$msg")"
  if [[ "${3:-}" == bury ]]; then
    tip="$(printf 'manual follow-up\n' | git -C "$work" commit-tree "$tree" -p "$tip")"
  fi
  git -C "$work" push -q origin "$tip:refs/heads/sync/upstream-v18.16.0"
  rm -rf "$work"
  printf '%s\n' "$tip"
}

d="$tmp/cases/cert-schedule"; origin="$tmp/o-cert-schedule.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(reviewed_tree "$origin")"
tip="$(publish_cert_branch "$origin" "$(cert_block v1 "$gbase" "$gtree" "$cert_model")")"
run_sync "$d" "$origin" v18.16.0
expect_rc "cert schedule: exits 0 with no guard inputs" 0 "$RC"
expect_contains "cert schedule: reports the bound certificate" "$d/out.log" \
  "AI review certificate on sync/upstream-v18.16.0"
expect_eq "cert schedule: candidate carries the reviewed tree" \
  "$(git --git-dir="$origin" rev-parse 'refs/heads/custom^{tree}')" "$gtree"
expect_eq "cert schedule: reviewed base is an ancestor of custom" \
  "$(git --git-dir="$origin" merge-base --is-ancestor "$gbase" refs/heads/custom && echo yes || echo no)" "yes"
expect_eq "cert schedule: sync branch advanced, not rewritten" \
  "$(git --git-dir="$origin" merge-base --is-ancestor "$tip" refs/heads/sync/upstream-v18.16.0 && echo yes || echo no)" "yes"
expect_eq "cert schedule: tag points at the gated candidate" \
  "$(tag_commit "$origin" custom-v18.16.0-c1)" "$(custom_sha "$origin")"
expect_eq "cert schedule: release recorded once" "$(count_releases "$d/state")" 1

# --- 34. a certificate buried under a later commit is still enforced ---------------
d="$tmp/cases/cert-buried"; origin="$tmp/o-cert-buried.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(reviewed_tree "$origin")"
publish_cert_branch "$origin" "$(cert_block v1 "$gbase" "$gtree" "$cert_model")" bury >/dev/null
run_sync "$d" "$origin" v18.16.0
expect_rc "cert buried: exits 0 with no guard inputs" 0 "$RC"
expect_eq "cert buried: candidate carries the reviewed tree" \
  "$(git --git-dir="$origin" rev-parse 'refs/heads/custom^{tree}')" "$gtree"
expect_eq "cert buried: release recorded once" "$(count_releases "$d/state")" 1

# --- 35. a certificate naming a tree other than its commit tree stops the run ------
d="$tmp/cases/cert-wrong-tree"; origin="$tmp/o-cert-wrong-tree.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
wrong_tree="$(git --git-dir="$origin" rev-parse 'refs/heads/custom^{tree}')"
tip="$(publish_cert_branch "$origin" "$(cert_block v1 "$gbase" "$wrong_tree" "$cert_model")")"
run_sync "$d" "$origin" v18.16.0
expect_rc "cert wrong tree: exits non-zero" 1 "$RC"
expect_contains "cert wrong tree: names the certificate" "$d/summary.md" "AI review certificate on"
expect_eq "cert wrong tree: custom unchanged" "$(custom_sha "$origin")" "$gbase"
expect_eq "cert wrong tree: sync branch not rewritten" \
  "$(git --git-dir="$origin" rev-parse refs/heads/sync/upstream-v18.16.0)" "$tip"
expect_eq "cert wrong tree: no ci dispatched" "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 0
expect_eq "cert wrong tree: no tag published" "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0

# --- 36. malformed, ambiguous, or misplaced certificates fail before any mutation -----
for variant in missing-model duplicate-base version-v2 wrong-model short-base unknown-key prose-trailer; do
  d="$tmp/cases/cert-$variant"; origin="$tmp/o-cert-$variant.git"
  new_origin "$origin" v18.15.0 sync
  gbase="$(custom_sha "$origin")"
  gtree="$(reviewed_tree "$origin")"
  case "$variant" in
    missing-model)
      trailers="$(cert_block v1 "$gbase" "$gtree" "$cert_model" | grep -v '^OMP-AI-Model:')"
      want="is missing OMP-AI-Model" ;;
    duplicate-base)
      trailers="$(cert_block v1 "$gbase" "$gtree" "$cert_model")"$'\n'"OMP-AI-Reviewed-Base: $gbase"
      want="appears twice" ;;
    version-v2)
      trailers="$(cert_block v2 "$gbase" "$gtree" "$cert_model")"
      want="unsupported AI review certificate version" ;;
    wrong-model)
      trailers="$(cert_block v1 "$gbase" "$gtree" "other-model")"
      want="was produced by" ;;
    short-base)
      trailers="$(cert_block v1 "${gbase:0:12}" "$gtree" "$cert_model")"
      want="not a full commit SHA" ;;
    unknown-key)
      trailers="$(cert_block v1 "$gbase" "$gtree" "$cert_model")"$'\n'"OMP-AI-Job: sync-x"
      want="unsupported AI review trailer" ;;
    prose-trailer)
      trailers="$(cert_block v1 "$gbase" "$gtree" "$cert_model")"$'\n\n'"Reviewed by hand."
      want="outside its trailer block" ;;
  esac
  tip="$(publish_cert_branch "$origin" "$trailers")"
  run_sync "$d" "$origin" v18.16.0
  expect_rc "cert $variant: exits non-zero" 1 "$RC"
  expect_contains "cert $variant: summary names the defect" "$d/summary.md" "$want"
  expect_eq "cert $variant: custom unchanged" "$(custom_sha "$origin")" "$gbase"
  expect_eq "cert $variant: sync branch not rewritten" \
    "$(git --git-dir="$origin" rev-parse refs/heads/sync/upstream-v18.16.0)" "$tip"
  expect_eq "cert $variant: no ci dispatched" "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 0
  expect_eq "cert $variant: no tag published" "$(git --git-dir="$origin" tag -l 'custom-v*' | wc -l | tr -d ' ')" 0
done

d="$tmp/cases/cert-ambiguous"; origin="$tmp/o-cert-ambiguous.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(reviewed_tree "$origin")"
tip="$(publish_cert_branch "$origin" "$(cert_block v1 "$gbase" "$gtree" "$cert_model")")"
second="$(printf 'second review\n\n%s\n' "$(cert_block v1 "$gbase" "$gtree" "$cert_model")" \
  | git --git-dir="$origin" commit-tree "$gtree" -p "$tip")"
git --git-dir="$origin" update-ref refs/heads/sync/upstream-v18.16.0 "$second"
run_sync "$d" "$origin" v18.16.0
expect_rc "cert ambiguous: exits non-zero" 1 "$RC"
expect_contains "cert ambiguous: names the ambiguity" "$d/summary.md" "ambiguous"
expect_eq "cert ambiguous: custom unchanged" "$(custom_sha "$origin")" "$gbase"
expect_eq "cert ambiguous: no ci dispatched" "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 0

# --- 37. a certificate whose base moved cleanly is stale, not re-bound ---------------
d="$tmp/cases/cert-stale-base"; origin="$tmp/o-cert-stale-base.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(reviewed_tree "$origin")"
tip="$(publish_cert_branch "$origin" "$(cert_block v1 "$gbase" "$gtree" "$cert_model")")"
work="$tmp/cert-later.$RANDOM"
git clone -q "$origin" "$work"
git -C "$work" checkout -q custom
printf 'later custom\n' > "$work/later.txt"
git -C "$work" add -A
git -C "$work" commit -qm "later custom work"
git -C "$work" push -q origin custom
rm -rf "$work"
moved="$(custom_sha "$origin")"
run_sync "$d" "$origin" v18.16.0
expect_rc "cert stale base: exits non-zero" 1 "$RC"
expect_contains "cert stale base: names the reviewed base" "$d/summary.md" "does not match origin/custom"
expect_eq "cert stale base: custom untouched" "$(custom_sha "$origin")" "$moved"
expect_eq "cert stale base: sync branch not rewritten" \
  "$(git --git-dir="$origin" rev-parse refs/heads/sync/upstream-v18.16.0)" "$tip"
expect_eq "cert stale base: no ci dispatched" "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 0

# --- 38. explicit guards must agree with the certificate ----------------------------
d="$tmp/cases/cert-guard-mismatch"; origin="$tmp/o-cert-guard-mismatch.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(reviewed_tree "$origin")"
publish_cert_branch "$origin" "$(cert_block v1 "$gbase" "$gtree" "$cert_model")" >/dev/null
run_sync "$d" "$origin" v18.16.0 \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$(git --git-dir="$origin" rev-parse 'refs/heads/custom^{tree}')"
expect_rc "guard mismatch: exits non-zero" 1 "$RC"
expect_contains "guard mismatch: names the certificate" "$d/summary.md" "do not match the AI review certificate"
expect_eq "guard mismatch: custom unchanged" "$(custom_sha "$origin")" "$gbase"
expect_eq "guard mismatch: no ci dispatched" "$(count_runs "$d/state" '.path == ".github/workflows/custom-ci.yml"')" 0

d="$tmp/cases/cert-guard-match"; origin="$tmp/o-cert-guard-match.git"
new_origin "$origin" v18.15.0 sync
gbase="$(custom_sha "$origin")"
gtree="$(reviewed_tree "$origin")"
publish_cert_branch "$origin" "$(cert_block v1 "$gbase" "$gtree" "$cert_model")" >/dev/null
run_sync "$d" "$origin" v18.16.0 \
  OMP_SYNC_EXPECTED_BASE_SHA="$gbase" OMP_SYNC_EXPECTED_TREE_SHA="$gtree"
expect_rc "guard match: exits 0" 0 "$RC"
expect_eq "guard match: custom holds the reviewed tree" \
  "$(git --git-dir="$origin" rev-parse 'refs/heads/custom^{tree}')" "$gtree"
expect_eq "guard match: release recorded once" "$(count_releases "$d/state")" 1

# --- summary ----------------------------------------------------------------------
if (( fail > 0 )); then
  printf 'test-sync-upstream: %d failed, %d passed\n' "$fail" "$pass"
  exit 1
fi
printf 'test-sync-upstream: all %d checks passed\n' "$pass"
