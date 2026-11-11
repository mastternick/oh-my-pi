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

# The plan a real adapter derives from each merged marker file: one region per conflict
# block, one whole-file region when git left no block (modify/delete).
region_count() { # jq filter over .merged
  jq -c "[.conflicts[] as \$c
    | ([\$c.merged | splits(\"\\n\") | select(test(\"^<{7}( |\$)\") )] | length) as \$n
    | range(0; (if \$n == 0 then 1 else \$n end))
    | {path: \$c.path, region: ., content: \"resolved\\n\"}]" <<<"$input"
}

emit_resolve() { # variant
  local variant="$1" files resolutions calls=0 model_id="deepseek-v4.1-flash" name sidecopies="[]" dropregions=0
  local retry=0 feedback=0 feedback_index=0
  if [[ "$(jq -r '(.refusals // []) | length > 0' <<<"$input")" == "true" ]]; then retry=1; fi
  if [[ "$(jq -r '(.reviewFeedback // []) | length > 0' <<<"$input")" == "true" ]]; then
    feedback=1
    [[ -f "$fake/rev1.count" ]] && feedback_index="$(cat "$fake/rev1.count")"
    printf '%s\n' "$((feedback_index + 1))" >"$fake/rev1.count"
  fi
  files="$(jq -c '[.conflicts[] | {path: .path, content: "resolved\n"}]' <<<"$input")"
  resolutions="$(region_count)"
  regions="$(jq -c '[.conflicts[] as $c
      | ([$c.merged | splits("\n") | select(test("^<{7}( |$)"))] | length) as $n
      | {key: $c.path, value: (if $n == 0 then 1 else $n end)}] | from_entries' <<<"$input")"
  case "$variant" in
    extrapath) files="$(jq -c '. + [{path: "evil.txt", content: "x\n"}]' <<<"$files")" ;;
    traversal) files="$(jq -c '. + [{path: "../escape.txt", content: "x\n"}]' <<<"$files")" ;;
    missing) files="$(jq -c '.[1:]' <<<"$files")" ;;
    deletefirst) files="$(jq -c '.[0] = {path: .[0].path, delete: true}' <<<"$files")"
                 resolutions="$(jq -c '.[0].content = ""' <<<"$resolutions")" ;;
    deletefalse) files="$(jq -c '.[0] = {path: .[0].path, delete: false}' <<<"$files")" ;;
    dual) files="$(jq -c '.[0] = {path: .[0].path, content: "x\n", delete: true}' <<<"$files")" ;;
    badproof) calls=1 ;;
    wrongmodel) model_id="other-model" ;;
    markers) files="$(jq -c '[.conflicts[] | {path: .path, content: "<<<<<<< HEAD\nresolved\n"}]' <<<"$input")"
             resolutions="$(jq -c 'map(.content = "<<<<<<< HEAD\nresolved\n")' <<<"$resolutions")" ;;
    regionmissing) resolutions='[]' ;;
    regiondup) resolutions="$(jq -c '. + [.[0]]' <<<"$resolutions")" ;;
    regionextra) resolutions="$(jq -c '.[0].region = 9' <<<"$resolutions")" ;;
    regionsplit) resolutions="$(jq -c '[.[] | select(.region == 0)]' <<<"$resolutions")" ;;
    regionproof) regions="$(jq -c 'with_entries(.value = 1)' <<<"$regions")" ;;
    noproofregions) dropregions=1 ;;
    badregions) regions="$(jq -c 'with_entries(.value = "one")' <<<"$regions")" ;;
    emptyregions) regions='{}' ;;
    placeholder) files="$(jq -c '[.conflicts[] | {path: .path, content: "// Conflict resolution placeholder"}]' <<<"$input")" ;;
    copyours) files="$(jq -c '[.conflicts[] | {path: .path, content: .ours}]' <<<"$input")" ;;
    copytheirs) files="$(jq -c '[.conflicts[] | {path: .path, content: .theirs}]' <<<"$input")" ;;
    copynoise) files="$(jq -c '[.conflicts[] | {path: .path, content: ((.ours | split("\n") | join("\r\n")) + "\r\n")}]' <<<"$input")" ;;
    # The whole file is one side and the plan names region 0 as the copied slice, which is
    # what the real adapter reports for a region answered with a side verbatim.
    copyslice)
      files="$(jq -c '[.conflicts[] | {path: .path, content: .theirs}]' <<<"$input")"
      sidecopies="$(jq -c '[.conflicts[] | {path: .path, region: 0, side: "theirs"}]' <<<"$input")" ;;
    # The same copy on the first turn; a retry request gets the genuine merge. Used with a
    # review that keeps rejecting the path, so the review retry must not run.
    copyslicefixed|copyreview)
      if (( retry == 1 )); then
        files="$(jq -c '[.conflicts[] | {path: .path, content: (.ours + .theirs)}]' <<<"$input")"
      else
        files="$(jq -c '[.conflicts[] | {path: .path, content: .theirs}]' <<<"$input")"
        sidecopies="$(jq -c '[.conflicts[] | {path: .path, region: 0, side: "theirs"}]' <<<"$input")"
      fi ;;
    mergeboth) files="$(jq -c '[.conflicts[] | {path: .path, content: (.ours + .theirs)}]' <<<"$input")" ;;
    # The answer keeps a ">" body line from the ours section of the block: legitimate merged
    # text, so only the "<" opener opens a block.
    answer-terminator)
      files="$(jq -c '[.conflicts[] | {path: .path, content: (.ours + .theirs)}]' <<<"$input")"
      resolutions="$(jq -c '
        (.conflicts | map({key: .path, value: (.ours + .theirs)}) | from_entries) as $by
        | [.conflicts[] | .path as $p
           | ([.merged | splits("\n") | select(test("^<{7}( |$)"))] | length) as $n
           | range(0; (if $n == 0 then 1 else $n end))
           | {path: $p, region: ., content: $by[$p]}]' <<<"$input")" ;;
    # A modify/delete whose surviving side is a setext heading: the whole-file region's answer
    # carries the bare "=======" underline, which is merged text, not a conflict block.
    answer-setext)
      files="$(jq -c '[.conflicts[] | {path: .path, content: .ours}]' <<<"$input")"
      resolutions="$(jq -c '[.conflicts[] | {path: .path, region: 0, content: .ours}]' <<<"$input")" ;;
    # The proved answers are merged text, but the applied files carry a whole block anyway: the
    # post-assembly scan must still refuse a surviving block.
    answer-blockfile)
      files="$(jq -c '[.conflicts[] | {path: .path, content: "<<<<<<< HEAD\nresolved\n=======\ntheirs\n>>>>>>> upstream\n"}]' <<<"$input")" ;;
    dropdecl) files="$(jq -c '[.conflicts[] | {path: .path, content: (.ours | gsub("export function shared[^\\n]*\\n"; ""))}]' <<<"$input")" ;;
    # A review-feedback retry that returns a genuine merge for every region.
    reviewretry|reviewretryfail|reviewone)
      if (( feedback == 1 )); then
        files="$(jq -c '[.conflicts[] | {path: .path, content: (.ours + .theirs)}]' <<<"$input")"
      fi ;;
    # The first retry fixes its path; the second leaves its path as the review rejected it.
    reviewmix)
      if (( feedback == 1 )); then
        if (( feedback_index == 0 )); then
          files="$(jq -c '[.conflicts[] | {path: .path, content: (.ours + .theirs)}]' <<<"$input")"
        else
          jq -r '.reviewFeedback[0].path' <<<"$input" >"$fake/unfixed.path"
        fi
      fi ;;
  esac
  name="OMP — Upstream Conflict Resolver — $job"
  jq -cn --arg job "$job" --arg mid "$model_id" --arg name "$name" \
    --argjson files "$files" --argjson resolutions "$resolutions" --argjson regions "$regions" \
    --argjson calls "$calls" --argjson sidecopies "$sidecopies" --argjson dropregions "$dropregions" '
    {ok: true, mode: "resolve", jobKey: $job,
     model: {provider: "opencode-go", id: $mid},
     session: {id: ("resolver-" + $job), name: $name},
     proof: ({provider: "opencode-go", model: "deepseek-v4.1-flash",
             sessionId: ("resolver-" + $job), sessionName: $name,
             assistantMessages: 1, toolCalls: $calls, toolsExposed: 0,
             retryRecoveries: [], regions: $regions, sideCopies: $sidecopies}
             | if $dropregions == 1 then del(.regions) else . end),
     resolutions: $resolutions,
     files: $files}'
}

