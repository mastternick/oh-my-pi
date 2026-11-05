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
# A red, cancelled, timed-out, wrong-SHA, conflicting, or divergently advanced run never
# advances custom and never publishes a tag or release. custom may advance concurrently
# only to a commit that still contains the exact tested candidate: that run pushes
# nothing, keeps the concurrent tip, and publishes that tested commit. A reviewed base
# that moved anywhere else is stale or diverged and fails closed. When publishing the tag
# succeeded but its release run did not, the next release-only run reuses that unpublished
# tag at the tested candidate instead of tagging the newer, ungated tip. Every failure
# writes a GitHub step summary when GITHUB_STEP_SUMMARY is set.
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
#   OMP_SYNC_EXPECTED_BASE_SHA full commit SHA of origin/<base> that a reviewed
#                            conflicted merge was resolved against
#   OMP_SYNC_EXPECTED_TREE_SHA full tree SHA the refreshed candidate must have
#
# Review guards: a controller that had a model resolve a merge conflict supplies both
# values so this script can prove it is about to push and gate exactly the candidate
# that was reviewed. The pair is required together, must be full git SHAs, must match
# the fetched origin/<base> before a candidate is built and the final refreshed
# candidate tree before it is pushed; the base must also still be origin/<base> when
# the gate passes. They are rejected in the already-merged/release-only path instead
# of being accepted and ignored. Without them the daily clean sync is unchanged.
#
# Review certificate: ai-conflict-controller.sh writes its reviewed merge commit with these
# trailers (metadata computed outside the model): OMP-AI-Conflict-Review: v1,
# OMP-AI-Reviewed-Base: <base SHA>, OMP-AI-Reviewed-Tree: <tree SHA>, and
# OMP-AI-Model: opencode-go/deepseek-v4.1-flash. When an existing sync branch carries exactly
# one well-formed certificate in origin/$BASE..<branch> (also when buried under refresh
# merges), the pair is taken from it, or checked against explicit guards when those are given.
# Malformed, ambiguous, or tree-mismatched certificates fail before any push, CI, tag, or
# release. A branch without OMP-AI-* trailers keeps the normal manual/clean path.
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
EXPECTED_BASE="${OMP_SYNC_EXPECTED_BASE_SHA:-}"
EXPECTED_TREE="${OMP_SYNC_EXPECTED_TREE_SHA:-}"

tag=""
candidate=""
mode=""
reuse_tag=""

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

