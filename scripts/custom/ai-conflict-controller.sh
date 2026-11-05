#!/usr/bin/env bash
# Resolve an upstream-sync merge conflict with the narrow model boundary and hand the
# exact reviewed candidate to the existing custom-sync pipeline.
#
# This script never publishes: it does not push `custom`, create tags, or create
# releases. It only reports one candidate so the existing CI/FF/tag/release gates in
# sync-upstream.sh (dispatched through custom-sync.yml) decide publication.
#
#   1. Probe upstream-vs-custom in a fresh blobless clone under RAM (/dev/shm):
#      a clean merge is left to the existing GitHub custom-sync run (exit 0, no AI).
#   2. A conflicting merge fails closed unless every unmerged path is a regular text
#      file in one of the ordinary classes: both added (no merge base), modify/delete
#      (base present, one current side), or modify/modify. Symlinks, submodules,
#      binaries, non-UTF-8 text, mode disagreements, and add/rename halves without a
#      base stop here. An absent stage is sent as JSON null, never as empty text.
#   3. Stage base/ours/theirs for exactly those paths, ask ai-conflict-model.ts to
#      resolve them (fresh jobKey) into one content or one deletion per path, then ask
#      it for an independent review of exactly that proposal.
#   4. Apply exactly the allowlisted results (writing content with the mode of the one
#      regular stage, or removing the path from the index), run deterministic checks,
#      commit the merge, and re-verify origin/<base> is unchanged before pushing
#      the non-force branch sync/upstream-<tag>.
#   5. Dispatch custom-sync with expected_base_sha/expected_tree_sha and wait for a
#      terminal success. Any stale base, existing sync branch, race, adapter failure,
#      rejected review, or failed run stops without publishing.
#
#   ai-conflict-controller.sh [vX.Y.Z]     (default: newest stable upstream tag)
#
# With no argument this is the service entry point: it discovers the newest stable
# upstream release and either leaves it to the existing GitHub run or resolves the
# conflict and hands the reviewed candidate over. It is safe to run repeatedly (locks,
# no-ops, existing-branch and moved-base guards).
#
# Environment:
#   OMP_CUSTOM_HOME               install root (default ${XDG_DATA_HOME:-~/.local/share}/omp-custom)
#   OMP_CUSTOM_REPO               GitHub repo slug (default mastternick/oh-my-pi)
#   OMP_CUSTOM_BRANCH             base branch (default custom)
#   OMP_UPSTREAM_URL              upstream clone URL (default can1357/oh-my-pi)
#   OMP_ORIGIN_URL                origin clone URL (default https://github.com/$OMP_CUSTOM_REPO.git)
#   OMP_AI_CONFLICTS_TMPDIR       RAM work root (default /dev/shm)
#   OMP_AI_CONFLICTS_MIN_FREE     minimum free bytes there (default 2147483648 = 2 GiB)
#   OMP_AI_CONFLICTS_STATE_DIR    state/log dir (default $ROOT/state/ai-conflicts)
#   OMP_AI_CONFLICTS_ADAPTER      model adapter (default ai-conflict-model.ts next to this script)
#   OMP_AI_CONFLICTS_BUN          bun executable (default bun)
#   OMP_AI_CONFLICTS_MODEL_TIMEOUT_MS  per-turn model timeout (default 300000)
#   OMP_AI_CONFLICTS_HARD_TIMEOUT      wall timeout for one adapter call, seconds (default 900)
#   OMP_AI_CONFLICTS_MAX_TEXT_BYTES    cap on conflicted text, bytes (default 7340032)
#   OMP_AI_CONFLICTS_MAX_RESOLUTION_BYTES  cap on proposed resolution, bytes (default 7340032)
#   OMP_AI_CONFLICTS_SYNC_WORKFLOW     workflow dispatched after the push (default custom-sync.yml)
#   OMP_AI_CONFLICTS_TIMEOUT      seconds to wait for that run (default 7200)
#   OMP_AI_CONFLICTS_POLL         seconds between run polls (default 30)
#   OMP_AI_CONFLICTS_KEEP_WORK    1 = keep the RAM clone for inspection (never in service)
#   OMP_AI_CONFLICTS_GH_USER      optional gh account that owns the fork; its existing
#                                 token is exported for gh subprocesses only (never printed,
#                                 never `gh auth switch`). Unset = ambient gh login.
#
# Exit codes: 0 no work or a successful hand-off; 75 deferred (lock busy or low space);
# 1 any failure. Nothing is force-pushed and no secret is logged.
#
# Requires: git, gh (authenticated for $OMP_CUSTOM_REPO), jq, bun, df, flock.
# shellcheck disable=SC2016 # jq programs reference their own $variables on purpose
set -euo pipefail

