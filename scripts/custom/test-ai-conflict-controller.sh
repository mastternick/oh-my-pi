#!/usr/bin/env bash
# Behavioral tests for ai-conflict-controller.sh.
#
# Only the external interfaces are faked (bun/model adapter and gh); the repository
# side is real: real bare remotes, real merges, real pushes. Every assertion reads
# observable Git/remote state, never the controller's source text.
#
#   test-ai-conflict-controller.sh      (no network, no model, no CI)
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTRL="$here/ai-conflict-controller.sh"
[[ -f "$CTRL" ]] || { printf 'controller not found: %s\n' "$CTRL" >&2; exit 1; }

for cmd in git jq flock df timeout stat mktemp python3; do
  command -v "$cmd" >/dev/null || { printf 'missing test dependency: %s\n' "$cmd" >&2; exit 1; }
done

workroot="$(mktemp -d "${TMPDIR:-/dev/shm}/omp-ctrl-test.XXXXXX")"
trap 'rm -rf -- "$workroot"' EXIT

export GIT_CONFIG_NOSYSTEM=1
export GIT_TERMINAL_PROMPT=0
export GIT_AUTHOR_NAME=test
export GIT_AUTHOR_EMAIL=test@example.invalid
export GIT_COMMITTER_NAME=test
export GIT_COMMITTER_EMAIL=test@example.invalid

pass=0
failures=0
ok() { pass=$((pass + 1)); printf 'ok   %s\n' "$1"; }
bad() { failures=$((failures + 1)); printf 'FAIL %s\n' "$1" >&2; }
is() { # label want got
  if [[ "$2" == "$3" ]]; then ok "$1"; else bad "$1 (want '$2', got '$3')"; fi
}
is_not() { # label unexpected got
  if [[ "$2" != "$3" ]]; then ok "$1"; else bad "$1 (unexpected '$3')"; fi
}

# --- fake external interfaces -----------------------------------------------------

write_fakes() { # case-dir
  local d="$1"
  mkdir -p "$d/bin" "$d/fake" "$d/home" "$d/tmp" "$d/ram" "$d/root" "$d/state"
  : >"$d/bin/adapter.ts"
  chmod 755 "$d/bin" "$d/ram" "$d/root" "$d/state"

  cat >"$d/bin/bun" <<'FAKE_BUN'
#!/usr/bin/env bash
# Fake model adapter: consumes one adapter request on stdin and prints one response.
set -euo pipefail
fake="${FAKE_DIR:?}"
input="$(cat)"
mode="$(jq -r '.mode // ""' <<<"$input")"
job="$(jq -r '.jobKey // ""' <<<"$input")"
printf '%s\t%s\n' "$mode" "${GH_TOKEN:-unset}" >>"$fake/calls.tsv"
printf '%s\n' "$input" >>"$fake/requests.jsonl"

if [[ "$mode" == "review" && "${FAKE_ADVANCE:-0}" == "1" ]]; then
  adv="$(mktemp -d "$fake/advance.XXXXXX")"
  git clone -q "$FAKE_ORIGIN" "$adv/repo"
  git -C "$adv/repo" checkout -q custom
  printf 'advanced\n' >>"$adv/repo/shared.txt"
  git -C "$adv/repo" commit -qam 'concurrent advance'
  git -C "$adv/repo" push -q origin custom
fi

emit_resolve() { # variant
  local variant="$1" files calls=0 model_id="deepseek-v4.1-flash" name
  files="$(jq -c '[.conflicts[] | {path: .path, content: "resolved\n"}]' <<<"$input")"
  case "$variant" in
    extrapath) files="$(jq -c '. + [{path: "evil.txt", content: "x\n"}]' <<<"$files")" ;;
    traversal) files="$(jq -c '. + [{path: "../escape.txt", content: "x\n"}]' <<<"$files")" ;;
    missing) files="$(jq -c '.[1:]' <<<"$files")" ;;
    deletefirst) files="$(jq -c '.[0] = {path: .[0].path, delete: true}' <<<"$files")" ;;
    deletefalse) files="$(jq -c '.[0] = {path: .[0].path, delete: false}' <<<"$files")" ;;
    dual) files="$(jq -c '.[0] = {path: .[0].path, content: "x\n", delete: true}' <<<"$files")" ;;
    badproof) calls=1 ;;
    wrongmodel) model_id="other-model" ;;
    markers) files="$(jq -c '[.conflicts[] | {path: .path, content: "<<<<<<< HEAD\nresolved\n"}]' <<<"$input")" ;;
  esac
  name="OMP — Upstream Conflict Resolver — $job"
  jq -cn --arg job "$job" --arg mid "$model_id" --arg name "$name" \
    --argjson files "$files" --argjson calls "$calls" '
    {ok: true, mode: "resolve", jobKey: $job,
     model: {provider: "opencode-go", id: $mid},
     session: {id: ("resolver-" + $job), name: $name},
     proof: {provider: "opencode-go", model: "deepseek-v4.1-flash",
             sessionId: ("resolver-" + $job), sessionName: $name,
             assistantMessages: 1, toolCalls: $calls, toolsExposed: 0,
             retryRecoveries: []},
     files: $files}'
}

