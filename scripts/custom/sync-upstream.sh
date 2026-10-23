#!/usr/bin/env bash
# Merge a stable upstream release tag into a sync branch and open a PR against the custom branch.
# Never pushes to custom or main, never force-pushes, never merges the PR.
#   sync-upstream.sh [vX.Y.Z]     (default: newest stable upstream tag, or $UPSTREAM_TAG)
# Conflicts fail the job: resolve them locally on a branch, then open the PR yourself.
# PRs opened with GITHUB_TOKEN do not trigger pull_request workflows, so custom-ci is dispatched on the branch.
set -euo pipefail

UPSTREAM_URL="${OMP_UPSTREAM_URL:-https://github.com/can1357/oh-my-pi.git}"
BASE="${OMP_CUSTOM_BRANCH:-custom}"
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "$UPSTREAM_URL"
git fetch --quiet --no-tags upstream '+refs/tags/v*:refs/tags/upstream/v*'
git fetch --quiet origin "+refs/heads/$BASE:refs/remotes/origin/$BASE"

tag="${1:-${UPSTREAM_TAG:-}}"
if [[ -z "$tag" ]]; then
  tag="$(git tag --list 'upstream/v*' --sort=-v:refname \
    | grep -E '^upstream/v[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)"
  tag="${tag#upstream/}"
fi
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "not a stable upstream tag: '$tag'"
up_ref="refs/tags/upstream/$tag"
git rev-parse --verify --quiet "$up_ref^{commit}" >/dev/null || die "upstream tag $tag not found"

if git merge-base --is-ancestor "$up_ref^{commit}" "origin/$BASE"; then
  echo "$tag is already merged into $BASE"
  exit 0
fi

branch="sync/upstream-$tag"
if git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
  echo "branch $branch already exists on origin; resolve or close that PR first"
  exit 0
fi

export GIT_AUTHOR_NAME="omp-custom-sync"
export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"

git checkout --quiet -B "$branch" "origin/$BASE"
if ! git merge --no-ff --no-edit -m "chore(sync): merge upstream $tag" "$up_ref"; then
  git merge --abort
  die "merging $tag into $BASE conflicts; resolve locally and open the PR manually"
fi
git push --quiet origin "HEAD:refs/heads/$branch"

body="$(mktemp)"
trap 'rm -f "$body"' EXIT
cat > "$body" <<EOF
Merges upstream \`can1357/oh-my-pi\` $tag into \`$BASE\`.

- Review the upstream release notes and this merge diff.
- Required checks: the \`custom-ci\` workflow must pass before merging. It is dispatched on this branch.
- Do not merge automatically. Tag only after the gates pass (see docs/UPDATING.md).
EOF
gh pr create --base "$BASE" --head "$branch" \
  --title "Sync upstream $tag into $BASE" --body-file "$body"
gh workflow run custom-ci.yml --ref "$branch"