UPSTREAM_URL="${OMP_UPSTREAM_URL:-https://github.com/can1357/oh-my-pi.git}"
BASE="${OMP_CUSTOM_BRANCH:-custom}"
REPO="${OMP_CUSTOM_REPO:-mastternick/oh-my-pi}"
ORIGIN_URL="${OMP_ORIGIN_URL:-https://github.com/$REPO.git}"
ROOT="${OMP_CUSTOM_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/omp-custom}"
STATE="${OMP_AI_CONFLICTS_STATE_DIR:-$ROOT/state/ai-conflicts}"
TMPROOT="${OMP_AI_CONFLICTS_TMPDIR:-/dev/shm}"
MIN_FREE="${OMP_AI_CONFLICTS_MIN_FREE:-2147483648}"
BUN="${OMP_AI_CONFLICTS_BUN:-bun}"
MODEL_TIMEOUT_MS="${OMP_AI_CONFLICTS_MODEL_TIMEOUT_MS:-300000}"
HARD_TIMEOUT="${OMP_AI_CONFLICTS_HARD_TIMEOUT:-900}"
MAX_TEXT="${OMP_AI_CONFLICTS_MAX_TEXT_BYTES:-7340032}"
MAX_RESOLUTION="${OMP_AI_CONFLICTS_MAX_RESOLUTION_BYTES:-7340032}"
SYNC_WF="${OMP_AI_CONFLICTS_SYNC_WORKFLOW:-custom-sync.yml}"
TIMEOUT="${OMP_AI_CONFLICTS_TIMEOUT:-7200}"
POLL="${OMP_AI_CONFLICTS_POLL:-30}"
KEEP_WORK="${OMP_AI_CONFLICTS_KEEP_WORK:-0}"
GH_USER="${OMP_AI_CONFLICTS_GH_USER:-}"

if [[ -d "$HOME/.bun/bin" && ":$PATH:" != *":$HOME/.bun/bin:"* ]]; then
  PATH="$HOME/.bun/bin:$PATH"
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ADAPTER="${OMP_AI_CONFLICTS_ADAPTER:-$script_dir/ai-conflict-model.ts}"

# Model identity is pinned here as a second opinion: the adapter's own proof must also
# carry exactly this provider/model, so a silently reconfigured fallback stops the run.
MODEL_PROVIDER="opencode-go"
MODEL_ID="deepseek-v4.1-flash"

tag=""
jobKey=""
base_sha=""
candidate=""
tree=""
run_dir=""
LOG=""
work=""

umask 077

log() {
  local ts
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if [[ -n "$LOG" ]]; then
    printf '%s %s\n' "$ts" "$*" >>"$LOG" 2>/dev/null || true
  fi
  printf '%s\n' "$*" >&2
}

record_result() { # status detail
  [[ -d "$STATE" ]] || return 0
  {
    printf 'time\t%s\n' "$(date -u +%FT%TZ)"
    printf 'status\t%s\n' "$1"
    printf 'tag\t%s\n' "${tag:-}"
    printf 'jobKey\t%s\n' "${jobKey:-}"
    printf 'base\t%s\n' "${base_sha:-}"
    printf 'candidate\t%s\n' "${candidate:-}"
    printf 'tree\t%s\n' "${tree:-}"
    printf 'detail\t%s\n' "$2"
  } >"$STATE/last-result.tmp" 2>/dev/null || return 0
  chmod 600 "$STATE/last-result.tmp" 2>/dev/null || true
  mv -f "$STATE/last-result.tmp" "$STATE/last-result" 2>/dev/null || true
}

fail() {
  log "error: $*"
  record_result failed "$*"
  exit 1
}

defer() {
  log "deferred: $*"
  record_result deferred "$*"
  exit 75
}

cleanup() {
  local rc=$?
  if [[ -n "$run_dir" && -d "$run_dir" && "$KEEP_WORK" != "1" ]]; then
    rm -rf -- "$run_dir"
  fi
  return "$rc"
}
trap cleanup EXIT

for cmd in git gh jq "$BUN" df flock iconv; do
  command -v "$cmd" >/dev/null || fail "missing required command: $cmd"
done
[[ -f "$ADAPTER" ]] || fail "model adapter not found at $ADAPTER (set OMP_AI_CONFLICTS_ADAPTER)"

# Account selection is per-process: export the named account's existing token for gh
# children, never `gh auth switch` the user's global login, and never echo the token.
# The model adapter is started with these variables stripped.
if [[ -n "$GH_USER" ]]; then
  gh_token="$(gh auth token --user "$GH_USER" 2>/dev/null)" \
    || fail "no gh credential for user '$GH_USER'; authenticate that account first"
  [[ -n "$gh_token" ]] || fail "gh returned an empty token for user '$GH_USER'"
  GH_TOKEN="$gh_token"
  export GH_TOKEN
  unset gh_token
fi

# --- state, locks, space ----------------------------------------------------------

mkdir -p "$ROOT" "$STATE"
chmod 700 "$STATE" 2>/dev/null || true
LOG="$STATE/run.log"
: >>"$LOG"
chmod 600 "$LOG" 2>/dev/null || true

# Model transcripts stay beside the run log in a private directory; the adapter is told
# about it explicitly so a different default store can never leak them elsewhere.
SESSION_DIR="$STATE/sessions"
mkdir -p "$SESSION_DIR"
chmod 700 "$SESSION_DIR" 2>/dev/null || true

# Install/rollback share $ROOT/.lock. Take it without blocking only for the local
# mutation phase and release it before the long CI wait so a timer install is not
# starved; the controller keeps its own lock for the whole run so two controllers never
# resolve the same conflict twice.
exec 8>"$ROOT/.lock"
flock -n 8 || defer "an omp-custom install or rollback holds $ROOT/.lock"
exec 9>"$ROOT/.ai-conflict-controller.lock"
flock -n 9 || defer "another ai-conflict controller is already running"