emit_review() { # verdict [selector: path | "all"]
  local verdict="$1" sel="${2:-}" first paths wire_verdict="$1" severity="error"
  if [[ "$verdict" == "rejected-warning" ]]; then wire_verdict="rejected"; severity="warning"; fi
  first="$(jq -r '.conflicts[0].path // ""' <<<"$input")"
  [[ -n "$sel" ]] || sel="$first"
  paths="$(jq -c '[.conflicts[].path]' <<<"$input")"
  name="OMP — Upstream Conflict Review — $job"
  jq -cn --arg job "$job" --arg name "$name" --arg sel "$sel" --arg verdict "$wire_verdict" \
    --arg severity "$severity" --argjson paths "$paths" '
    {ok: true, mode: "review", jobKey: $job,
     model: {provider: "opencode-go", id: "deepseek-v4.1-flash"},
     session: {id: ("review-" + $job), name: $name},
     proof: {provider: "opencode-go", model: "deepseek-v4.1-flash",
             sessionId: ("review-" + $job), sessionName: $name,
             assistantMessages: 1, toolCalls: 0, toolsExposed: 0,
             retryRecoveries: []},
     verdict: $verdict,
     findings: (if $verdict == "rejected"
                then (if $sel == "all"
                      then [$paths[] | {path: ., severity: $severity, message: "still broken"}]
                      else [{path: $sel, severity: $severity, message: "still broken"}] end)
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
  response="$(emit_resolve "$scenario")"
elif [[ "$mode" == "review" ]]; then
  review_pass=1
  if [[ -f "$fake/review.count" ]]; then review_pass=$(( $(cat "$fake/review.count") + 1 )); fi
  printf '%s\n' "$review_pass" >"$fake/review.count"
  if [[ "${FAKE_VERDICT:-accepted}" == "rejected" ]]; then
    response="$(emit_review rejected)"
  elif [[ "${FAKE_VERDICT:-accepted}" == "warnonly" ]]; then
    response="$(emit_review rejected-warning)"
  else
    case "$scenario" in
      reviewretry)
        if (( review_pass == 1 )); then response="$(emit_review rejected all)"; else response="$(emit_review accepted)"; fi ;;
      reviewretryfail)
        if (( review_pass == 1 )); then response="$(emit_review rejected all)"; else response="$(emit_review rejected)"; fi ;;
      reviewone)
        if (( review_pass == 1 )); then response="$(emit_review rejected)"; else response="$(emit_review accepted)"; fi ;;
      reviewmix)
        if (( review_pass == 1 )); then
          response="$(emit_review rejected all)"
        else
          response="$(emit_review rejected "$(cat "$fake/unfixed.path")")"
        fi ;;
      copyreview)
        response="$(emit_review rejected)" ;;
      # One batch rejects with a warning only while another names an error: the warning-only
      # rejection has no path to retry, so the run must fail instead of dropping it.
      warnbatch)
        if [[ "$(jq -r '.conflicts[0].path' <<<"$input")" == "bulk/f1.txt" ]]; then
          response="$(emit_review rejected-warning)"
        else
          response="$(emit_review rejected)"
        fi ;;
      *) response="$(emit_review accepted)" ;;
    esac
  fi
else
  jq -cn --arg mode "$mode" '{ok: false, error: {code: "BAD_INPUT", message: ("bad mode " + $mode)}}'
  exit 2