emit_review() { # verdict
  local verdict="$1" first name
  first="$(jq -r '.conflicts[0].path // ""' <<<"$input")"
  name="OMP — Upstream Conflict Review — $job"
  jq -cn --arg job "$job" --arg name "$name" --arg first "$first" --arg verdict "$verdict" '
    {ok: true, mode: "review", jobKey: $job,
     model: {provider: "opencode-go", id: "deepseek-v4.1-flash"},
     session: {id: ("review-" + $job), name: $name},
     proof: {provider: "opencode-go", model: "deepseek-v4.1-flash",
             sessionId: ("review-" + $job), sessionName: $name,
             assistantMessages: 1, toolCalls: 0, toolsExposed: 0,
             retryRecoveries: []},
     verdict: $verdict,
     findings: (if $verdict == "rejected"
                then [{path: $first, severity: "error", message: "still broken"}]
                else [] end)}'
}

scenario="${FAKE_ADAPTER_MODE:-accept}"
case "$scenario" in
  provider_fail)
    jq -cn --arg mode "$mode" --arg job "$job" \
      '{ok: false, mode: $mode, jobKey: $job,
        error: {code: "PROVIDER_ERROR", message: "upstream returned 503"}}'
    exit 1
    ;;
  malformed)
    printf '{"ok": true, "mode": "resolve"\n'
    exit 0
    ;;
esac

if [[ "$mode" == "resolve" ]]; then
  emit_resolve "$scenario"
elif [[ "$mode" == "review" ]]; then
  if [[ "${FAKE_VERDICT:-accepted}" == "rejected" ]]; then
    emit_review rejected
  else
    emit_review accepted
  fi
else
  jq -cn --arg mode "$mode" '{ok: false, error: {code: "BAD_INPUT", message: ("bad mode " + $mode)}}'
  exit 2
fi
FAKE_BUN

  cat >"$d/bin/gh" <<'FAKE_GH'