[[ -d "$TMPROOT" && -w "$TMPROOT" ]] \
  || fail "RAM work root $TMPROOT is missing or not writable (set OMP_AI_CONFLICTS_TMPDIR)"
avail="$(df --output=avail -B1 "$TMPROOT" | tail -n1)"
[[ "$avail" =~ ^[0-9]+$ ]] || fail "could not read free space on $TMPROOT"
(( avail >= MIN_FREE )) \
  || defer "disk guard: $avail bytes free on $TMPROOT, need >= $MIN_FREE for the RAM clone"

run_dir="$(mktemp -d "$TMPROOT/omp-ai-conflicts.XXXXXX")" || fail "could not create a RAM work dir in $TMPROOT"
work="$run_dir/repo"
req="$run_dir/request"
mkdir -p "$req"

log "starting: base=$BASE repo=$REPO upstream=$UPSTREAM_URL"

# --- fresh blobless clone in RAM --------------------------------------------------

# Blobless keeps the RAM footprint small. The upstream remote is marked as a second
# promisor so lazy blob fetches can find release objects that origin has never seen;
# once a release is merged both remotes can satisfy them.
GIT=(git -c core.hooksPath=/dev/null -c advice.detachedHead=false)
"${GIT[@]}" clone --quiet --filter=blob:none --no-checkout "$ORIGIN_URL" "$work" \
  || fail "could not clone $ORIGIN_URL into the RAM work dir"
"${GIT[@]}" -C "$work" remote add upstream "$UPSTREAM_URL"
"${GIT[@]}" -C "$work" config remote.upstream.promisor true
"${GIT[@]}" -C "$work" config remote.upstream.partialclonefilter blob:none
"${GIT[@]}" -C "$work" fetch --quiet --no-tags upstream '+refs/tags/v*:refs/tags/upstream/v*' \
  || fail "could not fetch upstream tags from $UPSTREAM_URL"
"${GIT[@]}" -C "$work" fetch --quiet --force origin \
  "+refs/heads/$BASE:refs/remotes/origin/$BASE" \
  || fail "could not fetch origin/$BASE"

tag="${1:-${UPSTREAM_TAG:-}}"
if [[ -z "$tag" ]]; then
  tag="$("${GIT[@]}" -C "$work" tag --list 'upstream/v*' --sort=-v:refname \
    | grep -E '^upstream/v[0-9]+\.[0-9]+\.[0-9]+$' | head -n1 || true)"
  tag="${tag#upstream/}"
fi
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "not a stable upstream tag: '$tag'"
tag_version="${tag#v}"
up_ref="refs/tags/upstream/$tag"
up_commit="$("${GIT[@]}" -C "$work" rev-parse --verify --quiet "$up_ref^{commit}")" \
  || fail "upstream tag $tag not found"
base_sha="$("${GIT[@]}" -C "$work" rev-parse "refs/remotes/origin/$BASE")"

export GIT_AUTHOR_NAME="omp-custom-sync"
export GIT_AUTHOR_EMAIL="41898282+github-actions[bot]@users.noreply.github.com"
export GIT_COMMITTER_NAME="$GIT_AUTHOR_NAME"
export GIT_COMMITTER_EMAIL="$GIT_AUTHOR_EMAIL"
export GIT_MERGE_AUTOEDIT=no
export EDITOR=true

merge_msg="chore(sync): merge upstream $tag"
br_name="sync/upstream-$tag"

# A pre-existing bot branch would be refresh-merged by sync-upstream.sh onto the current
# base, producing a tree this model never reviewed. The check runs before any model call
# and again immediately before the push (a run may create it while we resolve), and a
# failed query fails closed instead of reading as "absent".
assert_sync_branch_absent() {
  local remote_branches
  if ! remote_branches="$("${GIT[@]}" -C "$work" ls-remote --heads origin "$br_name")"; then
    fail "could not query origin for $br_name"
  fi
  [[ -z "$remote_branches" ]] \
    || fail "$br_name already exists on origin; refusing to overwrite an existing sync branch"
}

if "${GIT[@]}" -C "$work" merge-base --is-ancestor "$up_commit" "$base_sha"; then
  log "$tag is already merged into origin/$BASE; the existing custom-sync run owns the release path"
  record_result noop "upstream $tag already merged into $BASE"
  exit 0
fi

"${GIT[@]}" -C "$work" checkout --quiet -B probe "refs/remotes/origin/$BASE" \
  || fail "could not check out origin/$BASE in the RAM clone"

merge_rc=0
"${GIT[@]}" -C "$work" merge --no-commit --no-ff -m "$merge_msg" "$up_commit" >"$req/merge.log" 2>&1 \
  || merge_rc=$?
if [[ "$merge_rc" -eq 0 ]]; then
  "${GIT[@]}" -C "$work" merge --abort >/dev/null 2>&1 || true
  log "$tag merges cleanly into origin/$BASE; leaving it to the existing GitHub custom-sync run (no model call)"
  record_result noop "clean merge for $tag; no model call"
  exit 0
fi
if [[ "$merge_rc" -ne 1 ]]; then
  "${GIT[@]}" -C "$work" merge --abort >/dev/null 2>&1 || true
  fail "git merge failed with exit $merge_rc (not a conflict); see $req/merge.log"
fi