fi
printf '%s\n' "$response"
printf '%s\n' "$response" >>"$fake/responses.jsonl"
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
  # A 972-character path: near `safe_path`'s 1024 limit, long enough that a side-copy note
  # naming it would overflow the adapter's 1000-character refusal bound without truncation.
  local longdir
  longdir="$(printf 'd%.0s' {1..240})/$(printf 'e%.0s' {1..240})/$(printf 'f%.0s' {1..240})/$(printf 'g%.0s' {1..240})"
  git init -q --initial-branch=main "$seed"
  (
    cd "$seed"
    mkdir -p packages/coding-agent scripts nested
    printf '{"name":"coding-agent","version":"1.0.0"}\n' >packages/coding-agent/package.json
    printf 'deep base\n' >nested/deep.txt
    printf 'custom base\n' >custom-feature.txt
    printf 'shared base\n' >shared.txt
    printf 'victim base\n' >victim.txt
    for i in $(seq 1 20); do printf 'line %02d\n' "$i"; done >twoblock.txt
    printf 'latin base\n' >latin.txt
    printf 'Title\n=======\n\nalpha base\n' >doc.md
    printf 'Title\n=======\n\nbody base\n' >heading.txt
    printf 'first\nsecond\nthird\n' >termline.txt
    mkdir -p bulk big
    for i in 1 2 3 4 5 6; do printf 'bulk base %s\n' "$i" >"bulk/f$i.txt"; done
    mkdir -p "$longdir"
    printf 'deep base %s\n' "$longdir" >"$longdir/file.txt"
    printf 'big base\n' >big/f1.txt
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
      delours-setext) git rm -q heading.txt ;;
      addadd) printf 'upstream added\n' >added.txt ;;
      mode) printf 'mode upstream\n' >modefile.sh ;;
      dirdelete) printf 'deep upstream\n' >nested/deep.txt ;;
      latin1) printf 'caf\351 upstream\n' >latin.txt ;;
      longpath) printf 'deep upstream %s\n' "$longdir" >"$longdir/file.txt" ;;
      bulk)
        for i in 1 2 3 4 5 6; do
          printf 'upstream bulk %s %s\n' "$i" "$(printf 'u%.0s' {1..120})" >"bulk/f$i.txt"
        done
        ;;
      big) printf 'upstream big %s\n' "$(printf 'u%.0s' {1..12000})" >big/f1.txt ;;
      setext) sed -i 's/^alpha base$/alpha upstream/' doc.md ;;
      termline) printf 'first\nsecond upstream\nthird\n' >termline.txt ;;
      twoblock)
        sed -i '2s/.*/upstream 02/;19s/.*/upstream 19/' twoblock.txt
        ;;
      many)
        for i in $(seq 1 300); do
          printf 'upstream many %03d %s\n' "$i" "$(printf 'u%.0s' {1..80})"
        done >many.txt
        ;;
      superset) printf 'upstream line\n' >merge.txt ;;
      decls) printf 'export function shared() {}\nexport function theirsOnly() {}\n' >decls.ts ;;
      midbig)
        for i in 1 2 3 4 5 6; do
          if (( i == 4 )); then
            printf 'upstream bulk %s %s\n' "$i" "$(printf 'u%.0s' {1..12000})" >"bulk/f$i.txt"
          else
            printf 'upstream bulk %s %s\n' "$i" "$(printf 'u%.0s' {1..120})" >"bulk/f$i.txt"
          fi
        done
        ;;
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
      delours-setext) printf 'Title\n=======\n\nbody ours\n' >heading.txt ;;
      addadd) printf 'ours added\n' >added.txt ;;
      mode) printf 'mode ours\n' >modefile.sh; chmod 755 modefile.sh ;;
      dirdelete) git rm -r -q nested ;;
      latin1) printf 'na\357ve ours\n' >latin.txt ;;
      longpath) printf 'deep ours %s\n' "$longdir" >"$longdir/file.txt" ;;
      bulk)
        for i in 1 2 3 4 5 6; do
          printf 'ours bulk %s %s\n' "$i" "$(printf 'o%.0s' {1..120})" >"bulk/f$i.txt"
        done
        ;;
      big) printf 'ours big %s\n' "$(printf 'o%.0s' {1..12000})" >big/f1.txt ;;
      twoblock)
        sed -i '2s/.*/ours 02/;19s/.*/ours 19/' twoblock.txt
        ;;
      many)
        for i in $(seq 1 300); do
          printf 'ours many %03d %s\n' "$i" "$(printf 'o%.0s' {1..80})"
        done >many.txt
        ;;
      superset) printf 'upstream line\nours add\n' >merge.txt ;;
      decls) printf 'export function shared() {}\nexport function oursOnly() {}\n' >decls.ts ;;
      midbig)
        for i in 1 2 3 4 5 6; do
          if (( i == 4 )); then
            printf 'ours bulk %s %s\n' "$i" "$(printf 'o%.0s' {1..12000})" >"bulk/f$i.txt"
          else
            printf 'ours bulk %s %s\n' "$i" "$(printf 'o%.0s' {1..120})" >"bulk/f$i.txt"
          fi
        done
        ;;
      text) printf '#!/usr/bin/env bash\necho ours\n' >scripts/tool.sh ;;
      setext) sed -i 's/^alpha base$/alpha ours/' doc.md ;;
      termline) printf 'first\n>>>>>>> looks like a terminator\nthird\n' >termline.txt ;;
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
is "adapter store is under the private session dir" "$d/state/sessions" \
  "$(jq -r '.sessionDir' "$d/fake/requests.jsonl" | xargs -r -n1 dirname | sort -u | tr -d '\n')"
is "resolve and review share one batch session dir" 1 \
  "$(jq -r '.sessionDir' "$d/fake/requests.jsonl" | sort -u | wc -l)"

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
  "$(jq -r 'select(.mode=="review") | .resolutions[] | select(.content == "") | .path' "$d/fake/requests.jsonl")"
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
is "rejected review retries the named path once, then reviews again" \
  "resolve,review,resolve,review" "$(calls "$d")"
is "rejected review names the retry in the failure" yes \
  "$(grep -qF 'review rejected the resolution again after one retry' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "rejected review"

# --- malformed or off-contract adapter output -----------------------------------