#!/usr/bin/env bash
# Fake gh: workflow listing, dispatch, run status. Never touches the network.
set -euo pipefail
fake="${FAKE_DIR:?}"
printf '%s\n' "$*" >>"$fake/gh.log"
cmd="${1:-}"
shift || true
case "$cmd" in
  auth)
    if [[ "${1:-}" == "token" ]]; then printf 'fake-gh-token-value\n'; exit 0; fi
    if [[ "${1:-}" == "git-credential" ]]; then cat >/dev/null; printf 'username=x-access-token\npassword=fake-gh-token-value\n'; exit 0; fi
    exit 1
    ;;
  api)
    url="${1:-}"
    case "$url" in
      *"/actions/workflows/"*"/runs?per_page=100")
        if [[ -f "$fake/run.json" ]]; then
          jq -c '{workflow_runs: [.]}' "$fake/run.json"
        else
          printf '{"workflow_runs": []}\n'
        fi
        ;;
      *"/actions/runs/"*)
        [[ -f "$fake/run.json" ]] || exit 1
        jq -c --argjson id "${url##*/}" 'select(.id == $id)' "$fake/run.json"
        ;;
      *) exit 1 ;;
    esac
    ;;
  workflow)
    [[ "${FAKE_GH_MODE:-ok}" == "fail_dispatch" ]] && exit 1
    wf="${2:-}"
    shift 2 || true
    ref=""; tag=""; bsha=""; tsha=""
    while (($# > 0)); do
      case "$1" in
        --ref) ref="$2"; shift 2 ;;
        -f)
          case "$2" in
            upstream_tag=*) tag="${2#upstream_tag=}" ;;
            expected_base_sha=*) bsha="${2#expected_base_sha=}" ;;
            expected_tree_sha=*) tsha="${2#expected_tree_sha=}" ;;
          esac
          shift 2
          ;;
        *) shift ;;
      esac
    done
    prev=0
    [[ -f "$fake/run.json" ]] && prev="$(jq -r '.id' "$fake/run.json")"
    jq -cn --arg wf "$wf" --arg ref "$ref" --arg sha "$bsha" --argjson id "$((prev + 1))" '
      {id: $id, path: (".github/workflows/" + $wf), head_branch: $ref, head_sha: $sha,
       status: "completed", conclusion: "success", event: "workflow_dispatch"}' >"$fake/run.json"
    printf '%s|%s|%s|%s\n' "$tag" "$bsha" "$tsha" "$ref" >>"$fake/dispatch.log"
    ;;
  release|tag)
    printf 'forbidden gh command: %s\n' "$cmd" >>"$fake/forbidden.log"
    exit 1
    ;;
  *) exit 1 ;;
esac
FAKE_GH

  chmod 755 "$d/bin/bun" "$d/bin/gh"
}

# --- real repositories ------------------------------------------------------------

build_repos() { # case-dir kind
  local d="$1" kind="$2" ver="1.2.3" seed="$1/seed"
  git init -q --initial-branch=main "$seed"
  (
    cd "$seed"
    mkdir -p packages/coding-agent scripts nested
    printf '{"name":"coding-agent","version":"1.0.0"}\n' >packages/coding-agent/package.json
    printf 'deep base\n' >nested/deep.txt
    printf 'custom base\n' >custom-feature.txt
    printf 'shared base\n' >shared.txt
    printf 'victim base\n' >victim.txt
    printf 'latin base\n' >latin.txt
    printf 'mode base\n' >modefile.sh
    printf '#!/usr/bin/env bash\necho tool\n' >scripts/tool.sh
    chmod 755 scripts/tool.sh
    printf 'a\n' >link-target.txt
    ln -s link-target.txt link
    printf 'binary\0base\n' >blob.bin
    git add -A
    git commit -q -m base
  )

  git init -q --bare "$d/origin.git"
  git -C "$d/origin.git" symbolic-ref HEAD refs/heads/custom
  git -C "$seed" push -q "$d/origin.git" main:refs/heads/custom

  git init -q --bare "$d/upstream.git"
  git -C "$d/upstream.git" symbolic-ref HEAD refs/heads/main
  (
    cd "$seed"
    git checkout -q -b upstream main
    printf '{"name":"coding-agent","version":"%s"}\n' "$ver" >packages/coding-agent/package.json
    case "$kind" in
      clean) printf 'upstream shared\n' >shared.txt ;;
      text)
        printf 'upstream change\n' >custom-feature.txt
        printf '#!/usr/bin/env bash\necho upstream\n' >scripts/tool.sh
        ;;
      binary) printf 'binary\0upstream\n' >blob.bin ;;
      symlink) ln -sfn upstream-target.txt link ;;
      delete) printf 'upstream edits victim\n' >victim.txt ;;
      delours) git rm -q victim.txt ;;
      addadd) printf 'upstream added\n' >added.txt ;;
      mode) printf 'mode upstream\n' >modefile.sh ;;
      dirdelete) printf 'deep upstream\n' >nested/deep.txt ;;
      latin1) printf 'caf\351 upstream\n' >latin.txt ;;
    esac
    git add -A
    git commit -q -m "upstream $ver"
    git tag "v$ver"
    git push -q "$d/upstream.git" "refs/tags/v$ver"
    git push -q "$d/upstream.git" upstream:refs/heads/main

    git checkout -q -b custom main
    printf 'custom change\n' >custom-feature.txt
    case "$kind" in
      binary) printf 'binary\0ours\n' >blob.bin ;;
      symlink) ln -sfn ours-target.txt link ;;
      delete) git rm -q victim.txt ;;
      delours) printf 'ours edits victim\n' >victim.txt ;;
      addadd) printf 'ours added\n' >added.txt ;;
      mode) printf 'mode ours\n' >modefile.sh; chmod 755 modefile.sh ;;
      dirdelete) git rm -r -q nested ;;
      latin1) printf 'na\357ve ours\n' >latin.txt ;;
      text) printf '#!/usr/bin/env bash\necho ours\n' >scripts/tool.sh ;;
    esac
    git add -A
    git commit -q -m 'custom work'
    git push -q "$d/origin.git" custom:refs/heads/custom
  )

}