mapfile -d '' -t unmerged < <("${GIT[@]}" -C "$work" ls-files -u -z)
if (( ${#unmerged[@]} == 0 )); then
  "${GIT[@]}" -C "$work" merge --abort >/dev/null 2>&1 || true
  fail "git merge reported a conflict but the index has no unmerged entries"
fi

assert_sync_branch_absent

# --- collect and vet exactly the conflicted paths --------------------------------

declare -A stage_sha1=() stage_sha2=() stage_sha3=()
declare -A mode1=() mode2=() mode3=()
declare -A res_mode=()
declare -A known=()
paths=()

for rec in "${unmerged[@]}"; do
  meta="${rec%%$'\t'*}"
  p="${rec#*$'\t'}"
  read -r md sha stg <<<"$meta"
  case "$stg" in
    1) stage_sha1["$p"]="$sha"; mode1["$p"]="$md" ;;
    2) stage_sha2["$p"]="$sha"; mode2["$p"]="$md" ;;
    3) stage_sha3["$p"]="$sha"; mode3["$p"]="$md" ;;
    *) fail "unexpected unmerged stage '$stg' for $p" ;;
  esac
  if [[ -z "${known[$p]:-}" ]]; then
    known["$p"]=1
    paths+=("$p")
  fi
done

(( ${#paths[@]} <= 200 )) || fail "conflict touches ${#paths[@]} paths (limit 200); refusing"

# A model-authored path must never escape the repository or name a non-file.
safe_path() { # path
  local p="$1" seg
  [[ -n "$p" && ${#p} -le 1024 ]] || return 1
  [[ "$p" != /* && "$p" != *\\* && "$p" != *$'\n'* && "$p" != *$'\r'* ]] || return 1
  [[ "$p" != */ ]] || return 1
  while IFS= read -r seg; do
    [[ -n "$seg" && "$seg" != "." && "$seg" != ".." ]] || return 1
  done < <(printf '%s' "$p" | tr '/' '\n')
  return 0
}

total_text=0
objs=()
idx=0
for p in "${paths[@]}"; do
  safe_path "$p" || fail "unsafe conflicted path: '$p'"

  # Conflict class. Ordinary merge conflicts are exactly: both added (no base, both
  # current sides), modify/delete (base present, exactly one current side), and
  # modify/modify (all three). A path without either current side has nothing to
  # resolve, and a path present on only one side without a base is an add or rename
  # half whose other half lives at a different path: neither is model-resolvable here.
  has_base=0 has_ours=0 has_theirs=0
  [[ -n "${stage_sha1[$p]:-}" ]] && has_base=1
  [[ -n "${stage_sha2[$p]:-}" ]] && has_ours=1
  [[ -n "${stage_sha3[$p]:-}" ]] && has_theirs=1
  (( has_ours || has_theirs )) \
    || fail "conflict on '$p' is absent on both current sides; refusing"
  if (( !has_base && !(has_ours && has_theirs) )); then
    fail "conflict on '$p' is added on only one side without a merge base (rename/add ambiguity); refusing"
  fi

  for m in "${mode1[$p]:-}" "${mode2[$p]:-}" "${mode3[$p]:-}"; do
    [[ -z "$m" ]] && continue
    case "$m" in
      100644|100755) ;;
      120000) fail "conflict on '$p' is a symlink; not model-resolvable" ;;
      160000) fail "conflict on '$p' is a submodule; not model-resolvable" ;;
      *) fail "conflict on '$p' has unsupported mode $m" ;;
    esac
  done
  # No mode policy is invented: every stage that exists must agree on the mode, and the
  # single accepted mode is restored when the resolution writes content (an absent
  # "ours" is never checked out, so its mode can never be reused by mistake).
  resolved_mode=""
  for m in "${mode1[$p]:-}" "${mode2[$p]:-}" "${mode3[$p]:-}"; do
    [[ -z "$m" ]] && continue
    if [[ -z "$resolved_mode" ]]; then
      resolved_mode="$m"
    elif [[ "$resolved_mode" != "$m" ]]; then
      fail "conflict on '$p' changes file mode ($resolved_mode vs $m); refusing"
    fi
  done
  res_mode["$p"]="$resolved_mode"

  obj="$req/c.$idx.json"
  args=(--arg path "$p")
  for side in base ours theirs; do
    case "$side" in
      base) sha="${stage_sha1[$p]:-}" ;;
      ours) sha="${stage_sha2[$p]:-}" ;;
      theirs) sha="${stage_sha3[$p]:-}" ;;
    esac
    if [[ -z "$sha" ]]; then
      args+=(--argjson "$side" null)
      continue
    fi
    f="$req/c.$idx.$side"
    "${GIT[@]}" -C "$work" cat-file blob "$sha" >"$f" \
      || fail "could not read the $side blob for '$p'"
    # bash strings cannot carry NUL, so compare sizes after stripping NUL bytes.
    size="$(wc -c <"$f")"
    text_size="$(LC_ALL=C tr -d '\000' <"$f" | wc -c)"
    [[ "$text_size" == "$size" ]] || fail "conflict on '$p' is binary ($side); not model-resolvable"
    # jq --rawfile would silently replace invalid bytes with U+FFFD and the corrupted
    # text would reach the model and be committed, so reject non-UTF-8 text up front.
    iconv -f UTF-8 -t UTF-8 "$f" >/dev/null 2>&1 \
      || fail "conflict on '$p' is not valid UTF-8 ($side); not model-resolvable"
    total_text=$((total_text + size))
    args+=(--rawfile "$side" "$f")
  done
  jq -n "${args[@]}" '{path:$path, base:$base, ours:$ours, theirs:$theirs}' >"$obj" \
    || fail "could not encode the conflicted text for '$p' (invalid encoding?)"
  objs+=("$obj")
  idx=$((idx + 1))