for variant in malformed provider_fail extrapath traversal missing deletefalse dual badproof wrongmodel markers \
  regionmissing regiondup regionextra; do
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

# --- 17. batching: a small set stays one turn per mode ----------------------------

count_calls() { # case-dir mode
  local n
  n="$(grep -c "^$2"$'\t' "$1/fake/calls.tsv" 2>/dev/null || true)"
  printf '%s' "${n:-0}"
}

d="$(new_case batch-small bulk)"
rc="$(run_ctrl "$d")"
is "small conflict set exits 0" 0 "$rc"
is "small conflict set uses one resolve turn" 1 "$(count_calls "$d" resolve)"
is "small conflict set uses one review turn" 1 "$(count_calls "$d" review)"
is "small conflict set logs a single batch" 1 \
  "$(grep -c 'batch 1/1: 6 path(s)' "$d/state/run.log" 2>/dev/null || true)"
sbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "small conflict set publishes the sync branch" "" "$sbr"
is "small conflict set resolves every path" 6 \
  "$(for i in 1 2 3 4 5 6; do git -C "$d/origin.git" show "$sbr:bulk/f$i.txt"; done | grep -c '^resolved$' || true)"

# --- 18. batching: a tight budget splits the set and the union stays complete ----

d="$(new_case batch-split bulk)"
all_paths="$(jq -c -n --args '($ARGS.positional | sort)' \
  bulk/f1.txt bulk/f2.txt bulk/f3.txt bulk/f4.txt bulk/f5.txt bulk/f6.txt)"
# One path's regions estimate to ~115 input and ~89 output tokens, so a 150/120 budget
# takes one path per call and two never fit.
rc="$(run_ctrl "$d" \
  OMP_AI_CONFLICTS_INPUT_TOKEN_BUDGET=150 \
  OMP_AI_CONFLICTS_OUTPUT_TOKEN_BUDGET=120 \
  OMP_AI_CONFLICTS_COMBINED_TOKEN_BUDGET=300)"
is "split conflict set exits 0" 0 "$rc"
is "split conflict set batches the resolve turns" 6 "$(count_calls "$d" resolve)"
is "split conflict set batches the review turns" 6 "$(count_calls "$d" review)"
is "split conflict set logs six batches" 6 \
  "$(grep -c 'batch [0-9]/6:' "$d/state/run.log" 2>/dev/null || true)"
is "split resolve requests cover every path once" "$all_paths" \
  "$(jq -c -s '[.[] | select(.mode == "resolve") | .conflicts[].path] | sort' "$d/fake/requests.jsonl")"
is "split review requests see every path once" "$all_paths" \
  "$(jq -c -s '[.[] | select(.mode == "review") | .resolutions[].path] | sort | unique' "$d/fake/requests.jsonl")"
is "split batches use distinct session dirs" 6 \
  "$(jq -r 'select(.mode == "resolve") | .sessionDir' "$d/fake/requests.jsonl" | sort -u | wc -l)"
sbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "split conflict set publishes the sync branch" "" "$sbr"
is "split conflict set resolves every path" 6 \
  "$(for i in 1 2 3 4 5 6; do git -C "$d/origin.git" show "$sbr:bulk/f$i.txt"; done | grep -c '^resolved$' || true)"

# --- 19. a path that cannot fit the budget alone stops the run -------------------

d="$(new_case batch-oversized bulk)"
rc="$(run_ctrl "$d" \
  OMP_AI_CONFLICTS_INPUT_TOKEN_BUDGET=10 \
  OMP_AI_CONFLICTS_OUTPUT_TOKEN_BUDGET=50 \
  OMP_AI_CONFLICTS_COMBINED_TOKEN_BUDGET=200)"
is "oversized path exits 1" 1 "$rc"
is "oversized path never reaches the model" "" "$(calls "$d")"
is "oversized path is named with its budget" yes \
  "$(grep -qE "conflicted path 'bulk/f1.txt' alone needs ~[0-9]+ input tokens" "$d/stderr.log" \
    && grep -qF 'input 10, output 50, combined 200' "$d/stderr.log" && echo yes || echo no)"
is "oversized path refuses to truncate" yes \
  "$(grep -qF 'refusing to truncate or drop it' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "oversized path"

# --- 20. a placeholder answer is refused instead of being committed --------------

d="$(new_case batch-placeholder big)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=placeholder)"
is "placeholder answer exits 1" 1 "$rc"
is "placeholder answer reaches the model once" "resolve" "$(calls "$d")"
is "placeholder answer is named with its sizes" yes \
  "$(grep -qF "resolved content for 'big/f1.txt' is 34 bytes" "$d/stderr.log" \
    && grep -qF 'under half of the smaller current side (12010 bytes)' "$d/stderr.log" && echo yes || echo no)"
is "placeholder answer never reaches review" 0 "$(count_calls "$d" review)"
assert_no_push "$d" "placeholder answer"

# --- 21. the answer budget is what sizes the batches ---------------------------

d="$(new_case batch-cap-split big)"
rc="$(run_ctrl "$d" OMP_AI_CONFLICTS_OUTPUT_TOKEN_BUDGET=2400)"
is "answer-sized batch budget exits 1" 1 "$rc"
is "answer-sized batch budget never reaches the model" "" "$(calls "$d")"
is "answer-sized batch budget is named" yes \
  "$(grep -qE "conflicted path 'big/f1.txt' alone needs ~[0-9]+ input tokens" "$d/stderr.log" \
    && grep -qF 'output 2400, combined 900000' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "answer-sized batch budget"

# --- 23. an exact copy of our side is refused when it drops upstream -------------

d="$(new_case batch-ours-copy big)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=copyours)"
is "exact ours copy exits 1" 1 "$rc"
is "exact ours copy is retried exactly once" "resolve,resolve" "$(calls "$d")"
is "exact ours copy names the retry" yes \
  "$(grep -qF 'retried once in a fresh session (-r1)' "$d/stderr.log" && echo yes || echo no)"