new_case() { # name kind
  local d="$workroot/$1" kind="$2"
  mkdir -p "$d"
  build_repos "$d" "$kind" >/dev/null
  write_fakes "$d"
  printf '%s\n' "$d"
}

run_ctrl() { # case-dir [extra env assignments...]
  local d="$1"
  shift
  set +e
  env -i \
    PATH="$d/bin:/usr/local/bin:/usr/bin:/bin" \
    HOME="$d/home" TMPDIR="$d/tmp" \
    GIT_CONFIG_NOSYSTEM=1 GIT_TERMINAL_PROMPT=0 \
    OMP_CUSTOM_HOME="$d/root" \
    OMP_CUSTOM_REPO="testowner/oh-my-pi" \
    OMP_ORIGIN_URL="$d/origin.git" \
    OMP_UPSTREAM_URL="$d/upstream.git" \
    OMP_AI_CONFLICTS_TMPDIR="$d/ram" \
    OMP_AI_CONFLICTS_MIN_FREE=0 \
    OMP_AI_CONFLICTS_STATE_DIR="$d/state" \
    OMP_AI_CONFLICTS_BUN="$d/bin/bun" \
    OMP_AI_CONFLICTS_ADAPTER="$d/bin/adapter.ts" \
    OMP_AI_CONFLICTS_POLL=1 \
    OMP_AI_CONFLICTS_TIMEOUT=10 \
    OMP_AI_CONFLICTS_HARD_TIMEOUT=60 \
    FAKE_DIR="$d/fake" \
    FAKE_ORIGIN="$d/origin.git" \
    "$@" \
    bash "$CTRL" >"$d/stdout.log" 2>"$d/stderr.log"
  local rc=$?
  set -e
  printf '%s\n' "$rc"
}

calls() { # case-dir
  [[ -f "$1/fake/calls.tsv" ]] || { printf ''; return 0; }
  awk -F'\t' '{printf "%s%s", sep, $1; sep=","}' "$1/fake/calls.tsv"
}
branch_refs() { # case-dir
  git -C "$1/origin.git" for-each-ref --format='%(refname:short)' refs/heads/ \
    | grep -vx custom || true
}

assert_no_push() { # case-dir label
  local d="$1" label="$2" refs tags
  refs="$(branch_refs "$d")"
  tags="$(git -C "$d/origin.git" tag -l)"
  is "$label: no branch published" "" "$refs"
  is "$label: no tag published" "" "$tags"
  is "$label: no workflow dispatch" "" "$(cat "$d/fake/dispatch.log" 2>/dev/null || true)"
}

