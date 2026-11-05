#!/usr/bin/env bash
# Sync a stable upstream release into the custom branch, end to end.
#
#   1. merge the upstream tag into the bot sync branch (reusing an existing branch and
#      its manually resolved commits) and push it without force;
#   2. dispatch custom-ci on that exact commit and wait for a terminal result;
#   3. only after a green run, fast-forward custom to that exact tested commit (never
#      force, never rewrite history);
#   4. tag the tested commit as custom-v<X.Y.Z>-c<N> (annotated, immutable) and
#      dispatch custom-release on that tag;
#   5. wait for the release run and report it.
#
# Already-merged recovery: when the upstream tag is already on custom but its version
# has no published release (for example it was merged by hand), the current custom
# HEAD is gated with custom-ci and then tagged/released. When a release for that
# version already contains the upstream tag, the run is a no-op unless a new custom
# release is explicitly requested (OMP_SYNC_FORCE_RELEASE=1).
#
# A red, cancelled, timed-out, wrong-SHA, conflicting, or concurrently-advanced run
# never advances custom and never publishes a tag or release. Every failure writes a
# GitHub step summary when GITHUB_STEP_SUMMARY is set.
#
#   sync-upstream.sh [vX.Y.Z]     (default: newest stable upstream tag, or $UPSTREAM_TAG)
#
# Environment:
#   OMP_UPSTREAM_URL         upstream clone URL (default can1357/oh-my-pi)
#   OMP_CUSTOM_BRANCH        base branch (default custom)
#   OMP_CUSTOM_REPO          GitHub repo slug (default mastternick/oh-my-pi)
#   OMP_SYNC_CI_WORKFLOW     CI workflow file (default custom-ci.yml)
#   OMP_SYNC_RELEASE_WORKFLOW release workflow file (default custom-release.yml)
#   OMP_SYNC_TIMEOUT         seconds to wait for each dispatched run (default 7200)
#   OMP_SYNC_POLL            seconds between run polls (default 30)
#   OMP_SYNC_FORCE_RELEASE   1 = release the current custom HEAD even when this
#                            upstream version is already merged and released
#
# Requires: git, gh (authenticated), jq.
# shellcheck disable=SC2016 # jq programs use $name for their own arguments on purpose
set -euo pipefail

UPSTREAM_URL="${OMP_UPSTREAM_URL:-https://github.com/can1357/oh-my-pi.git}"
BASE="${OMP_CUSTOM_BRANCH:-custom}"
REPO="${OMP_CUSTOM_REPO:-mastternick/oh-my-pi}"
CI_WF="${OMP_SYNC_CI_WORKFLOW:-custom-ci.yml}"
REL_WF="${OMP_SYNC_RELEASE_WORKFLOW:-custom-release.yml}"
TIMEOUT="${OMP_SYNC_TIMEOUT:-7200}"
POLL="${OMP_SYNC_POLL:-30}"
FORCE_RELEASE="${OMP_SYNC_FORCE_RELEASE:-0}"

tag=""
candidate=""
mode=""

die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# GitHub step summary is the visible, actionable failure surface for the workflow run.
summary_line() {
  [[ -n "${GITHUB_STEP_SUMMARY:-}" ]] || return 0
  printf '%s\n' "$*" >> "$GITHUB_STEP_SUMMARY"
}

fail() {
  local msg="$*"
  printf 'error: %s\n' "$msg" >&2
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      printf '## custom-sync failed\n\n'
      printf '%s\n\n' "$msg"
      printf -- '- upstream tag: `%s`\n' "${tag:-unknown}"
      printf -- '- base branch: `%s`\n' "$BASE"
      printf -- '- this run did not advance `%s` and did not publish a tag or release\n' "$BASE"
      printf -- '- fix the cause and re-run; an existing sync branch, tag, or release is reused safely\n'
    } >> "$GITHUB_STEP_SUMMARY"
  fi
  exit 1
}

for cmd in git gh jq; do
  command -v "$cmd" >/dev/null || die "missing required command: $cmd"
done

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
git fetch --quiet --no-tags upstream '+refs/tags/v*:refs/tags/upstream/v*'
git fetch --quiet --force origin "+refs/heads/$BASE:refs/remotes/origin/$BASE" '+refs/tags/custom-v*:refs/tags/custom-v*'

# Resolve the upstream tag: explicit argument, $UPSTREAM_TAG, or the newest stable tag.
tag="${1:-${UPSTREAM_TAG:-}}"
if [[ -z "$tag" ]]; then
  tag="$(git tag --list 'upstream/v*' --sort=-v:refname \
    | grep -E '^upstream/v[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)"
  tag="${tag#upstream/}"