is "exact ours copy is named as a side copy" yes \
  "$(grep -qF "resolved content for 'big/f1.txt' matches our side" "$d/stderr.log" \
    && grep -qF 'refusing (SIDE_COPY)' "$d/stderr.log" && echo yes || echo no)"
is "exact ours copy never reaches review" 0 "$(count_calls "$d" review)"
assert_no_push "$d" "exact ours copy"

# --- 24. an exact copy of the upstream side is refused the same way -------------

d="$(new_case batch-theirs-copy big)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=copytheirs)"
is "exact upstream copy exits 1" 1 "$rc"
is "exact upstream copy is named as a side copy" yes \
  "$(grep -qF "resolved content for 'big/f1.txt' matches the upstream side" "$d/stderr.log" \
    && grep -qF 'refusing (SIDE_COPY)' "$d/stderr.log" && echo yes || echo no)"
is "exact upstream copy is retried exactly once" "resolve,resolve" "$(calls "$d")"
is "exact upstream copy never reaches review" 0 "$(count_calls "$d" review)"
assert_no_push "$d" "exact upstream copy"

# --- 25. a copy that already contains the other side is still a merge -----------

d="$(new_case batch-contained superset)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=copyours)"
is "contained side copy exits 0" 0 "$rc"
is "contained side copy keeps the guard silent" 1 "$(count_calls "$d" resolve)"
cbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is "contained side copy publishes the merged content" 2 \
  "$(git -C "$d/origin.git" show "$cbr:merge.txt" | grep -c '^\(upstream line\|ours add\)$' || true)"

# --- 26. a resolution that drops a declaration both sides had is refused --------

d="$(new_case batch-dropped-decl decls)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=dropdecl)"
is "dropped declaration exits 1" 1 "$rc"
is "dropped declaration is named" yes \
  "$(grep -qF "resolved content for 'decls.ts' no longer declares shared" "$d/stderr.log" \
    && grep -qF 'refusing (DROPPED_DECLARATIONS)' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "dropped declaration"

# --- 26b. a genuine merge that keeps both sides is still accepted --------------

d="$(new_case batch-merge-both big)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=mergeboth)"
is "both-sides merge exits 0" 0 "$rc"
mbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is "both-sides merge publishes both sides" 2 \
  "$(git -C "$d/origin.git" show "$mbr:big/f1.txt" | grep -c '^\(upstream\|ours\) big ' || true)"

# --- 26c. a copy that drops hundreds of lines is refused, not aborted ----------

d="$(new_case batch-many-copy many)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=copyours)"
is "many-line copy exits 1" 1 "$rc"
is "many-line copy is named as a side copy" yes \
  "$(grep -qF "resolved content for 'many.txt' matches our side" "$d/stderr.log" \
    && grep -qF 'refusing (SIDE_COPY)' "$d/stderr.log" && echo yes || echo no)"
is "many-line copy is retried exactly once" "resolve,resolve" "$(calls "$d")"
is "many-line copy is a guard refusal, not a broken pipeline" no \
  "$(grep -qE '(^|[^0-9])(141|pipefail|unbound)([^0-9]|$)' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "many-line copy"

# --- 26d. a side copy with different line endings is still a copy ----------------

d="$(new_case batch-noise-copy big)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=copynoise)"
is "crlf side copy exits 1" 1 "$rc"
is "crlf side copy is named as a side copy" yes \
  "$(grep -qF "resolved content for 'big/f1.txt' matches our side" "$d/stderr.log" \
    && grep -qF 'refusing (SIDE_COPY)' "$d/stderr.log" && echo yes || echo no)"
is "crlf side copy is retried exactly once" "resolve,resolve" "$(calls "$d")"
assert_no_push "$d" "crlf side copy"

# --- 27. the infeasible path is named even mid-order ----------------------------

d="$(new_case batch-midbig midbig)"
rc="$(run_ctrl "$d" \
  OMP_AI_CONFLICTS_INPUT_TOKEN_BUDGET=1000 \
  OMP_AI_CONFLICTS_OUTPUT_TOKEN_BUDGET=200 \
  OMP_AI_CONFLICTS_COMBINED_TOKEN_BUDGET=2000)"
is "mid-order oversized path exits 1" 1 "$rc"
is "mid-order oversized path never reaches the model" "" "$(calls "$d")"
is "mid-order oversized path is the large one" yes \
  "$(grep -qF "conflicted path 'bulk/f4.txt' alone needs" "$d/stderr.log" \
    && ! grep -qF "conflicted path 'bulk/f1.txt'" "$d/stderr.log" && echo yes || echo no)"
is "mid-order oversized path names its budget" yes \
  "$(grep -qF 'input 1000, output 200, combined 2000' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "mid-order oversized path"

# --- 28. the request carries git's diff3 marker file and its regions -----------

d="$(new_case regions-request twoblock)"
rc="$(run_ctrl "$d")"
is "two-region conflict exits 0" 0 "$rc"
is "two-region conflict is one resolve and one review turn" "resolve,review" "$(calls "$d")"
merged_text="$(jq -r 'select(.mode=="resolve") | .conflicts[0].merged' "$d/fake/requests.jsonl")"
is "the request carries the merged marker file" yes \
  "$(grep -q '^<<<<<<< ' <<<"$merged_text" && echo yes || echo no)"
is "the merged file carries the diff3 base section" yes \
  "$(grep -q '^||||||| ' <<<"$merged_text" && echo yes || echo no)"
is "the merged file carries both conflict blocks" 2 \
  "$(grep -c '^<<<<<<< ' <<<"$merged_text" || true)"
is "the review carries both proposed regions" 2 \
  "$(jq -r 'select(.mode=="review") | [.resolutions[] | select(.path=="twoblock.txt")] | length' "$d/fake/requests.jsonl")"
rbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "two-region conflict publishes the sync branch" "" "$rbr"
is "the assembled output is applied, never the marker file" "resolved" \
  "$(git -C "$d/origin.git" show "$rbr:twoblock.txt" | tr -d '\n')"

# --- 29. region answers that do not match the plan are refused ------------------