done

(( total_text <= MAX_TEXT )) \
  || fail "conflicted text is $total_text bytes (limit $MAX_TEXT); refusing to send it to the model"

jq -s '.' "${objs[@]}" >"$req/conflicts.json" || fail "could not assemble the conflict payload"
conflict_paths_json="$(jq -c '[.[].path]' "$req/conflicts.json")"

jobKey="sync-${tag}-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
[[ "$jobKey" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$ ]] || fail "internal jobKey is invalid: $jobKey"

log "conflict in ${#paths[@]} path(s) for $tag; dispatching the resolver (jobKey: $jobKey)"

# --- adapter calls ----------------------------------------------------------------

run_adapter() { # request-file response-file stderr-file
  local in="$1" out="$2" err="$3"
  # GH credentials are for gh subprocesses only; the model boundary never sees them.
  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=TERM --kill-after=30 "$HARD_TIMEOUT" \
      env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN \
      "$BUN" "$ADAPTER" <"$in" >"$out" 2>"$err"
  else
    env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN \
      "$BUN" "$ADAPTER" <"$in" >"$out" 2>"$err"
  fi
}

adapter_error_detail() { # response-file exit-code
  local out="$1" rc="$2" code msg
  code="$(jq -r '.error.code // ""' "$out" 2>/dev/null || true)"
  msg="$(jq -r '.error.message // ""' "$out" 2>/dev/null || true)"
  if [[ -n "$code" ]]; then
    printf '%s (%s)' "$code" "$msg"
  else
    printf 'exit %s' "$rc"
  fi
}

require_single_object() { # response-file label
  local out="$1" label="$2" count
  count="$(jq -s 'length' "$out" 2>/dev/null)" || fail "$label response is not JSON"
  [[ "$count" == "1" ]] || fail "$label response must be exactly one JSON object (got $count documents)"
  jq -e 'type == "object"' "$out" >/dev/null 2>&1 || fail "$label response is not a JSON object"
}

jq -n --arg job "$jobKey" --argjson timeout "$MODEL_TIMEOUT_MS" --arg sdir "$SESSION_DIR" \
  --slurpfile conflicts "$req/conflicts.json" \
  '{mode:"resolve", jobKey:$job, conflicts:$conflicts[0], timeoutMs:$timeout, sessionDir:$sdir}' \
  >"$req/resolve.req.json" || fail "could not build the resolve request"

resolve_out="$req/resolve.out.json"
rc=0
run_adapter "$req/resolve.req.json" "$resolve_out" "$req/resolve.err" || rc=$?
if [[ "$rc" -ne 0 ]]; then
  fail "resolver adapter failed: $(adapter_error_detail "$resolve_out" "$rc")"
fi
require_single_object "$resolve_out" "resolve"

jq -e --arg job "$jobKey" --arg provider "$MODEL_PROVIDER" --arg model "$MODEL_ID" \
  --argjson paths "$conflict_paths_json" '
  .ok == true
  and .mode == "resolve"
  and .jobKey == $job
  and .model.provider == $provider and .model.id == $model
  and (.files | type == "array")
  and ([.files[].path] | sort) == ($paths | sort)
  and ([.files[].path] | unique | length) == ($paths | length)
  and all(.files[];
        (type == "object")
        and (
          (((keys | sort) == ["content", "path"])
           and (.content | type == "string")
           and ((.content | index("\u0000")) == null))
          or
          (((keys | sort) == ["delete", "path"])
           and (.delete == true))
        ))
  and .proof.provider == $provider and .proof.model == $model
  and .proof.toolCalls == 0 and .proof.toolsExposed == 0
  and (.proof.sessionName | type == "string")
  and (.proof.sessionName | startswith("OMP \u2014 Upstream Conflict Resolver \u2014 "))
  and (.session.name | type == "string")
' "$resolve_out" >/dev/null 2>&1 \
  || fail "resolver result is missing, off-allowlist, malformed, or not the pinned model; refusing"

# Each allowlisted path resolves to exactly one decision: replacement content or a
# deletion. The independent review sees that exact proposal, deletions included.
declare -A deleted=()
for p in "${paths[@]}"; do
  decision="$(jq -r --arg p "$p" \
    '.files[] | select(.path == $p) | if .delete == true then "delete" else "content" end' \
    "$resolve_out")" || fail "could not read the resolution decision for '$p'"
  case "$decision" in
    delete) deleted["$p"]=1 ;;
    content) ;;
    *) fail "resolution for '$p' is neither content nor a deletion; refusing" ;;
  esac
done

# Apply nothing yet: the proposed resolution must survive an independent review first.
res_total=0
idx=0
: >"$req/review.files.jsonl"
for p in "${paths[@]}"; do
  if [[ -n "${deleted[$p]:-}" ]]; then
    jq -n --arg path "$p" '{path:$path, delete:true}' >>"$req/review.files.jsonl"
    idx=$((idx + 1))
    continue
  fi
  f="$req/r.$idx"
  jq -j --arg p "$p" '.files[] | select(.path == $p) | .content' "$resolve_out" >"$f" \
    || fail "could not extract the proposed content for '$p'"
  size="$(wc -c <"$f")"
  res_total=$((res_total + size))
  jq -n --arg path "$p" --rawfile content "$f" '{path:$path, content:$content}' >>"$req/review.files.jsonl"
  idx=$((idx + 1))