# Review guards are validated before the first fetch or merge: a malformed or
# half-supplied pair must never fall through as "no guards were requested".
review_guards=0
if [[ -n "$EXPECTED_BASE" || -n "$EXPECTED_TREE" ]]; then
  if [[ -z "$EXPECTED_BASE" || -z "$EXPECTED_TREE" ]]; then
    fail "OMP_SYNC_EXPECTED_BASE_SHA and OMP_SYNC_EXPECTED_TREE_SHA must be supplied together (base: '${EXPECTED_BASE:-}', tree: '${EXPECTED_TREE:-}')"
  fi
  [[ "$EXPECTED_BASE" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] \
    || fail "OMP_SYNC_EXPECTED_BASE_SHA is not a full git commit SHA: '$EXPECTED_BASE'"
  [[ "$EXPECTED_TREE" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] \
    || fail "OMP_SYNC_EXPECTED_TREE_SHA is not a full git tree SHA: '$EXPECTED_TREE'"
  review_guards=1
fi

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
  # Exit 2 marks an unreadable run list so callers can tell "no green run" from "cannot
  # know": the gate may dispatch and let the poll fail closed, but the release retry must
  # never read an API error as "this tag was never tested" and tag another commit.
  local data
  data="$(fetch_runs "$1")" || return 2
  jq -e --arg wf "$1" --arg sha "$2" '
    any(.workflow_runs[]?;
      .path == (".github/workflows/" + $wf)
      and .head_sha == $sha
      and .status == "completed" and .conclusion == "success"
      and (.event == "workflow_dispatch" or .event == "push"))' >/dev/null <<<"$data"
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

# An unpublished tag can already name the reviewed and tested release commit: a previous
# run may have pushed the tag and then died dispatching or waiting for custom-release (for
# example a guarded sync whose concurrent advance contained the tested candidate). The tag
# is the release artifact, so a release-only rerun must publish that exact tag instead of
# tagging the newer origin/$BASE tip, which was never gated as the release commit.
# Selection is deterministic: the highest unpublished cN whose annotated tag commit is
# contained in origin/$BASE, contains the upstream tag commit, carries this version, and
# has a successful $CI_WF run for that exact commit. Anything less is never selected.
find_reusable_release_tag() { # version upstream-commit base-tip
  local version="$1" commit="$2" base_tip="$3"
  local existing n tag_commit tag_version_at ci_rc tag_list best="" best_c=0 published
  published="$(released_tags)" || exit 1
  # An unreadable tag listing is not "no reusable tag": tagging the tip on that guess is
  # exactly what this path exists to prevent.
  tag_list="$(git ls-remote --tags --refs origin "refs/tags/custom-v${version}-c*" \
    | awk '{print $2}' | sed 's#^refs/tags/##')" \
    || fail "could not list custom-v${version} tags in $REPO; refusing to tag a different commit on an unreadable tag list"
  while IFS= read -r existing; do
    [[ -n "$existing" ]] || continue
    [[ "$existing" =~ ^custom-v${version//./\\.}-c([0-9]+)$ ]] || continue
    n="${BASH_REMATCH[1]}"
    if grep -qxF "$existing" <<<"$published"; then continue; fi
    # custom-release rejects a lightweight tag, so it can never be the release artifact.
    git fetch --quiet --force origin "+refs/tags/$existing:refs/tags/$existing" 2>/dev/null \
      || fail "could not fetch tag $existing to verify it for reuse; refusing to tag a different commit"
    [[ "$(git cat-file -t "refs/tags/$existing" 2>/dev/null || true)" == "tag" ]] || continue
    tag_commit="$(git rev-parse --verify --quiet "refs/tags/$existing^{commit}" || true)"
    [[ -n "$tag_commit" ]] || continue
    git merge-base --is-ancestor "$tag_commit" "$base_tip" 2>/dev/null || continue
    git merge-base --is-ancestor "$commit" "$tag_commit" 2>/dev/null || continue
    tag_version_at="$(git show "$tag_commit:packages/coding-agent/package.json" 2>/dev/null \
      | jq -r '.version // empty' || true)"
    [[ "$tag_version_at" == "$version" ]] || continue
    ci_rc=0
    successful_run_exists "$CI_WF" "$tag_commit" || ci_rc=$?
    case "$ci_rc" in
      0) ;;
      2) fail "could not read $CI_WF runs for $tag_commit while checking $existing for reuse; refusing to guess whether it was gated" ;;
      *) continue ;;
    esac
    if (( n > best_c )); then
      best_c=$n
      best="$existing"
    fi
  done <<<"$tag_list"
  printf '%s\n' "$best"
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
  number="$(gh pr list --repo "$REPO" --head "$branch" --state open --json number --jq '.[0].number // empty' 2>/dev/null || true)"
  if [[ -z "$number" ]]; then
    gh pr create --repo "$REPO" --base "$BASE" --head "$branch" \
      --title "Sync upstream $tag into $BASE" --body-file "$body" >/dev/null \
      || printf 'warning: could not open the sync PR; the workflow run is the gate\n' >&2
  fi
  rm -f "$body"
}

# AI review certificate on an existing sync branch. ai-conflict-controller.sh records its
# reviewed merge as OMP-AI-* trailers, and a later refresh merge can bury that commit under
# others, so every commit in origin/$BASE..<ref> is checked. The trailers are controller
# metadata, never model output. Any OMP-AI-* line outside the trailer block, malformed,
# duplicated, unsupported, or repeated on a second commit fails closed. Sets CERT_COMMIT,
# CERT_BASE and CERT_TREE (all empty when the branch has no certificate). These are globals,
# not stdout: a call inside $(...) would turn fail() into an empty result.
CERT_MODEL="opencode-go/deepseek-v4.1-flash"
CERT_COMMIT=""
CERT_BASE=""
CERT_TREE=""
review_certificate() { # ref
  local ref="$1" revs c body raw_n trailer_n lines line key value rb="" rt="" actual
  local found=0
  declare -A seen=()
  CERT_COMMIT=""
  CERT_BASE=""
  CERT_TREE=""
  revs="$(git rev-list "refs/remotes/origin/$BASE..$ref")" \
    || fail "could not list the commits of $ref for an AI review certificate"
  while IFS= read -r c; do
    [[ -n "$c" ]] || continue
    body="$(git log -1 --format=%B "$c")" || fail "could not read the message of $c"
    raw_n="$(grep -ic '^OMP-AI-' <<<"$body" || true)"
    (( raw_n > 0 )) || continue
    lines="$(git interpret-trailers --parse <<<"$body" | grep -i '^OMP-AI-' || true)"
    trailer_n="$(grep -c . <<<"$lines" || true)"
    (( trailer_n == raw_n )) \
      || fail "$c has OMP-AI-* lines outside its trailer block; refusing to guess the certificate"
    found=$((found + 1))
    CERT_COMMIT="$c"
    rb=""
    rt=""
    seen=()
    while IFS= read -r line; do
      [[ "$line" =~ ^(OMP-AI-[A-Za-z-]+):\ (.+)$ ]] \
        || fail "malformed AI review trailer on $c: '$line'"
      key="${BASH_REMATCH[1]}"
      value="${BASH_REMATCH[2]}"
      [[ -z "${seen[$key]:-}" ]] || fail "AI review trailer $key appears twice on $c"
      seen[$key]=1
      case "$key" in
        OMP-AI-Conflict-Review)
          [[ "$value" == v1 ]] || fail "unsupported AI review certificate version '$value' on $c" ;;
        OMP-AI-Reviewed-Base)
          [[ "$value" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || fail "AI review base on $c is not a full commit SHA"
          rb="$value" ;;
        OMP-AI-Reviewed-Tree)
          [[ "$value" =~ ^([0-9a-f]{40}|[0-9a-f]{64})$ ]] || fail "AI review tree on $c is not a full tree SHA"
          rt="$value" ;;
        OMP-AI-Model)
          [[ "$value" == "$CERT_MODEL" ]] || fail "AI review on $c was produced by '$value', not $CERT_MODEL" ;;
        *) fail "unsupported AI review trailer $key on $c" ;;
      esac
    done <<<"$lines"
    for key in OMP-AI-Conflict-Review OMP-AI-Reviewed-Base OMP-AI-Reviewed-Tree OMP-AI-Model; do
      [[ -n "${seen[$key]:-}" ]] || fail "AI review certificate on $c is missing $key"
    done
    actual="$(git rev-parse "$c^{tree}")" || fail "could not read the tree of $c"
    [[ "$actual" == "$rt" ]] \
      || fail "AI review certificate on $c names tree $rt but the commit tree is $actual"
    CERT_BASE="$rb"
    CERT_TREE="$rt"
  done <<<"$revs"
  (( found <= 1 )) \
    || fail "$found commits on $ref carry AI review certificates; the certificate is ambiguous"
}