d="$(new_case regions-missing twoblock)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=regionmissing)"
is "a path with regions and no answer exits 1" 1 "$rc"
is "a path with regions and no answer is named" yes \
  "$(grep -qF "resolved 0 of 2 conflict region(s) in 'twoblock.txt'" "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "a path with regions and no answer"

d="$(new_case regions-split twoblock)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=regionsplit)"
is "a half-answered plan exits 1" 1 "$rc"
is "a half-answered plan is named" yes \
  "$(grep -qF "resolved 1 of 2 conflict region(s) in 'twoblock.txt'" "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "a half-answered plan"

d="$(new_case regions-dup twoblock)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=regiondup)"
is "a duplicated region index exits 1" 1 "$rc"
is "a duplicated region index is named" yes \
  "$(grep -qF 'resolves the same region more than once' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "a duplicated region index"

d="$(new_case regions-extra twoblock)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=regionextra)"
is "an unknown region index exits 1" 1 "$rc"
is "an unknown region index is named" yes \
  "$(grep -qF "answers region 9 of 'twoblock.txt', which has only 2 region(s)" "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "an unknown region index"

d="$(new_case regions-proof twoblock)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=regionproof)"
is "a region count that disagrees with the plan exits 1" 1 "$rc"
is "a region count that disagrees with the plan is named" yes \
  "$(grep -qF "proves 1 conflict region(s) for 'twoblock.txt' but git's merged file has 2" "$d/stderr.log" \
    && echo yes || echo no)"
assert_no_push "$d" "a region count that disagrees with the plan"

d="$(new_case regions-marker twoblock)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=markers)"
is "a marker line in an answer exits 1" 1 "$rc"
is "a marker line in an answer is named" yes \
  "$(grep -qF 'with a conflict marker line; a replacement must be merged text' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "a marker line in an answer"

# --- 30. the region plan is required, and it must match git's merged file ------------

d="$(new_case regions-noproof twoblock)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=noproofregions)"
is "a missing region plan exits 1" 1 "$rc"
is "a missing region plan never reaches review" 0 "$(count_calls "$d" review)"
is "a missing region plan is refused as malformed" yes \
  "$(grep -qF 'resolver result for batch 1/1 is missing, off-allowlist, malformed' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "a missing region plan"

d="$(new_case regions-badproof twoblock)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=badregions)"
is "a non-numeric region count exits 1" 1 "$rc"
is "a non-numeric region count is refused as malformed" yes \
  "$(grep -qF 'resolver result for batch 1/1 is missing, off-allowlist, malformed' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "a non-numeric region count"

d="$(new_case regions-empty-proof twoblock)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=emptyregions)"
is "an empty region plan exits 1" 1 "$rc"
is "an empty region plan is refused as malformed" yes \
  "$(grep -qF 'resolver result for batch 1/1 is missing, off-allowlist, malformed' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "an empty region plan"

# --- 31. a legitimate "=======" line outside a region must not fail the sync ---------

d="$(new_case setext setext)"
rc="$(run_ctrl "$d")"
is "a setext underline outside a region exits 0" 0 "$rc"
is "a setext underline outside a region is reviewed" "resolve,review" "$(calls "$d")"
sbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "a setext underline outside a region publishes the sync branch" "" "$sbr"
is "the merged file carries the setext underline outside the block" 2 \
  "$(jq -r 'select(.mode == "resolve") | .conflicts[0].merged' "$d/fake/requests.jsonl" | grep -c '^=======$' || true)"
is "the setext run still consumed exactly one region" 1 \
  "$(jq -r 'select(.mode == "resolve") | .proof.regions["doc.md"]' "$d/fake/responses.jsonl")"
is "no marker block is left in the candidate" 0 \
  "$(git -C "$d/origin.git" show "$sbr:doc.md" | grep -c '^<<<<<<< \|^>>>>>>> ' || true)"

# --- 32. a body line that starts with ">>>>>>>" before the separator ----------------

d="$(new_case termline termline)"
rc="$(run_ctrl "$d")"
is "a terminator-like body line exits 0" 0 "$rc"
is "a terminator-like body line is parsed as one region" 1 \
  "$(jq -r 'select(.mode == "resolve") | .proof.regions["termline.txt"]' "$d/fake/responses.jsonl")"
tbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "a terminator-like body line publishes the sync branch" "" "$tbr"
is "a terminator-like body line is replaced, not truncated" "resolved" \
  "$(git -C "$d/origin.git" show "$tbr:termline.txt" | tr -d '\n')"

# --- 32b. an answer may keep marker-like text that is part of the merge ------------

d="$(new_case answer-setext delours-setext)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=answer-setext)"
is "a setext line in a whole-file answer exits 0" 0 "$rc"
is "a setext line in a whole-file answer resolves then reviews" "resolve,review" "$(calls "$d")"
asbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "a setext line in a whole-file answer publishes the sync branch" "" "$asbr"
is "a setext line in a whole-file answer survives to the candidate" 1 \
  "$(git -C "$d/origin.git" show "$asbr:heading.txt" | grep -c '^=======$' || true)"
is "a setext line in a whole-file answer keeps our body" "body ours" \
  "$(git -C "$d/origin.git" show "$asbr:heading.txt" | awk '/^body /{print}')"

d="$(new_case answer-terminator termline)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=answer-terminator)"
is "a terminator-like line inside an answer exits 0" 0 "$rc"
is "a terminator-like line inside an answer resolves then reviews" "resolve,review" "$(calls "$d")"
atbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "a terminator-like line inside an answer publishes the sync branch" "" "$atbr"
is "a terminator-like line inside an answer survives to the candidate" 1 \
  "$(git -C "$d/origin.git" show "$atbr:termline.txt" | grep -c '^>>>>>>> looks like a terminator$' || true)"

# --- 32c. a surviving block is still fatal however the answer budget moved --------

d="$(new_case answer-block text)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=answer-blockfile)"
is "a surviving block exits 1" 1 "$rc"
is "a surviving block is caught before any retry" "resolve,review" "$(calls "$d")"
is "a surviving block is refused after assembly" yes \
  "$(grep -qF 'the assembled file still carries 1 conflict block(s)' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "a surviving block"