fi
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "not a stable upstream tag: '$tag'"
up_ref="refs/tags/upstream/$tag"
up_commit="$(git rev-parse --verify --quiet "$up_ref^{commit}")" || fail "upstream tag $tag not found"
tag_version="${tag#v}"

export GIT_AUTHOR_NAME="omp-custom-sync"
export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

# --- GitHub helpers ---------------------------------------------------------------

fetch_runs() { # workflow-file
  gh api "repos/$REPO/actions/workflows/$1/runs?per_page=100"
}

max_run_id() { # workflow-file
  fetch_runs "$1" | jq -r '[.workflow_runs[].id] | max // 0'
}

find_run_id() { # workflow-file ref before-id
  fetch_runs "$1" | jq -r --arg wf "$1" --arg ref "$2" --argjson before "$3" '
    [ .workflow_runs[]?
      | select(.id > $before)
      | select(.event == "workflow_dispatch")
      | select(.head_branch == $ref)
      | select(.path == (".github/workflows/" + $wf))
    ] | sort_by(.id) | last | .id // empty'
}

run_json() { # run-id
  gh api "repos/$REPO/actions/runs/$1"
}

# Reuse a completed successful run of the trusted workflow for this exact commit instead
# of paying for the same test matrix twice. Only push runs (the pushed commit is the
# tested commit) and dispatches (the ref tip is the tested commit) qualify.
successful_run_exists() { # workflow-file commit
  fetch_runs "$1" | jq -e --arg wf "$1" --arg sha "$2" '
    any(.workflow_runs[]?;
      .path == (".github/workflows/" + $wf)
      and .head_sha == $sha
      and .status == "completed" and .conclusion == "success"
      and (.event == "workflow_dispatch" or .event == "push"))' >/dev/null
}

# Poll until the dispatched run reaches a terminal state. The run must be the one
# dispatched for this ref, must run the expected workflow, and must have tested the
# exact candidate commit; anything else aborts instead of trusting a neighbouring run.
wait_for_run() { # workflow-file ref before-id label
  local wf="$1" ref="$2" before="$3" label="$4"
  local deadline id data status conclusion sha path branch
  deadline=$(( $(date +%s) + TIMEOUT ))
  while :; do
    id="$(find_run_id "$wf" "$ref" "$before")" || fail "could not list $wf runs"
    if [[ -n "$id" ]]; then
      data="$(run_json "$id")" || fail "could not read $wf run $id"
      status="$(jq -r '.status // ""' <<<"$data")"
      conclusion="$(jq -r '.conclusion // ""' <<<"$data")"
      sha="$(jq -r '.head_sha // ""' <<<"$data")"
      path="$(jq -r '.path // ""' <<<"$data")"
      branch="$(jq -r '.head_branch // ""' <<<"$data")"
      [[ "$path" == ".github/workflows/$wf" ]] || fail "$label run $id is not $wf (path: $path)"
      [[ "$branch" == "$ref" ]] || fail "$label run $id is for ref '$branch', not '$ref'"
      [[ "$sha" == "$candidate" ]] || fail "$label run $id tested $sha, not the exact candidate $candidate"
      if [[ "$status" == "completed" ]]; then
        [[ "$conclusion" == "success" ]] || fail "$label run $id concluded '$conclusion'"
        echo "$label: run $id succeeded for $candidate"
        return 0
      fi
    fi
    if (( $(date +%s) >= deadline )); then
      fail "$label did not reach a successful conclusion within ${TIMEOUT}s (run: ${id:-not found})"
    fi
    sleep "$POLL"
  done
}

# Published (non-draft, non-prerelease) release tags. The query is fail-closed: an API
# error must never be read as "nothing is published yet", because acting on that guess
# publishes a duplicate tag and release. Callers exit when this returns non-zero.
released_tags() {
  gh api "repos/$REPO/releases?per_page=100" --paginate \
    --jq '.[] | select(.draft == false and .prerelease == false) | .tag_name' \
    || fail "could not list releases for $REPO; refusing to treat a release API error as 'no releases'"
}