done
(( res_total <= MAX_RESOLUTION )) \
  || fail "proposed resolution is $res_total bytes (limit $MAX_RESOLUTION); refusing to review it"
(( total_text + res_total <= 16000000 )) \
  || fail "conflicted text plus proposed resolution exceeds the adapter input budget"
res_objs=()
while IFS= read -r line; do res_objs+=("$line"); done <"$req/review.files.jsonl"
printf '%s\n' "${res_objs[@]}" | jq -s '.' >"$req/review.files.json" \
  || fail "could not assemble the proposed resolution"

jq -n --arg job "$jobKey" --argjson timeout "$MODEL_TIMEOUT_MS" --arg sdir "$SESSION_DIR" \
  --slurpfile conflicts "$req/conflicts.json" --slurpfile files "$req/review.files.json" \
  '{mode:"review", jobKey:$job, conflicts:$conflicts[0], files:$files[0], timeoutMs:$timeout, sessionDir:$sdir}' \
  >"$req/review.req.json" || fail "could not build the review request"

review_out="$req/review.out.json"
rc=0
run_adapter "$req/review.req.json" "$review_out" "$req/review.err" || rc=$?
if [[ "$rc" -ne 0 ]]; then
  fail "review adapter failed: $(adapter_error_detail "$review_out" "$rc")"
fi
require_single_object "$review_out" "review"

jq -e --arg job "$jobKey" --arg provider "$MODEL_PROVIDER" --arg model "$MODEL_ID" \
  --argjson paths "$conflict_paths_json" '
  .ok == true
  and .mode == "review"
  and .jobKey == $job
  and .model.provider == $provider and .model.id == $model
  and (.verdict == "accepted" or .verdict == "rejected")
  and (.findings | type == "array")
  and all(.findings[];
        (.path | type == "string")
        and (.path as $p | ($paths | index($p)) != null)
        and (.severity == "error" or .severity == "warning" or .severity == "info")
        and (.message | type == "string" and length > 0 and length <= 4000))
  and (if .verdict == "rejected" then (.findings | length) > 0 else true end)
  and (if .verdict == "accepted" then ([.findings[] | select(.severity == "error")] | length) == 0 else true end)
  and .proof.provider == $provider and .proof.model == $model
  and .proof.toolCalls == 0 and .proof.toolsExposed == 0
  and (.proof.sessionName | type == "string")
  and (.proof.sessionName | startswith("OMP \u2014 Upstream Conflict Review \u2014 "))
  and (.session.name | type == "string")
' "$review_out" >/dev/null 2>&1 \
  || fail "review result is malformed, off-allowlist, or not the pinned model; refusing"

verdict="$(jq -r '.verdict' "$review_out")"
if [[ "$verdict" != "accepted" ]]; then
  findings="$(jq -r '.findings[] | "\(.severity) \(.path): \(.message)"' "$review_out" | tr '\n' ';')"
  fail "review rejected the resolution: $findings"
fi
[[ "$(jq '[.findings[] | select(.severity == "error")] | length' "$review_out")" == "0" ]] \
  || fail "review accepted the resolution while reporting an error finding"
log "review accepted the resolution for ${#paths[@]} path(s) (${#deleted[@]} deletion(s))"

# --- apply exactly the allowlisted results ---------------------------------------

# A resolved path is written or removed inside this checkout only: no component of the
# relative path may be a symlink, so a model-influenced tree cannot redirect the write
# or the removal outside the candidate worktree.
assert_inside_worktree() { # path
  local p="$1" cur="$work" seg
  while IFS= read -r seg; do
    [[ -n "$seg" ]] || continue
    cur="$cur/$seg"
    [[ -L "$cur" ]] && return 1
  done < <(printf '%s' "$p" | tr '/' '\n')
  return 0
}

# Only the allowlisted paths may change in the index; every other entry must be
# byte-identical after the apply phase (a bare `git add` with no path would break this).
declare -A allowlisted=()
for p in "${paths[@]}"; do allowlisted["$p"]=1; done
index_snapshot() { # output-file
  local rec p
  : >"$1"
  while IFS= read -r -d '' rec; do
    p="${rec#*$'\t'}"
    [[ -n "${allowlisted[$p]:-}" ]] && continue
    printf '%s\n' "$rec" >>"$1"
  done < <("${GIT[@]}" -C "$work" ls-files -s -z)
}
index_snapshot "$req/index.before"