# --- 1. clean merge: no AI, no push, existing GitHub flow keeps ownership ----------

d="$(new_case clean clean)"
clean_base="$(git -C "$d/origin.git" rev-parse refs/heads/custom)"
rc="$(run_ctrl "$d")"
is "clean merge exits 0" 0 "$rc"
is "clean merge never calls the model" "" "$(calls "$d")"
assert_no_push "$d" "clean merge"
is "clean merge leaves custom untouched" "$clean_base" "$(git -C "$d/origin.git" rev-parse refs/heads/custom)"
is "clean merge writes a noop status" noop "$(awk -F'\t' '$1=="status"{print $2}' "$d/state/last-result" 2>/dev/null)"

# --- 2. accepted text conflict: exact reviewed branch, exact dispatch guards ------

d="$(new_case text text)"
base_sha="$(git -C "$d/origin.git" rev-parse refs/heads/custom)"
up_sha="$(git -C "$d/upstream.git" rev-parse 'refs/tags/v1.2.3^{commit}')"
rc="$(run_ctrl "$d" OMP_AI_CONFLICTS_GH_USER=botowner)"
is "text conflict exits 0" 0 "$rc"
is "resolve then fresh review" "resolve,review" "$(calls "$d")"
br="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "text conflict publishes sync/upstream-v1.2.3" "" "$br"
is "candidate parent 1 is the reviewed base" "$base_sha" "$(git -C "$d/origin.git" rev-parse "$br^1")"
is "candidate parent 2 is the upstream tag" "$up_sha" "$(git -C "$d/origin.git" rev-parse "$br^2")"
tree="$(git -C "$d/origin.git" rev-parse "$br^{tree}")"
trailers="$(git -C "$d/origin.git" log -1 --format=%B "$br" | git interpret-trailers --parse)"
is "certificate names the review version" "v1" \
  "$(awk -F': ' '$1=="OMP-AI-Conflict-Review"{print $2}' <<<"$trailers")"
is "certificate binds the reviewed base" "$base_sha" \
  "$(awk -F': ' '$1=="OMP-AI-Reviewed-Base"{print $2}' <<<"$trailers")"
is "certificate binds the reviewed tree" "$tree" \
  "$(awk -F': ' '$1=="OMP-AI-Reviewed-Tree"{print $2}' <<<"$trailers")"
is "certificate names the pinned model" "opencode-go/deepseek-v4.1-flash" \
  "$(awk -F': ' '$1=="OMP-AI-Model"{print $2}' <<<"$trailers")"
is "certificate has exactly four OMP-AI trailers" 4 "$(grep -c '^OMP-AI-' <<<"$trailers" || true)"
is "certificate subject is the merge subject" "chore(sync): merge upstream v1.2.3" \
  "$(git -C "$d/origin.git" log -1 --format=%s "$br")"
is "dispatch binds upstream tag" "v1.2.3" "$(cut -d'|' -f1 "$d/fake/dispatch.log")"
is "dispatch binds exact base" "$base_sha" "$(cut -d'|' -f2 "$d/fake/dispatch.log")"
is "dispatch binds exact tree" "$tree" "$(cut -d'|' -f3 "$d/fake/dispatch.log")"
is "dispatch targets the base branch" "custom" "$(cut -d'|' -f4 "$d/fake/dispatch.log")"
is "resolved content is applied" "resolved" "$(git -C "$d/origin.git" show "$br:custom-feature.txt" | tr -d '\n')"
is "executable mode is preserved" "100755" "$(git -C "$d/origin.git" ls-tree "$br" scripts/tool.sh | awk '{print $1}')"
is "custom branch is untouched" "$base_sha" "$(git -C "$d/origin.git" rev-parse refs/heads/custom)"
is "no tag is created" "" "$(git -C "$d/origin.git" tag -l)"
is "no release/tag gh command" "" "$(cat "$d/fake/forbidden.log" 2>/dev/null || true)"
is "model subprocess never sees the gh token" "unset" "$(cut -f2 "$d/fake/calls.tsv" | sort -u | tr -d '\n')"
is "state dir is private" 700 "$(stat -c %a "$d/state")"
is "run log is private" 600 "$(stat -c %a "$d/state/run.log")"
if grep -q 'fake-gh-token-value' "$d/state/run.log" "$d/stderr.log"; then
  bad "gh token leaked into logs"