# True when a published release tag for this upstream version already contains the
# upstream commit. That is the "this version is already released" condition.
release_contains_upstream() { # version upstream-commit
  local version="$1" commit="$2" rtag rcommit published
  # Called from an if-condition, where set -e is suspended: without this explicit exit a
  # failed query would fall through and read as "not released".
  published="$(released_tags)" || exit 1
  while IFS= read -r rtag; do
    [[ "$rtag" =~ ^custom-v${version//./\\.}-c[0-9]+$ ]] || continue
    git fetch --quiet --force origin "+refs/tags/$rtag:refs/tags/$rtag" 2>/dev/null || continue
    rcommit="$(git rev-parse --verify --quiet "refs/tags/$rtag^{commit}" || true)"
    [[ -n "$rcommit" ]] || continue
    if git merge-base --is-ancestor "$commit" "$rcommit" 2>/dev/null; then
      return 0
    fi
  done <<<"$published"
  return 1
}

open_sync_pr() { # branch
  local branch="$1" body number
  body="$(mktemp)"
  cat > "$body" <<EOF
Merges upstream \`can1357/oh-my-pi\` $tag into \`$BASE\`.

The \`custom-sync\` workflow gates this exact commit with \`custom-ci\` and, only on a
green run, fast-forwards \`$BASE\` and publishes the release from the same commit.
This pull request is informational; close it once the release exists.
EOF
  number="$(gh pr list --head "$branch" --state open --json number --jq '.[0].number // empty' 2>/dev/null || true)"
  if [[ -z "$number" ]]; then
    gh pr create --base "$BASE" --head "$branch" \
      --title "Sync upstream $tag into $BASE" --body-file "$body" >/dev/null \
      || printf 'warning: could not open the sync PR; the workflow run is the gate\n' >&2
  fi
  rm -f "$body"
}

# --- Decide: sync a new upstream tag, gate current custom, or no-op ----------------

if git merge-base --is-ancestor "$up_commit" "refs/remotes/origin/$BASE"; then
  if [[ "$FORCE_RELEASE" != "1" ]] && release_contains_upstream "$tag_version" "$up_commit"; then
    echo "$tag is already merged into $BASE and released; nothing to do"
    summary_line "- no-op: upstream \`$tag\` is already merged and released."
    exit 0
  fi
  mode="release"
  candidate="$(git rev-parse "refs/remotes/origin/$BASE")"
  echo "$tag is already merged into $BASE; gating $candidate for a release"
else
  mode="sync"
  branch="sync/upstream-$tag"
  remote_ref="refs/remotes/origin/$branch"
  have_remote=0
  if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    git fetch --quiet --force origin "+refs/heads/$branch:$remote_ref"
    have_remote=1
  fi
  git checkout --quiet -B "$branch" "refs/remotes/origin/$BASE"
  if (( have_remote )); then
    # Never discard manually resolved work: merge the existing bot branch into the new
    # candidate so the push below stays a fast-forward.
    if ! git merge --quiet --no-ff --no-edit \
      -m "chore(sync): refresh $branch from existing sync work" "$remote_ref"; then
      git merge --abort 2>/dev/null || true
      fail "refreshing $branch onto origin/$BASE conflicts; resolve the sync branch by hand"
    fi
  fi
  if ! git merge-base --is-ancestor "$up_commit" HEAD; then
    if ! git merge --quiet --no-ff --no-edit -m "chore(sync): merge upstream $tag" "$up_commit"; then
      git merge --abort 2>/dev/null || true
      fail "merging $tag into $BASE conflicts; resolve locally and push $branch by hand"
    fi
  fi
  candidate="$(git rev-parse HEAD)"
  git push --quiet origin "HEAD:refs/heads/$branch" \
    || fail "could not update $branch without force; another run may have changed it"
  open_sync_pr "$branch"
fi

candidate_version="$(git show "$candidate:packages/coding-agent/package.json" | jq -r '.version // empty')"
[[ "$candidate_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] \
  || fail "could not read a stable package version from $candidate"
if [[ "$mode" == "sync" && "$candidate_version" != "$tag_version" ]]; then
  fail "upstream $tag carries package version $candidate_version, expected $tag_version"
fi
version="$candidate_version"

# --- Gate the exact candidate with CI -------------------------------------------------

if successful_run_exists "$CI_WF" "$candidate"; then
  echo "reusing a successful $CI_WF run for $candidate"
else
  before="$(max_run_id "$CI_WF")" || fail "could not read $CI_WF runs"
  ci_ref="$BASE"
  [[ "$mode" == "sync" ]] && ci_ref="$branch"
  gh workflow run "$CI_WF" --ref "$ci_ref" || fail "could not dispatch $CI_WF on $ci_ref"
  wait_for_run "$CI_WF" "$ci_ref" "$before" "custom-ci"
fi

# --- Advance custom only to the exact tested commit ----------------------------------

git fetch --quiet --force origin "+refs/heads/$BASE:refs/remotes/origin/$BASE"
now="$(git rev-parse "refs/remotes/origin/$BASE")"
if [[ "$now" == "$candidate" ]]; then
  git push --quiet origin "$candidate:refs/heads/$BASE" \
    || fail "non-fast-forward push to $BASE was refused; retry next cycle"
elif [[ "$mode" == "sync" ]] && git merge-base --is-ancestor "$candidate" "$now"; then
  # A concurrent actor already landed the tested commit; nothing to advance.
  echo "origin/$BASE already contains the tested commit $candidate"
elif [[ "$mode" == "sync" ]] && git merge-base --is-ancestor "$now" "$candidate"; then
  # The normal fast-forward: custom is still at the merge base the candidate descends from.
  git push --quiet origin "$candidate:refs/heads/$BASE" \
    || fail "non-fast-forward push to $BASE was refused; retry next cycle"
else
  fail "origin/$BASE moved to $now while the gate ran; refusing to publish an untested merge (retry next cycle)"
fi

# --- Tag the tested commit and publish ------------------------------------------------
# Reuse a tag already pointing at the candidate (a previous run may have tagged but not
# released); never overwrite an existing tag and never tag a different commit.

remote_tags="$(git ls-remote --tags --refs origin "refs/tags/custom-v${version}-c*" \
  | awk '{print $2}' | sed 's#^refs/tags/##' \
  | grep -E "^custom-v${version//./\\.}-c[0-9]+$" || true)"
max_c=0
tag_at_candidate=""
while IFS= read -r existing; do
  [[ -n "$existing" ]] || continue
  n="${existing##*-c}"
  if (( n > max_c )); then max_c=$n; fi
  if [[ -z "$tag_at_candidate" ]]; then
    existing_commit="$(git ls-remote origin "refs/tags/$existing^{}" | awk '{print $1}')"
    [[ -n "$existing_commit" ]] \
      || existing_commit="$(git ls-remote origin "refs/tags/$existing" | awk '{print $1}')"
    if [[ "$existing_commit" == "$candidate" ]]; then
      # custom-release rejects a lightweight tag, so reusing one would dispatch a run
      # that can only fail. Leave it alone and publish the next cN instead.
      if [[ "$(git cat-file -t "refs/tags/$existing" 2>/dev/null || true)" == "tag" ]]; then
        tag_at_candidate="$existing"
      else
        printf 'warning: %s points at %s but is not annotated; using the next cN\n' \
          "$existing" "$candidate" >&2
      fi
    fi
  fi
done <<<"$remote_tags"

# The release view is read before any tag is created: an unreadable list cannot be
# treated as "nothing published", so a failure here publishes nothing.
published="$(released_tags)" || exit 1
is_published() { grep -qxF "$1" <<<"$published"; }

tag_label=""
if [[ -n "$tag_at_candidate" ]]; then
  if is_published "$tag_at_candidate" && [[ "$FORCE_RELEASE" == "1" ]]; then
    echo "$tag_at_candidate is already published; creating an explicitly requested new release"
  else
    tag_label="$tag_at_candidate"
    echo "reusing existing tag $tag_label at $candidate"
  fi
fi
if [[ -z "$tag_label" ]]; then
  next_c=$((max_c + 1))
  tag_label="custom-v${version}-c${next_c}"
  if git ls-remote --exit-code --tags origin "refs/tags/$tag_label" >/dev/null 2>&1; then
    fail "tag $tag_label exists on origin but not at $candidate; refusing to overwrite it"
  fi
  git tag -a "$tag_label" -m "omp-custom $version c${next_c}" "$candidate"
  git push --quiet origin "refs/tags/$tag_label:refs/tags/$tag_label" \
    || fail "could not push tag $tag_label"
  echo "tagged $candidate as $tag_label"
fi

before="$(max_run_id "$REL_WF")" || fail "could not read $REL_WF runs"
gh workflow run "$REL_WF" --ref "$tag_label" -f tag="$tag_label" \
  || fail "could not dispatch $REL_WF on $tag_label"
wait_for_run "$REL_WF" "$tag_label" "$before" "custom-release"

echo "custom-sync: $tag -> $tag_label at $candidate (release published)"
summary_line "- \`$tag\` is published as \`$tag_label\` (\`$candidate\`); \`$REL_WF\` succeeded."