# --- 33. a side copy earns exactly one retry, and it can succeed --------------------

d="$(new_case retry-ok big)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=copyslicefixed)"
is "retry after a side copy exits 0" 0 "$rc"
is "retry calls resolve twice and then reviews" "resolve,resolve,review" "$(calls "$d")"
is "the retry request names the rejected region" "big/f1.txt	[0]" \
  "$(jq -r 'select(.refusals) | [.refusals[0].path, (.refusals[0].regions | tostring)] | @tsv' "$d/fake/requests.jsonl")"
is "the retry request names the copied side" "theirs" \
  "$(jq -r 'select(.refusals) | .refusals[0].side' "$d/fake/requests.jsonl")"
is "the retry request carries the refusal text" yes \
  "$(jq -r 'select(.refusals) | .refusals[0].reason' "$d/fake/requests.jsonl" | grep -qF 'refusing (SIDE_COPY)' && echo yes || echo no)"
is "the retry runs in a fresh session dir" 2 \
  "$(jq -r 'select(.mode == "resolve") | .sessionDir' "$d/fake/requests.jsonl" | sort -u | wc -l)"
is "the retry job key carries its own suffix" yes \
  "$(jq -r 'select(.refusals) | .jobKey' "$d/fake/requests.jsonl" | grep -q -- '-r1$' && echo yes || echo no)"
rbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "a successful retry publishes the sync branch" "" "$rbr"
is "a successful retry publishes the merged candidate" 2 \
  "$(git -C "$d/origin.git" show "$rbr:big/f1.txt" | grep -c '^\(upstream\|ours\) big ' || true)"
is "the review judged the retried answer" 1 \
  "$(jq -r 'select(.mode == "review") | [.resolutions[] | select(.path == "big/f1.txt")] | length' "$d/fake/requests.jsonl")"

# --- 34. a retry that reproduces the copy still stops the run ----------------------

d="$(new_case retry-copy big)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=copyslice)"
is "a reproduced copy exits 1" 1 "$rc"
is "a reproduced copy is retried exactly once" "resolve,resolve" "$(calls "$d")"
is "a reproduced copy keeps its original refusal" yes \
  "$(grep -qF "resolved content for 'big/f1.txt' matches the upstream side" "$d/stderr.log" \
    && grep -qF 'refusing (SIDE_COPY)' "$d/stderr.log" && echo yes || echo no)"
is "a reproduced copy names the retry" yes \
  "$(grep -qF 'retried once in a fresh session (-r1)' "$d/stderr.log" && echo yes || echo no)"
is "a reproduced copy never reaches review" 0 "$(count_calls "$d" review)"
assert_no_push "$d" "a reproduced copy"

# --- 36. a review rejection earns one fresh retry per path, then a re-review ------

d="$(new_case review-retry text)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=reviewretry)"
is "review retry exits 0" 0 "$rc"
is "review retry re-resolves both rejected paths then reviews the whole set" \
  "resolve,review,resolve,resolve,review" "$(calls "$d")"
is "the review retry carries the finding text" "still broken" \
  "$(jq -r 'select(.reviewFeedback) | .reviewFeedback[0].findings[0]' "$d/fake/requests.jsonl" | head -n1)"
is "the review retry carries the rejected answers" yes \
  "$(jq -r 'select(.reviewFeedback) | [.reviewFeedback[0].priorAnswers[] | .region] | length' "$d/fake/requests.jsonl" \
    | head -n1 | grep -qx '[1-9][0-9]*' && echo yes || echo no)"
is "the review retry covers the path's whole region plan" yes \
  "$(jq -r 'select(.reviewFeedback) | [.reviewFeedback[0].regions] | length' "$d/fake/requests.jsonl" \
    | head -n1 | grep -qx '[1-9][0-9]*' && echo yes || echo no)"
is "each review retry has its own job key" 2 \
  "$(jq -r 'select(.reviewFeedback) | .jobKey' "$d/fake/requests.jsonl" | sort -u | wc -l)"
is "each review retry names -rev1" yes \
  "$(jq -r 'select(.reviewFeedback) | .jobKey' "$d/fake/requests.jsonl" | grep -qE -- '-rev1-[0-9]+$' && echo yes || echo no)"
is "review retries run in their own session dirs" 3 \
  "$(jq -r 'select(.mode == "resolve") | .sessionDir' "$d/fake/requests.jsonl" | sort -u | wc -l)"
is "the re-review runs in a fresh session dir" 2 \
  "$(jq -r 'select(.mode == "review") | .sessionDir' "$d/fake/requests.jsonl" | sort -u | wc -l)"
rrbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is_not "a cleared review retry publishes the sync branch" "" "$rrbr"
rrtrailers="$(git -C "$d/origin.git" log -1 --format=%B "$rrbr" | git interpret-trailers --parse)"
is "a cleared review retry keeps exactly four OMP-AI trailers" 4 \
  "$(grep -c '^OMP-AI-' <<<"$rrtrailers" || true)"
is "the certificate records the review retry" yes \
  "$(git -C "$d/origin.git" log -1 --format=%B "$rrbr" \
    | grep -qF 'Review-Retry: v1 re-resolved after a rejected review' && echo yes || echo no)"
is "the review retry record names both retried paths" yes \
  "$(git -C "$d/origin.git" log -1 --format=%B "$rrbr" \
    | grep -qF 'custom-feature.txt#' && git -C "$d/origin.git" log -1 --format=%B "$rrbr" \
    | grep -qF 'scripts/tool.sh#' && echo yes || echo no)"
is "the re-review judged the revised answer" "custom changeupstream change" \
  "$(git -C "$d/origin.git" show "$rrbr:custom-feature.txt" | tr -d '\n')"

# --- 36b. the re-review carries only the paths whose answers changed --------------

d="$(new_case review-one text)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=reviewone)"
is "one rejected path exits 0 after its retry" 0 "$rc"
is "one rejected path is retried once and re-reviewed" "resolve,review,resolve,review" "$(calls "$d")"
is "the run makes one first review and one retry review" 2 \
  "$(jq -s '[.[] | select(.mode == "review")] | length' "$d/fake/requests.jsonl")"