else
  ok "gh token never logged"
fi
is "adapter store is the private session dir" "$d/state/sessions" \
  "$(jq -r '.sessionDir' "$d/fake/requests.jsonl" | sort -u | tr -d '\n')"

# --- 2b. both added: the absent base is null, not empty text ---------------------

d="$(new_case addadd addadd)"
rc="$(run_ctrl "$d")"
is "add/add exits 0" 0 "$rc"
is "add/add resolves then reviews" "resolve,review" "$(calls "$d")"
is "add/add sends the absent base as null" "null" \
  "$(jq -r 'select(.mode=="resolve") | .conflicts[] | select(.path=="added.txt") | .base' "$d/fake/requests.jsonl")"
is "add/add sends our side" "ours added" \
  "$(jq -r 'select(.mode=="resolve") | .conflicts[] | select(.path=="added.txt") | .ours' "$d/fake/requests.jsonl" | tr -d '\n')"
is "add/add sends their side" "upstream added" \
  "$(jq -r 'select(.mode=="resolve") | .conflicts[] | select(.path=="added.txt") | .theirs' "$d/fake/requests.jsonl" | tr -d '\n')"
addbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "add/add publishes the sync branch" "" "$addbr"
is "add/add applies the resolved content" "resolved" \
  "$(git -C "$d/origin.git" show "$addbr:added.txt" | tr -d '\n')"
is "add/add keeps the candidate mode" "100644" \
  "$(git -C "$d/origin.git" ls-tree "$addbr" added.txt | awk '{print $1}')"

# --- 2c. modify/delete, deleted by us: proposed content is written ----------------

d="$(new_case moddel delete)"
rc="$(run_ctrl "$d")"
is "modify/delete (deleted by us) exits 0" 0 "$rc"
is "modify/delete sends the absent ours as null" "null" \
  "$(jq -r 'select(.mode=="resolve") | .conflicts[] | select(.path=="victim.txt") | .ours' "$d/fake/requests.jsonl")"
mbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is "modify/delete keeps the proposed content" "resolved" \
  "$(git -C "$d/origin.git" show "$mbr:victim.txt" | tr -d '\n')"
is "modify/delete keeps the existing mode" "100644" \
  "$(git -C "$d/origin.git" ls-tree "$mbr" victim.txt | awk '{print $1}')"

# --- 2d. modify/delete, deleted by us: an accepted deletion removes the path ------

d="$(new_case moddel-del delete)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=deletefirst)"
is "accepted deletion exits 0" 0 "$rc"
is "accepted deletion is reviewed as a deletion" "victim.txt" \
  "$(jq -r 'select(.mode=="review") | .files[] | select(.delete == true) | .path' "$d/fake/requests.jsonl")"
dbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "accepted deletion publishes the sync branch" "" "$dbr"
is "accepted deletion is absent from the candidate tree" absent \
  "$(git -C "$d/origin.git" cat-file -e "$dbr:victim.txt" 2>/dev/null && echo present || echo absent)"
is "accepted deletion builds on the reviewed base" "$(git -C "$d/origin.git" rev-parse refs/heads/custom)" \
  "$(git -C "$d/origin.git" rev-parse "$dbr^1")"
is "accepted deletion certificate binds the reviewed tree" "$(git -C "$d/origin.git" rev-parse "$dbr^{tree}")" \
  "$(git -C "$d/origin.git" log -1 --format=%B "$dbr" | git interpret-trailers --parse \
    | awk -F': ' '$1=="OMP-AI-Reviewed-Tree"{print $2}')"