for p in "${paths[@]}"; do
  target="$work/$p"
  [[ -n "${res_mode[$p]:-}" ]] || fail "no accepted mode for '$p'"
  assert_inside_worktree "$p" \
    || fail "resolved path '$p' traverses a symlink inside the worktree; refusing"

  if [[ -n "${deleted[$p]:-}" ]]; then
    # Index-aware removal of exactly this allowlisted path, then the worktree file.
    "${GIT[@]}" -C "$work" update-index --force-remove -- "$p" \
      || fail "could not drop '$p' from the index"
    rm -f -- "$target" || fail "could not remove the worktree file for '$p'"
    [[ ! -e "$target" && ! -L "$target" ]] || fail "'$p' still exists after the deletion"
    [[ -z "$("${GIT[@]}" -C "$work" ls-files -s -- "$p")" ]] \
      || fail "'$p' is still staged after the deletion"
    continue
  fi

  # A modify/delete can be nested inside a directory the deleted side removed; the
  # containment check above guarantees every existing component is a real directory,
  # so recreating the missing ones stays inside the worktree.
  parent="$(dirname -- "$target")"
  [[ -d "$parent" ]] || mkdir -p -- "$parent" \
    || fail "could not recreate the parent directory of '$p'"

  jq -j --arg p "$p" '.files[] | select(.path == $p) | .content' "$resolve_out" >"$target" \
    || fail "could not write the resolution for '$p'"
  case "${res_mode[$p]}" in
    100755) chmod 755 "$target" || fail "could not restore the mode of '$p'" ;;
    100644) chmod 644 "$target" || fail "could not restore the mode of '$p'" ;;
    *) fail "unexpected accepted mode ${res_mode[$p]} for '$p'" ;;
  esac
  "${GIT[@]}" -C "$work" add -- "$p" || fail "could not stage '$p'"
  staged_mode="$("${GIT[@]}" -C "$work" ls-files -s -- "$p" | awk '{print $1}')"
  [[ "$staged_mode" == "${res_mode[$p]}" ]] \
    || fail "staged mode $staged_mode for '$p' does not match the accepted mode ${res_mode[$p]}"
done

index_snapshot "$req/index.after"
cmp -s "$req/index.before" "$req/index.after" \
  || fail "the apply phase changed index entries outside the reviewed allowlist; refusing"

[[ -z "$("${GIT[@]}" -C "$work" ls-files -u)" ]] \
  || fail "unmerged entries remain after applying the resolution"

kept=()
for p in "${paths[@]}"; do
  [[ -n "${deleted[$p]:-}" ]] || kept+=("$p")
done

if (( ${#kept[@]} > 0 )); then
  marker_rc=0
  "${GIT[@]}" -C "$work" grep --cached -I -n -E '^(<{7}( |$)|>{7}( |$)|\|{7}( |$))' -- "${kept[@]}" \
    >"$req/markers" 2>&1 || marker_rc=$?
  if [[ "$marker_rc" -eq 0 ]]; then
    fail "conflict markers remain in the resolved files: $(tr '\n' ' ' <"$req/markers")"
  fi
  [[ "$marker_rc" -eq 1 ]] || fail "could not check for conflict markers: $(tr '\n' ' ' <"$req/markers")"
fi
[[ -z "$("${GIT[@]}" -C "$work" diff --name-only -z)" ]] \
  || fail "the resolution left unstaged worktree changes; refusing"
[[ -z "$("${GIT[@]}" -C "$work" ls-files --others --exclude-standard -z)" ]] \
  || fail "the resolution left untracked files; refusing"

# Deterministic checks proportional to the change; nothing here installs dependencies.
"${GIT[@]}" -C "$work" diff --cached --check >"$req/diffcheck" 2>&1 \
  || fail "git diff --check failed on the resolution: $(tr '\n' ' ' <"$req/diffcheck")"

for p in "${kept[@]}"; do
  [[ -f "$work/$p" ]] || continue
  case "$p" in
    *.sh)
      bash -n "$work/$p" || fail "bash syntax check failed for $p" ;;
    *.json)
      jq -e . "$work/$p" >/dev/null 2>&1 || fail "JSON syntax check failed for $p" ;;
    *.py)
      if command -v python3 >/dev/null 2>&1; then
        python3 -c 'import sys; compile(open(sys.argv[1], encoding="utf-8").read(), sys.argv[1], "exec")' "$work/$p" \
          || fail "Python syntax check failed for $p"
      fi ;;
  esac
done

# --- commit the merge and prove the candidate ------------------------------------

# The reviewed tree is the staged index before the commit; the commit must carry exactly that
# tree. The trailers are controller metadata (never model output) that sync-upstream.sh uses
# to bind a later scheduled run to this exact review.
reviewed_tree="$("${GIT[@]}" -C "$work" write-tree)" || fail "could not write the reviewed tree"
merge_msg_file="$req/merge-message"
{
  printf '%s\n\n' "$merge_msg"
  printf 'OMP-AI-Conflict-Review: v1\n'
  printf 'OMP-AI-Reviewed-Base: %s\n' "$base_sha"
  printf 'OMP-AI-Reviewed-Tree: %s\n' "$reviewed_tree"
  printf 'OMP-AI-Model: %s/%s\n' "$MODEL_PROVIDER" "$MODEL_ID"
} >"$merge_msg_file"
"${GIT[@]}" -C "$work" commit --quiet --no-verify -F "$merge_msg_file" \
  || fail "could not commit the resolved merge"
[[ "$("${GIT[@]}" -C "$work" rev-parse 'HEAD^{tree}')" == "$reviewed_tree" ]] \
  || fail "committed tree differs from the reviewed tree $reviewed_tree"
candidate="$("${GIT[@]}" -C "$work" rev-parse HEAD)"
tree="$("${GIT[@]}" -C "$work" rev-parse "HEAD^{tree}")"
[[ "$("${GIT[@]}" -C "$work" rev-parse HEAD^1)" == "$base_sha" ]] \
  || fail "candidate parent 1 is not origin/$BASE at $base_sha"