is "the re-review carries exactly the retried path" "custom-feature.txt" \
  "$(jq -rs '[.[] | select(.mode == "review")][1].conflicts | map(.path) | join(",")' "$d/fake/requests.jsonl")"
is "the re-review carries no unrejected path" 1 \
  "$(jq -s '[.[] | select(.mode == "review")][1].resolutions | map(.path) | unique | length' "$d/fake/requests.jsonl")"
orbr="$(git -C "$d/origin.git" rev-parse --verify --quiet refs/heads/sync/upstream-v1.2.3)"
is "a one-path re-review publishes the sync branch" yes \
  "$([[ -n "$orbr" ]] && echo yes || echo no)"
is "the certificate names the retried path" yes \
  "$(git -C "$d/origin.git" log -1 --format=%B "$orbr" | grep -qF 'custom-feature.txt#' \
    && ! git -C "$d/origin.git" log -1 --format=%B "$orbr" | grep -qF 'scripts/tool.sh#' \
    && echo yes || echo no)"

# --- 37. a retry that does not clear the review fails the run ---------------------

d="$(new_case review-retry-fail text)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=reviewretryfail)"
is "a still-rejected retry exits 1" 1 "$rc"
is "a still-rejected retry is not repeated" 3 "$(count_calls "$d" resolve)"
is "a still-rejected retry gets one re-review" 2 "$(count_calls "$d" review)"
is "a still-rejected retry fails with the findings" yes \
  "$(grep -qF 'review rejected the resolution again after one retry' "$d/stderr.log" \
    && grep -qF 'still broken' "$d/stderr.log" && echo yes || echo no)"
is "a still-rejected retry names the retried path" yes \
  "$(grep -qF 'custom-feature.txt#' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "a still-rejected retry"

# --- 38. a mixed retry fails as a whole when one path stays rejected -------------

d="$(new_case review-retry-mixed text)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=reviewmix)"
is "a mixed review retry exits 1" 1 "$rc"
is "a mixed review retry re-resolves both paths then re-reviews" \
  "resolve,review,resolve,resolve,review" "$(calls "$d")"
is "a mixed review retry names the still-rejected path" yes \
  "$(grep -qF 'review rejected the resolution again after one retry' "$d/stderr.log" \
    && grep -qF "$(cat "$d/fake/unfixed.path")" "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "a mixed review retry"

# --- 39. a review rejection with no error finding is never retried ----------------

d="$(new_case review-no-error text)"
rc="$(run_ctrl "$d" FAKE_VERDICT=warnonly)"
is "a rejection without an error finding exits 1" 1 "$rc"
is "a rejection without an error finding runs no retry" "resolve,review" "$(calls "$d")"
assert_no_push "$d" "a rejection without an error finding"

# --- 40. a warning-only batch rejection is never dropped by another batch's retry --

d="$(new_case review-batch-warn bulk)"
# The same one-path-per-batch budget as test 18: batch 1 is bulk/f1.txt, which the fake
# rejects with a warning only while every later batch names an error.
rc="$(run_ctrl "$d" \
  OMP_AI_CONFLICTS_INPUT_TOKEN_BUDGET=150 \
  OMP_AI_CONFLICTS_OUTPUT_TOKEN_BUDGET=120 \
  OMP_AI_CONFLICTS_COMBINED_TOKEN_BUDGET=300 \
  FAKE_ADAPTER_MODE=warnbatch)"
is "a warning-only batch rejection exits 1" 1 "$rc"
is "a warning-only batch rejection never retries a path" 6 "$(count_calls "$d" resolve)"
is "a warning-only batch rejection stops before a re-review" 1 "$(count_calls "$d" review)"
is "a warning-only batch rejection is named with its batch" yes \
  "$(grep -qF 'review rejected the resolution for batch 1/6 without naming a path with an error finding' \
    "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "a warning-only batch rejection"

# --- 41. a side-copy retry is never spent a second time on a review rejection ------

d="$(new_case review-after-copy big)"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=copyreview)"
is "a review rejection after a side-copy retry exits 1" 1 "$rc"
is "a review rejection after a side-copy retry re-resolves exactly once" \
  "resolve,resolve,review" "$(calls "$d")"
is "a review rejection after a side-copy retry is named" yes \
  "$(grep -qF 'after its one retry (a side-copy retry already ran)' "$d/stderr.log" && echo yes || echo no)"
assert_no_push "$d" "a review rejection after a side-copy retry"

# --- 42. a maximal path still produces a valid side-copy refusal -------------------

d="$(new_case copy-note-long longpath)"
longpath="$(git -C "$d/seed" ls-tree -r --name-only HEAD | grep '/file\.txt$')"
rc="$(run_ctrl "$d" FAKE_ADAPTER_MODE=copyslicefixed)"
is "a maximal path exits 0 after its copy retry" 0 "$rc"
is "a maximal path is retried once then reviewed" "resolve,resolve,review" "$(calls "$d")"
reason_len="$(jq -r 'select(.refusals) | .refusals[0].reason | length' "$d/fake/requests.jsonl")"
is "a maximal path keeps its refusal inside the adapter's 1000-character bound" yes \
  "$([[ "$reason_len" =~ ^[0-9]+$ ]] && (( reason_len <= 1000 )) && echo yes || echo no)"
is "a maximal path is elided in its refusal, not left whole" yes \
  "$((( reason_len < ${#longpath} )) && echo yes || echo no)"
is "the refusal still names the refused path and side" yes \
  "$(jq -r 'select(.refusals) | .refusals[0].reason' "$d/fake/requests.jsonl" \
    | grep -qF "file.txt' matches the upstream side" && echo yes || echo no)"
is "the refusal still carries the full path" "$longpath" \
  "$(jq -r 'select(.refusals) | .refusals[0].path' "$d/fake/requests.jsonl")"

printf '\n%d passed, %d failed\n' "$pass" "$failures"
(( failures == 0 ))