# --- Decide: sync a new upstream tag, gate current custom, or no-op ----------------

if git merge-base --is-ancestor "$up_commit" "refs/remotes/origin/$BASE"; then
  if (( review_guards )); then
    # The guards describe a conflicted merge this run would not build. Accepting them
    # here would let a caller believe the reviewed candidate was gated when only the
    # current custom HEAD is.
    fail "OMP_SYNC_EXPECTED_BASE_SHA/OMP_SYNC_EXPECTED_TREE_SHA describe a reviewed conflicted merge, but upstream $tag is already merged into origin/$BASE; refusing to accept guards this run would ignore (re-run the release-only sync without them)"
  fi
  if [[ "$FORCE_RELEASE" != "1" ]] && release_contains_upstream "$tag_version" "$up_commit"; then
    echo "$tag is already merged into $BASE and released; nothing to do"
    summary_line "- no-op: upstream \`$tag\` is already merged and released."
    exit 0
  fi
  mode="release"
  candidate="$(git rev-parse "refs/remotes/origin/$BASE")"
  # A tag left unpublished by an earlier failed release names a commit that was gated at
  # exactly that SHA and is already contained in $BASE; that is the release artifact a
  # retry must publish, not a fresh cN at the newer tip. OMP_SYNC_FORCE_RELEASE asks for a
  # new release of the current tip, so it is never redirected to an older tag.
  if [[ "$FORCE_RELEASE" != "1" ]]; then
    # The helper exits through fail() (which writes the summary) on an unreadable release,
    # tag, or CI view; the explicit || keeps that failure from being read as "no tag".
    reuse_tag="$(find_reusable_release_tag "$tag_version" "$up_commit" "$candidate")" || exit 1
  fi
  if [[ -n "$reuse_tag" ]]; then
    candidate="$(git rev-parse --verify "refs/tags/$reuse_tag^{commit}")"
    echo "$tag is already merged into $BASE; reusing unpublished tag $reuse_tag at $candidate instead of tagging the newer tip"
  else
    echo "$tag is already merged into $BASE; gating $candidate for a release"
  fi