[[ "$("${GIT[@]}" -C "$work" rev-parse HEAD^2)" == "$up_commit" ]] \
  || fail "candidate parent 2 is not upstream $tag at $up_commit"

candidate_version="$("${GIT[@]}" -C "$work" show "HEAD:packages/coding-agent/package.json" 2>/dev/null | jq -r '.version // empty' || true)"
[[ "$candidate_version" == "$tag_version" ]] \
  || fail "candidate package version is '$candidate_version', expected $tag_version for $tag"

# origin/$BASE must be untouched immediately before the push; a moved base makes the
# reviewed tree describe a merge nobody asked for.
"${GIT[@]}" -C "$work" fetch --quiet --force origin "+refs/heads/$BASE:refs/remotes/origin/$BASE" \
  || fail "could not re-fetch origin/$BASE before the push"
now_base="$("${GIT[@]}" -C "$work" rev-parse "refs/remotes/origin/$BASE")"
[[ "$now_base" == "$base_sha" ]] \
  || fail "origin/$BASE moved to $now_base after review (reviewed base $base_sha is stale); retry next cycle"

assert_sync_branch_absent

# Git does not read GH_TOKEN, so the owner-scoped token reaches this one network write through
# a transient gh credential helper. No global gh/git config changes, and no token in argv or logs.
"${GIT[@]}" -C "$work" -c credential.helper= -c 'credential.helper=!gh auth git-credential' \
  push --quiet origin "HEAD:refs/heads/$br_name" \
  || fail "could not push $br_name without force"

pushed="$("${GIT[@]}" -C "$work" ls-remote origin "refs/heads/$br_name" | awk '{print $1}')"
[[ "$pushed" == "$candidate" ]] \
  || fail "remote $br_name is at ${pushed:-nothing}, not the reviewed candidate $candidate"

# The local mutation phase is done; release the install/rollback lock before the long
# CI wait so the daily installer can proceed.
exec 8>&-

log "pushed $br_name at $candidate (tree $tree); dispatching $SYNC_WF with the reviewed guards"

# --- dispatch the existing pipeline and wait for it ------------------------------

fetch_runs() { # workflow-file
  gh api "repos/$REPO/actions/workflows/$1/runs?per_page=100"
}

max_run_id() { # workflow-file
  local wf="$1" data
  data="$(fetch_runs "$wf")" || fail "could not list $wf runs"
  jq -r '[.workflow_runs[].id] | max // 0' <<<"$data"
}

find_run_id() { # workflow-file ref before-id
  local wf="$1" ref="$2" before="$3" data
  data="$(fetch_runs "$wf")" || fail "could not list $wf runs"
  jq -r --arg wf "$wf" --arg ref "$ref" --argjson before "$before" '
    [ .workflow_runs[]?
      | select(.id > $before)
      | select(.event == "workflow_dispatch")
      | select(.head_branch == $ref)
      | select(.path == (".github/workflows/" + $wf))
    ] | sort_by(.id) | last | .id // empty' <<<"$data"
}

before="$(max_run_id "$SYNC_WF")"
gh workflow run "$SYNC_WF" --repo "$REPO" --ref "$BASE" \
  -f "upstream_tag=$tag" \
  -f "expected_base_sha=$base_sha" \
  -f "expected_tree_sha=$tree" \
  || fail "could not dispatch $SYNC_WF on $BASE in $REPO"

deadline=$(( $(date +%s) + TIMEOUT ))
run_id=""
while :; do
  run_id="$(find_run_id "$SYNC_WF" "$BASE" "$before")"
  if [[ -n "$run_id" ]]; then
    data="$(gh api "repos/$REPO/actions/runs/$run_id")" || fail "could not read $SYNC_WF run $run_id"
    r_path="$(jq -r '.path // ""' <<<"$data")"
    r_branch="$(jq -r '.head_branch // ""' <<<"$data")"
    r_sha="$(jq -r '.head_sha // ""' <<<"$data")"
    r_status="$(jq -r '.status // ""' <<<"$data")"
    r_conclusion="$(jq -r '.conclusion // ""' <<<"$data")"
    [[ "$r_path" == ".github/workflows/$SYNC_WF" ]] || fail "run $run_id is not $SYNC_WF (path: $r_path)"
    [[ "$r_branch" == "$BASE" ]] || fail "run $run_id is for '$r_branch', not '$BASE'"
    [[ "$r_sha" == "$base_sha" ]] \
      || fail "run $run_id was dispatched at $r_sha, not the reviewed base $base_sha; refusing to trust it"
    if [[ "$r_status" == "completed" ]]; then
      [[ "$r_conclusion" == "success" ]] || fail "$SYNC_WF run $run_id concluded '$r_conclusion'"
      log "done: $SYNC_WF run $run_id succeeded for $tag -> $candidate (tree $tree)"
      record_result success "$SYNC_WF run $run_id succeeded; candidate $candidate on $br_name"
      exit 0
    fi
  fi
  if (( $(date +%s) >= deadline )); then
    fail "$SYNC_WF did not reach a successful conclusion within ${TIMEOUT}s (run: ${run_id:-not found})"
  fi
  sleep "$POLL"
done