is "accepted deletion dispatch binds the same tree" "$(git -C "$d/origin.git" rev-parse "$dbr^{tree}")" \
  "$(cut -d'|' -f3 "$d/fake/dispatch.log")"

# --- 2e. modify/delete, deleted by them: content is written from our side --------

d="$(new_case delours delours)"
rc="$(run_ctrl "$d")"
is "modify/delete (deleted by them) exits 0" 0 "$rc"
is "modify/delete sends the absent theirs as null" "null" \
  "$(jq -r 'select(.mode=="resolve") | .conflicts[] | select(.path=="victim.txt") | .theirs' "$d/fake/requests.jsonl")"
ubr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is "ours-absent content is written" "resolved" \
  "$(git -C "$d/origin.git" show "$ubr:victim.txt" | tr -d '\n')"
is "ours-absent keeps the existing mode" "100644" \
  "$(git -C "$d/origin.git" ls-tree "$ubr" victim.txt | awk '{print $1}')"

# --- 2f. modify/delete, deleted by them: an accepted deletion removes the path ---

d="$(new_case delours-del delours)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=deletefirst)"
is "ours-absent deletion exits 0" 0 "$rc"
xbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "ours-absent deletion publishes the sync branch" "" "$xbr"
is "ours-absent deletion is absent from the candidate tree" absent \
  "$(git -C "$d/origin.git" cat-file -e "$xbr:victim.txt" 2>/dev/null && echo present || echo absent)"

# --- 2g. modify/delete nested in a directory ours removed ------------------------

d="$(new_case dirdelete dirdelete)"
rc="$(run_ctrl "$d")"
is "deleted-directory conflict exits 0" 0 "$rc"
is "deleted-directory conflict sends the absent ours as null" "null" \
  "$(jq -r 'select(.mode == "resolve") | .conflicts[0].ours' "$d/fake/requests.jsonl")"
nbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "deleted-directory conflict publishes the sync branch" "" "$nbr"
is "deleted-directory conflict writes the resolved content" "resolved" \
  "$(git -C "$d/origin.git" show "$nbr:nested/deep.txt" | tr -d '\n')"
is "deleted-directory conflict keeps the mode" "100644" \
  "$(git -C "$d/origin.git" ls-tree "$nbr" nested/deep.txt | awk '{print $1}')"

# --- 3. rejected review: nothing published ---------------------------------------

d="$(new_case reject text)"
rc="$(run_ctrl "$d" FAKE_VERDICT=rejected)"
is "rejected review exits 1" 1 "$rc"
is "rejected review calls both turns" "resolve,review" "$(calls "$d")"
assert_no_push "$d" "rejected review"

# --- malformed or off-contract adapter output -----------------------------------

for variant in malformed provider_fail extrapath traversal missing deletefalse dual badproof wrongmodel markers; do
  d="$(new_case "adapter-$variant" text)"
  rc="$(run_ctrl "$d" "FAKE_ADAPTER_MODE=$variant")"
  is "$variant exits 1" 1 "$rc"
  assert_no_push "$d" "$variant"
done

# --- unsupported conflict kinds fail closed before any model call ----------------

for kind in binary symlink latin1 mode; do
  d="$(new_case "$kind" "$kind")"
  rc="$(run_ctrl "$d")"
  is "$kind conflict exits 1" 1 "$rc"
  is "$kind conflict never reaches the model" "" "$(calls "$d")"
  assert_no_push "$d" "$kind conflict"
done

# --- 13. base advances under review: refuse to publish ---------------------------

d="$(new_case advance text)"
rc="$(run_ctrl "$d" FAKE_ADVANCE=1)"
is "moved base exits 1" 1 "$rc"
assert_no_push "$d" "moved base"
is "moved base keeps the concurrent advance" 3 \
  "$(git -C "$d/origin.git" rev-list --count refs/heads/custom)"

# --- 14. a pre-existing sync branch is never overwritten -------------------------