else
  mode="sync"
  # The sync branch is inspected before anything is built or pushed. An AI-reviewed branch
  # (see ai-conflict-controller.sh) carries its own certificate: explicit guards must agree
  # with it, and without explicit guards it supplies the pair, so the scheduled run honours
  # the review without a model call. A failed query is never read as "no branch".
  branch="sync/upstream-$tag"
  remote_ref="refs/remotes/origin/$branch"
  have_remote=0
  ls_rc=0
  git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1 || ls_rc=$?
  case "$ls_rc" in
    0)
      git fetch --quiet --force origin "+refs/heads/$branch:$remote_ref"
      have_remote=1 ;;
    2) ;;
    *) fail "could not query origin for $branch; refusing to build a candidate without knowing whether it carries a review certificate" ;;
  esac
  if (( have_remote )); then
    review_certificate "$remote_ref"
    if [[ -n "$CERT_COMMIT" ]]; then
      if (( review_guards )); then
        [[ "$EXPECTED_BASE" == "$CERT_BASE" && "$EXPECTED_TREE" == "$CERT_TREE" ]] \
          || fail "the explicit review guards ($EXPECTED_BASE, $EXPECTED_TREE) do not match the AI review certificate on $branch at $CERT_COMMIT (base $CERT_BASE, tree $CERT_TREE); refusing to accept guards the certificate does not support"
      fi
      EXPECTED_BASE="$CERT_BASE"
      EXPECTED_TREE="$CERT_TREE"
      review_guards=1
      echo "AI review certificate on $branch at $CERT_COMMIT binds base $CERT_BASE and tree $CERT_TREE"
    fi
  fi
  # The reviewed base must still be origin/$BASE before any candidate is built: a base
  # that moved after the resolution makes the reviewed tree describe the wrong merge.
  origin_base="$(git rev-parse "refs/remotes/origin/$BASE")"
  if (( review_guards )) && [[ "$origin_base" != "$EXPECTED_BASE" ]]; then
    fail "reviewed base $EXPECTED_BASE does not match origin/$BASE at $origin_base; refusing to build a candidate from an unreviewed base"
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
  if (( review_guards )); then
    # The refresh merge can pull in work pushed to the sync branch after the review; the
    # tree is the reviewed artifact, so it must still match before the push and gate.
    candidate_tree="$(git rev-parse "$candidate^{tree}")"
    if [[ "$candidate_tree" != "$EXPECTED_TREE" ]]; then
      fail "refreshed candidate $candidate has tree $candidate_tree, not the reviewed tree $EXPECTED_TREE; refusing to push or gate it"
    fi
  fi
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
  gh workflow run "$CI_WF" --repo "$REPO" --ref "$ci_ref" \
    || fail "could not dispatch $CI_WF on $ci_ref in $REPO"
  wait_for_run "$CI_WF" "$ci_ref" "$before" "custom-ci"
fi

# --- Advance custom only to the exact tested commit ----------------------------------

git fetch --quiet --force origin "+refs/heads/$BASE:refs/remotes/origin/$BASE"
now="$(git rev-parse "refs/remotes/origin/$BASE")"
if [[ "$now" == "$candidate" ]]; then
  git push --quiet origin "$candidate:refs/heads/$BASE" \
    || fail "non-fast-forward push to $BASE was refused; retry next cycle"
elif [[ "$mode" == "sync" ]] && git merge-base --is-ancestor "$candidate" "$now"; then
  # A concurrent actor already landed the tested commit, possibly with more work on top
  # of it. The exact reviewed and gated commit is contained in origin/$BASE, so there is
  # nothing to push and nothing to rewrite; publishing continues for that same tested
  # commit. A reviewed base that advanced to such a strict descendant is therefore not
  # stale, while a divergent tip still falls through to the guards below.
  echo "origin/$BASE already contains the tested commit $candidate"
elif [[ -n "$reuse_tag" ]] && git merge-base --is-ancestor "$candidate" "$now"; then
  # The reused tag names the tested release commit and $BASE already contains it: the
  # concurrent tip stays untouched and nothing is published for it.
  echo "origin/$BASE already contains the tagged commit $candidate"
elif (( review_guards )) && [[ "$now" != "$EXPECTED_BASE" ]]; then
  # The reviewed candidate descends from the reviewed base; a base that moved under the
  # gate would fast-forward a merge nobody reviewed against the new tip.
  fail "origin/$BASE moved to $now while the gate ran; the reviewed base $EXPECTED_BASE is stale or $BASE diverged from it (retry next cycle)"
elif [[ "$mode" == "sync" ]] && git merge-base --is-ancestor "$now" "$candidate"; then
  # The normal fast-forward: custom is still at the merge base the candidate descends from.
  git push --quiet origin "$candidate:refs/heads/$BASE" \
    || fail "non-fast-forward push to $BASE was refused; retry next cycle"
else
  fail "origin/$BASE moved to $now while the gate ran; the base is stale or diverged from the tested commit, so refusing to publish an untested merge (retry next cycle)"
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
if [[ -n "$reuse_tag" ]]; then
  tag_label="$reuse_tag"
  echo "reusing existing unpublished tag $tag_label at $candidate"
elif [[ -n "$tag_at_candidate" ]]; then
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
gh workflow run "$REL_WF" --repo "$REPO" --ref "$tag_label" -f tag="$tag_label" \
  || fail "could not dispatch $REL_WF on $tag_label in $REPO"
wait_for_run "$REL_WF" "$tag_label" "$before" "custom-release"

echo "custom-sync: $tag -> $tag_label at $candidate (release published)"
summary_line "- \`$tag\` is published as \`$tag_label\` (\`$candidate\`); \`$REL_WF\` succeeded."
