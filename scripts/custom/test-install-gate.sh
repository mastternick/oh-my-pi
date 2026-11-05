#!/usr/bin/env bash
# Unit tests for the trusted-release-run predicate shared by install.sh. Exercises the
# acceptance policy directly: only a completed, successful run of the release workflow
# for the exact commit and the exact tag ref counts; tag pushes and tag dispatches are
# both trusted, every other event/ref/path/commit/conclusion is not.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=lib.sh
. "$script_dir/lib.sh"

tag="custom-v18.16.0-c1"
commit="0123456789abcdef0123456789abcdef01234567"
wf="custom-release.yml"
pass=0
fail=0

check() { # name expected actual
  if [[ "$2" == "$3" ]]; then
    printf 'ok   %s\n' "$1"
    pass=$((pass + 1))
  else
    printf 'FAIL %s (want %s, got %s)\n' "$1" "$2" "$3"
    fail=$((fail + 1))
  fi
}

run() { # name expected-count runs-array
  local got
  got="$(omp_custom_trusted_release_runs "{\"workflow_runs\":$3}" "$tag" "$commit" "$wf")"
  check "$1" "$2" "$got"
}

entry() { # sha event branch path status conclusion
  printf '{"head_sha":"%s","event":"%s","head_branch":"%s","path":".github/workflows/%s","status":"%s","conclusion":"%s"}' \
    "$1" "$2" "$3" "$4" "$5" "$6"
}

run "tag push success" 1 "[$(entry "$commit" push "$tag" "$wf" completed success)]"
run "tag dispatch success" 1 "[$(entry "$commit" workflow_dispatch "$tag" "$wf" completed success)]"
run "pull_request run ignored" 0 "[$(entry "$commit" pull_request "$tag" "$wf" completed success)]"
run "schedule run ignored" 0 "[$(entry "$commit" schedule custom "$wf" completed success)]"
run "other workflow ignored" 0 "[$(entry "$commit" push "$tag" custom-ci.yml completed success)]"
run "other commit ignored" 0 "[$(entry "ffffffffffffffffffffffffffffffffffffffff" push "$tag" "$wf" completed success)]"
run "other tag/branch ignored" 0 "[$(entry "$commit" workflow_dispatch custom "$wf" completed success)]"
run "failed conclusion ignored" 0 "[$(entry "$commit" push "$tag" "$wf" completed failure)]"
run "cancelled conclusion ignored" 0 "[$(entry "$commit" push "$tag" "$wf" completed cancelled)]"
run "still running ignored" 0 "[$(entry "$commit" push "$tag" "$wf" in_progress "")]"
run "queued ignored" 0 "[$(entry "$commit" push "$tag" "$wf" queued "")]"
run "one trusted among noise" 1 \
  "[$(entry "$commit" push "$tag" "$wf" completed failure),$(entry "$commit" push "$tag" "$wf" completed success),$(entry "$commit" pull_request "$tag" "$wf" completed success)]"
run "two trusted runs counted" 2 \
  "[$(entry "$commit" push "$tag" "$wf" completed success),$(entry "$commit" workflow_dispatch "$tag" "$wf" completed success)]"
run "empty run list" 0 "[]"

# The predicate must not fail on a paginated/partial document without workflow_runs.
check "missing workflow_runs field" 0 \
  "$(omp_custom_trusted_release_runs '{}' "$tag" "$commit" "$wf")"

if (( fail > 0 )); then
  printf 'test-install-gate: %d failed, %d passed\n' "$fail" "$pass"
  exit 1
fi
printf 'test-install-gate: all %d checks passed\n' "$pass"