d="$(new_case existingbranch text)"
existing_base="$(git -C "$d/origin.git" rev-parse refs/heads/custom)"
git -C "$d/origin.git" branch sync/upstream-v1.2.3 "$existing_base"
rc="$(run_ctrl "$d")"
is "existing sync branch exits 1" 1 "$rc"
is "existing sync branch avoids model work" "" "$(calls "$d")"
is "existing sync branch is left alone" "$existing_base" \
  "$(git -C "$d/origin.git" rev-parse refs/heads/sync/upstream-v1.2.3)"
is "existing sync branch blocks the dispatch" "" "$(cat "$d/fake/dispatch.log" 2>/dev/null || true)"

# --- 15. lock busy defers with exit 75 -------------------------------------------

d="$(new_case lock text)"
flock "$d/root/.lock" sleep 10 &
lock_pid=$!
sleep 0.2
rc="$(run_ctrl "$d")"
is "busy install lock defers with 75" 75 "$rc"
is "busy lock does no model work" "" "$(calls "$d")"
assert_no_push "$d" "busy lock"
wait "$lock_pid" 2>/dev/null || true

# --- 15. dispatch failure cannot mutate custom/tag/release -----------------------

d="$(new_case dispatchfail text)"
base_sha="$(git -C "$d/origin.git" rev-parse refs/heads/custom)"
rc="$(run_ctrl "$d" FAKE_GH_MODE=fail_dispatch)"
is "dispatch failure exits 1" 1 "$rc"
is "dispatch failure keeps custom untouched" "$base_sha" "$(git -C "$d/origin.git" rev-parse refs/heads/custom)"
is "dispatch failure creates no tag" "" "$(git -C "$d/origin.git" tag -l)"
is "dispatch failure runs no release/tag command" "" "$(cat "$d/fake/forbidden.log" 2>/dev/null || true)"

# --- 16. the push uses the transient gh credential helper -------------------------
# Local remotes never consult a credential helper, so the push is redirected to an HTTP
# endpoint that answers 401 to everything. Git must then ask the helper (the gh credential
# path), the push must fail, and nothing may be published.
d="$(new_case push-helper text)"
base_sha="$(git -C "$d/origin.git" rev-parse refs/heads/custom)"
cat >"$d/deny-server.py" <<'PY'
import http.server, socketserver, sys
class Deny(http.server.BaseHTTPRequestHandler):
    def _deny(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="ctrl-test"')
        self.send_header("Content-Length", "0")
        self.end_headers()
    do_GET = do_POST = _deny
    def log_message(self, *args):
        pass
server = socketserver.TCPServer(("127.0.0.1", 0), Deny)
with open(sys.argv[1], "w") as fh:
    fh.write(str(server.server_address[1]))
server.serve_forever()
PY
python3 "$d/deny-server.py" "$d/http.port" >"$d/http.log" 2>&1 &
http_pid=$!
for _ in $(seq 50); do [[ -s "$d/http.port" ]] && break; sleep 0.1; done
printf '[url "http://127.0.0.1:%s/"]\n\tpushInsteadOf = %s\n' "$(cat "$d/http.port")" "$d/origin.git" >"$d/home/.gitconfig"
rc="$(run_ctrl "$d" OMP_AI_CONFLICTS_GH_USER=botowner)"
kill "$http_pid" 2>/dev/null || true
wait "$http_pid" 2>/dev/null || true
is "helper push exits 1" 1 "$rc"
helper_calls="$(grep -c '^auth git-credential' "$d/fake/gh.log" 2>/dev/null || true)"
is_not "helper push consults gh git-credential" 0 "${helper_calls:-0}"
is "helper push failure is reported" yes \
  "$(grep -qF "could not push sync/upstream-v1.2.3 without force" "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "helper push"
is "helper push leaves custom untouched" "$base_sha" "$(git -C "$d/origin.git" rev-parse refs/heads/custom)"

printf '\n%d passed, %d failed\n' "$pass" "$failures"
(( failures == 0 ))
