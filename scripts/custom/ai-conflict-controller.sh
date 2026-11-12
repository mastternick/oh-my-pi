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
#      it for an independent review of exactly that proposal. A path whose assembled file
#      reproduces one side verbatim is retried exactly once, alone and in its own session,
#      with the rejected region named in the request; a second copy stops the run. A review
#      that rejects paths with error findings earns one fresh resolve retry per path, fed
#      with those findings and the answers they rejected, then exactly those changed paths are
#      reviewed again; a second rejection stops the run with the findings. A batch that
#      rejects without naming an error finding cannot be retried and stops the run too.
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
#   OMP_AI_CONFLICTS_MODEL_TIMEOUT_MS  per-turn model timeout (default 1800000). One region
#                                 plan is a few thousand output tokens, so the timeout is a
#                                 backstop, not a size-dependent budget.
#   OMP_AI_CONFLICTS_HARD_TIMEOUT      wall timeout for one adapter call, seconds (default 2100;
#                                 one turn plus start-up and session writes)
#   OMP_AI_CONFLICTS_MAX_TEXT_BYTES    cap on merged conflicted text, bytes (default 7340032).
#                                 Only the merged marker file reaches the model, region by
#                                 region, so this bounds what the resolver reads.
#   OMP_AI_CONFLICTS_MAX_RESOLUTION_BYTES  cap on proposed resolution, bytes (default 7340032)
#   OMP_AI_CONFLICTS_INPUT_TOKEN_BUDGET    request budget per model call, tokens (default 660000;
#                                 the regions and merged context of the whole 27-path plan
#                                 estimate to ~55k, so this only stops a pathological input)
#   OMP_AI_CONFLICTS_OUTPUT_TOKEN_BUDGET   answer budget per model call, tokens (default 90000 =
#                                 the 120000-token call cap minus the 30000-token reasoning
#                                 headroom measured on this route; every call is additionally
#                                 capped at MODEL_OUTPUT_TOKENS = 120000, which the adapter
#                                 enforces as the session model's output limit)
#   OMP_AI_CONFLICTS_COMBINED_TOKEN_BUDGET input plus output ceiling for one call, tokens
#                                 (default 900000; the request budget plus the 120000-token cap
#                                 must stay under the 1048576-token context window)
#                                 All of them convert bytes with the adapter's own chars/token
#                                 divisor (ESTIMATE_CHARS_PER_TOKEN = 3.2 in
#                                 ai-conflict-model.ts); a path that cannot fit alone stops
#                                 the run with an explicit message instead of being dropped.
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
MODEL_TIMEOUT_MS="${OMP_AI_CONFLICTS_MODEL_TIMEOUT_MS:-1800000}"
HARD_TIMEOUT="${OMP_AI_CONFLICTS_HARD_TIMEOUT:-2100}"
MAX_TEXT="${OMP_AI_CONFLICTS_MAX_TEXT_BYTES:-7340032}"
MAX_RESOLUTION="${OMP_AI_CONFLICTS_MAX_RESOLUTION_BYTES:-7340032}"
# The pinned model's per-call output ceiling (MAX_CALL_OUTPUT_TOKENS in ai-conflict-model.ts),
# its measured reasoning headroom, and the route's context window. Every budget below is
# derived from these three, so the adapter's preflight and the batching agree.
MODEL_OUTPUT_TOKENS=120000
REASONING_HEADROOM_TOKENS=30000
CONTEXT_WINDOW_TOKENS=1048576
INPUT_TOKEN_BUDGET="${OMP_AI_CONFLICTS_INPUT_TOKEN_BUDGET:-660000}"
OUTPUT_TOKEN_BUDGET="${OMP_AI_CONFLICTS_OUTPUT_TOKEN_BUDGET:-$(( MODEL_OUTPUT_TOKENS - REASONING_HEADROOM_TOKENS ))}"
COMBINED_TOKEN_BUDGET="${OMP_AI_CONFLICTS_COMBINED_TOKEN_BUDGET:-900000}"
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
[[ "$INPUT_TOKEN_BUDGET" =~ ^[1-9][0-9]*$ ]] \
  || fail "OMP_AI_CONFLICTS_INPUT_TOKEN_BUDGET must be a positive integer (got '$INPUT_TOKEN_BUDGET')"
[[ "$OUTPUT_TOKEN_BUDGET" =~ ^[1-9][0-9]*$ ]] \
  || fail "OMP_AI_CONFLICTS_OUTPUT_TOKEN_BUDGET must be a positive integer (got '$OUTPUT_TOKEN_BUDGET')"
[[ "$COMBINED_TOKEN_BUDGET" =~ ^[1-9][0-9]*$ ]] \
  || fail "OMP_AI_CONFLICTS_COMBINED_TOKEN_BUDGET must be a positive integer (got '$COMBINED_TOKEN_BUDGET')"

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
# diff3 makes git write the merge base into every conflict block, so the resolver sees the
# common ancestor of each region instead of guessing it from the two sides.
"${GIT[@]}" -C "$work" -c merge.conflictStyle=diff3 merge --no-commit --no-ff -m "$merge_msg" "$up_commit" \
  >"$req/merge.log" 2>&1 \
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

# The bytes one path contributes to a request and to an answer, read straight off the merged
# marker file: a request carries every conflict block plus up to 30 merged context lines on
# either side (the adapter's REGION_CONTEXT_LINES), an answer carries the ours, base and
# theirs slices of every block. A block git left unterminated fails here, before any model
# call, instead of reaching the adapter's parser.
#
# The same ordered state machine decides the blocks as `parseMarkerBlocks` in
# ai-conflict-model.ts: a nested "<<" marker or a second "|||||||" before the separator is a
# malformed block, and ">>>>>>>" only terminates after "=======", so a content line that
# starts with a marker token stays text. Emits "in<TAB>out<TAB>blocks<TAB>outside-marker-lines":
# the last two let the controller prove the adapter parsed the same blocks and keep the
# post-assembly marker scan scoped to markers that were never legitimate.
region_bytes() { # merged-file
  # mawk 1.3.4 panics on interval expressions in this position ("REcompile() - panic"), so
  # the markers are compared as literal seven-character prefixes instead of ^<{7}( |$).
  LC_ALL=C awk -v ctx=30 '
    function ismark(s, m) {
      return substr(s, 1, 7) == m && (length(s) == 7 || substr(s, 8, 1) == " ")
    }
    function marklike(s) {
      return ismark(s, "<<<<<<<") || ismark(s, "|||||||") || ismark(s, ">>>>>>>") || s == "======="
    }
    { txt[NR] = $0; sub(/\r$/, "", txt[NR]); len[NR] = length($0) + 1; tot += len[NR] }
    END {
      n = NR; i = 1
      while (i <= n) {
        if (!ismark(txt[i], "<<<<<<<")) { i++; continue }
        b = 0; sep = 0; term = 0
        for (j = i + 1; j <= n; j++) {
          if (ismark(txt[j], "<<<<<<<")) exit 1
          if (sep == 0 && ismark(txt[j], "|||||||")) {
            if (b > 0) exit 1
            b = j; continue
          }
          if (sep == 0 && txt[j] == "=======") { sep = j; continue }
          if (sep > 0 && ismark(txt[j], ">>>>>>>")) { term = j; break }
        }
        if (sep == 0 || term == 0) exit 1
        for (k = i; k <= term; k++) inside[k] = 1
        first = (b > 0 ? b : sep)
        for (k = i + 1; k < first; k++) outb += len[k]
        if (b > 0) for (k = b + 1; k < sep; k++) outb += len[k]
        for (k = sep + 1; k < term; k++) outb += len[k]
        for (k = i; k <= term; k++) inb += len[k]
        k = i - 1; c = 0
        while (k >= 1 && c < ctx && !ismark(txt[k], ">>>>>>>")) { inb += len[k]; c++; k-- }
        k = term + 1; c = 0
        while (k <= n && c < ctx && !ismark(txt[k], "<<<<<<<")) { inb += len[k]; c++; k++ }
        nb++
        i = term + 1
      }
      outside = 0
      for (k = 1; k <= n; k++) if (!inside[k] && marklike(txt[k])) outside++
      # A block-free conflict (modify/delete) is one whole-file region: the merged file is
      # both what the request carries and what the answer replaces. Its marker-like lines
      # are still counted, so the assembled file can be held to the same budget.
      if (nb == 0) { inb = tot; outb = tot }
      printf "%d\t%d\t%d\t%d\n", inb, outb, nb, outside
    }
  ' "$1"
}

total_text=0
idx=0
declare -A side_cur_min=() obj_for=() side_ours=() side_theirs=() expected_regions=() merged_markers=()
declare -A est_in=() est_out=()
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
  path_min=0
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
    # A real merge cannot be shorter than its smaller current side; the base is ignored.
    if [[ "$side" != base ]] && { (( path_min == 0 )) || (( size < path_min )); }; then
      path_min=$size
    fi
    args+=(--rawfile "$side" "$f")
  done
  # git wrote the merged file with conflict markers; that file, not the three blobs, is what
  # the adapter parses into regions.
  merged_file="$work/$p"
  [[ -f "$merged_file" && ! -L "$merged_file" ]] \
    || fail "git left no merged file at '$p' for this conflict; refusing to plan regions without one"
  msize="$(wc -c <"$merged_file")"
  mtext="$(LC_ALL=C tr -d '\000' <"$merged_file" | wc -c)"
  [[ "$mtext" == "$msize" ]] || fail "conflict on '$p' is binary (merged file); not model-resolvable"
  iconv -f UTF-8 -t UTF-8 "$merged_file" >/dev/null 2>&1 \
    || fail "conflict on '$p' is not valid UTF-8 (merged file); not model-resolvable"
  total_text=$((total_text + msize))
  region_sizes="$(region_bytes "$merged_file")" \
    || fail "could not parse the conflict regions of '$p' (unterminated marker block); refusing"
  IFS=$'\t' read -r region_in region_out region_blocks region_outside <<<"$region_sizes"
  est_in["$p"]="$region_in"
  est_out["$p"]="$region_out"
  # The adapter must parse the merged file into exactly these blocks (a marker-free
  # modify/delete conflict is its one whole-file region), and the assembled file may carry
  # marker-like lines only where the merged file already had them outside a block.
  expected_regions["$p"]="$(( region_blocks > 0 ? region_blocks : 1 ))"
  merged_markers["$p"]="$region_outside"
  args+=(--rawfile merged "$merged_file")

  jq -n "${args[@]}" '{path:$path, base:$base, ours:$ours, theirs:$theirs, merged:$merged}' >"$obj" \
    || fail "could not encode the conflicted text for '$p' (invalid encoding?)"
  obj_for["$p"]="$obj"
  [[ -n "${stage_sha2[$p]:-}" ]] && side_ours["$p"]="$req/c.$idx.ours"
  [[ -n "${stage_sha3[$p]:-}" ]] && side_theirs["$p"]="$req/c.$idx.theirs"
  side_cur_min["$p"]="$path_min"
  idx=$((idx + 1))
done

(( total_text <= MAX_TEXT )) \
  || fail "conflicted text is $total_text bytes (limit $MAX_TEXT); refusing to send it to the model"

conflict_paths_json="$(jq -c -n --args '$ARGS.positional' "${paths[@]}")"

jobKey="sync-${tag}-$(date -u +%Y%m%dT%H%M%SZ)-$$-$RANDOM"
[[ "$jobKey" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$ ]] || fail "internal jobKey is invalid: $jobKey"

# --- batching ---------------------------------------------------------------------
# A single turn carries the conflict regions, not the files: per path the request holds
# every block plus its merged context, and the answer holds the block slices. Group the
# paths greedily, in path order, so each call carries at most the batch input budget of
# regions and asks for at most the batch output budget of replacements. The review turn
# reuses the partition because it carries the same regions plus the proposal.
CHARS_PER_TOKEN_X10=32 # ESTIMATE_CHARS_PER_TOKEN (3.2) in ai-conflict-model.ts, scaled for integer math

# One answer is a region plan, not a file set. The call cap (120000 tokens) counts the
# model's reasoning too, so the answer budget is capped at the cap minus the measured
# 30000-token reasoning headroom; a plan that overruns both fails with OUTPUT_TRUNCATED
# instead of being silently truncated. The adapter writes the same cap into the session
# model's output limit, so this is the bound the request really carries (a route advertising
# less lowers it).
BATCH_OUT_LIMIT=$(( MODEL_OUTPUT_TOKENS - REASONING_HEADROOM_TOKENS ))
BATCH_OUT=$(( OUTPUT_TOKEN_BUDGET < BATCH_OUT_LIMIT ? OUTPUT_TOKEN_BUDGET : BATCH_OUT_LIMIT ))
BATCH_IN=$(( COMBINED_TOKEN_BUDGET - BATCH_OUT ))
(( BATCH_IN > 0 )) \
  || fail "OMP_AI_CONFLICTS_COMBINED_TOKEN_BUDGET ($COMBINED_TOKEN_BUDGET) leaves no input room beside the $BATCH_OUT-token answer budget"
(( INPUT_TOKEN_BUDGET < BATCH_IN )) && BATCH_IN=$INPUT_TOKEN_BUDGET
(( BATCH_IN + MODEL_OUTPUT_TOKENS <= CONTEXT_WINDOW_TOKENS )) \
  || fail "OMP_AI_CONFLICTS_INPUT_TOKEN_BUDGET ($BATCH_IN) plus the $MODEL_OUTPUT_TOKENS-token call cap exceeds the $CONTEXT_WINDOW_TOKENS-token context window"
log "one answer is capped at $MODEL_OUTPUT_TOKENS tokens (the session model's output limit, reasoning included); batching regions to ~$BATCH_IN input and ~$BATCH_OUT output tokens per call"

tokens_of() { # bytes -> overestimated tokens
  printf '%s' $(( ($1 * 10 + CHARS_PER_TOKEN_X10 - 1) / CHARS_PER_TOKEN_X10 ))
}

declare -a batch_paths=() batch_in=() batch_out=()
nb=0
cur_in=0
cur_out=0
for p in "${paths[@]}"; do
  p_in="$(tokens_of "${est_in[$p]}")"
  p_out="$(tokens_of "${est_out[$p]}")"
  if (( p_in > BATCH_IN || p_out > BATCH_OUT || p_in + p_out > BATCH_IN + BATCH_OUT )); then
    fail "conflicted path '$p' alone needs ~$p_in input tokens and ~$p_out output tokens, over the batch budget (input $BATCH_IN, output $BATCH_OUT, combined $COMBINED_TOKEN_BUDGET); refusing to truncate or drop it"
  fi
  if (( nb == 0 )) || (( cur_in + p_in > BATCH_IN )) || (( cur_out + p_out > BATCH_OUT )) \
    || (( cur_in + cur_out + p_in + p_out > BATCH_IN + BATCH_OUT )); then
    nb=$((nb + 1))
    batch_paths[nb]="$p"
    cur_in=$p_in
    cur_out=$p_out
  else
    batch_paths[nb]+=$'\n'"$p"
    cur_in=$((cur_in + p_in))
    cur_out=$((cur_out + p_out))
  fi
  batch_in[nb]=$cur_in
  batch_out[nb]=$cur_out
done

log "conflict in ${#paths[@]} path(s) for $tag; dispatching the resolver in $nb batch(es) (jobKey: $jobKey)"
for ((b = 1; b <= nb; b++)); do
  log "batch $b/$nb: $(printf '%s\n' "${batch_paths[$b]}" | wc -l) path(s), ~$(( (batch_in[b] + 500) / 1000 ))k input tokens, ~$(( (batch_out[b] + 500) / 1000 ))k output tokens"
done

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

check_resolve_result() { # response-file jobKey paths-json label
  local out="$1" job="$2" paths_json="$3" label="$4"
  jq -e --arg job "$job" --arg provider "$MODEL_PROVIDER" --arg model "$MODEL_ID" \
    --argjson paths "$paths_json" '
  .ok == true
  and .mode == "resolve"
  and .jobKey == $job
  and .model.provider == $provider and .model.id == $model
  and (.files | type == "array")
  and (.resolutions | type == "array")
  and all(.resolutions[];
        (type == "object")
        and ((keys | sort) == ["content", "path", "region"])
        and (.content | type == "string")
        and ((.content | index("\u0000")) == null)
        and (.path as $p | ($paths | index($p)) != null))
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
  # The region plan is what ties every answer to a parsed block. Without it the coverage
  # loop would check nothing and unverified whole-file content could be applied, so it must
  # name exactly these paths with a positive integer count each.
  and (.proof.regions | type == "object")
  and ([.proof.regions | keys[]] | sort) == ($paths | sort)
  and all(.proof.regions | to_entries[];
        (.value | type == "number")
        and (.value >= 1)
        and (.value == (.value | floor)))
  # The adapter names the answers that reproduced one side verbatim; the controller retries
  # exactly those regions, so the list must be well-formed even when it is empty.
  and (.proof.sideCopies | type == "array")
  and all(.proof.sideCopies[];
        (type == "object")
        and ((keys | sort) == ["path", "region", "side"])
        and (.path as $p | ($paths | index($p)) != null)
        and (.region | type == "number") and (.region >= 0) and (.region == (.region | floor))
        and (.side == "ours" or .side == "theirs"))
' "$out" >/dev/null 2>&1 \
    || fail "$label is missing, off-allowlist, malformed, or not the pinned model; refusing"
}

check_review_result() { # response-file jobKey paths-json label
  local out="$1" job="$2" paths_json="$3" label="$4"
  jq -e --arg job "$job" --arg provider "$MODEL_PROVIDER" --arg model "$MODEL_ID" \
    --argjson paths "$paths_json" '
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
' "$out" >/dev/null 2>&1 \
    || fail "$label is malformed, off-allowlist, or not the pinned model; refusing"
}

# The answer is a region plan: exactly one text per planned region, nothing else. Assembly is
# code, so an answer that drops a path, repeats an index, invents one, or opens a conflict block
# is refused before a single byte is spliced into the merged file. A marker-like line inside a
# region is legitimate merged text (a setext "=======" underline, a "|||||||" or ">>>>>>>" body
# line), so only the "<" opener is fatal here; the assembly scan below lets those lines through
# by exactly the count each answer carries.
check_region_answers() { # response-file label
  local out="$1" label="$2" p planned answered top dup markers region_plan expected
  markers="$(jq -r '.resolutions[]
      | select(.content | test("(?m)^<{7}( |$)"))
      | "\(.path)#\(.region)"' "$out")" \
    || fail "could not scan the $label answers for conflict markers"
  [[ -z "$markers" ]] \
    || fail "$label answers region(s) $markers with a conflict marker line; a replacement must be merged text, refusing"
  dup="$(jq -r '[.resolutions[] | [.path, .region]] | length - (unique | length)' "$out")" \
    || fail "could not check the $label answers for duplicates"
  [[ "$dup" == "0" ]] || fail "$label resolves the same region more than once; refusing"
  # The plan is read once, fatally: a jq failure here must stop the run, never leave the
  # coverage loop below with nothing to check.
  region_plan="$(jq -r '.proof.regions | to_entries[] | [.key, (.value | tostring)] | @tsv' "$out")" \
    || fail "could not read the $label region plan; refusing"
  [[ -n "$region_plan" ]] || fail "$label proves no conflict region for any path; refusing"
  while IFS=$'\t' read -r p planned; do
    [[ -n "$p" ]] || continue
    expected="${expected_regions[$p]:-}"
    if [[ -n "$expected" ]]; then
      (( planned == expected )) \
        || fail "$label proves $planned conflict region(s) for '$p' but git's merged file has $expected; the parser and the adapter disagree, refusing"
    fi
    answered="$(jq --arg p "$p" '[.resolutions[] | select(.path == $p)] | length' "$out")" \
      || fail "could not count the $label answers for '$p'"
    (( planned > 0 )) || fail "$label reports no conflict region for '$p' but returned a merged file for it; refusing"
    (( answered == planned )) \
      || fail "$label resolved $answered of $planned conflict region(s) in '$p'; every region needs exactly one answer, refusing"
    top="$(jq --arg p "$p" '[.resolutions[] | select(.path == $p) | .region] | max' "$out")" \
      || fail "could not read the $label region indexes for '$p'"
    (( top < planned )) \
      || fail "$label answers region $top of '$p', which has only $planned region(s); refusing"
  done <<<"$region_plan"
}

resolve_outs=()

# Strip CR line endings and trailing blank lines so a copy that differs only in line
# endings still compares as a copy.
normalize_copy() {
  LC_ALL=C awk '{ sub(/\r$/, ""); line[NR] = $0 }
    END { last = NR
          while (last > 0 && line[last] == "") last--
          for (i = 1; i <= last; i++) print line[i] }' "$1"
}

# A verbatim copy, or the same text with different line endings or a trailing blank line: a
# model that echoes a side has still not merged it.
copy_matches() { # copy side
  cmp -s "$1" "$2" && return 0
  LC_ALL=C cmp -s <(normalize_copy "$1") <(normalize_copy "$2")
}

# Taking one current side verbatim is only a merge when the other side adds nothing: every
# line of the other side must already appear in the copy. Otherwise the model reverted the
# other side's work, which the size floor cannot see because the copy is the full size.
side_fully_contained() { # other-side copy
  local missing
  missing="$(LC_ALL=C comm -23 <(LC_ALL=C sort -u "$1") <(LC_ALL=C sort -u "$2") \
    | LC_ALL=C sed '/^[[:space:]]*$/d')"
  [[ -z "$missing" ]]
}

# Names a TypeScript file declares at column 0. A merge may reorder or reformat code but it
# cannot lose a declaration that both sides already had without someone deleting code.
declaration_names() {
  LC_ALL=C sed -nE \
    's/^(export )?(default )?(async )?(function\*?|class|interface|type|enum|const|let|var)[[:space:]]+([A-Za-z_$][A-Za-z0-9_$]*).*/\5/p' \
    "$1" | LC_ALL=C sort -u
}

# Declarations present on both current sides that the resolution no longer declares.
dropped_shared_declarations() { # ours theirs resolution
  local shared
  shared="$(LC_ALL=C comm -12 <(declaration_names "$1") <(declaration_names "$2"))"
  [[ -n "$shared" ]] || return 0
  LC_ALL=C comm -23 <(printf '%s\n' "$shared") <(declaration_names "$3") \
    | LC_ALL=C awk 'NF && n < 5 { n += 1; printf "%s%s", (n > 1 ? "," : ""), $0 }'
}

# Where each path's accepted answer came from: its batch, or the one retry a side copy
# earns. The review and the assembly read exactly this, so a retry never mixes answers.
declare -A final_src=()
declare -A side_copy_side=() side_copy_note=() retry_bjob=()
declare -A retry_used=()
retry_paths=()

# The per-path guards. A side copy is the one refusal a fresh session can genuinely fix, so
# it is recorded here and retried once below; every other refusal stops the run immediately.
copy_detected=""

# The adapter accepts a refusal note of at most 1000 characters (MAX_REFUSAL_REASON_CHARS in
# ai-conflict-model.ts) and rejects the whole request above it, so a maximal 1024-character
# path would turn the side-copy retry into a malformed-request failure. The path keeps at most
# 400 code points — each is at most two UTF-16 units in the adapter's count — which keeps the
# note well inside the bound while still naming the refused path.
side_copy_reason() { # path side
  local p="$1" side="$2" lead
  if [[ "$side" == "ours" ]]; then
    lead="matches our side and drops what upstream changed in it"
  else
    lead="matches the upstream side and drops what our side changed in it"
  fi
  jq -rn --arg p "$p" --arg lead "$lead" '
    ($p | if length > 400 then (.[0:200] + "\u2026" + .[-199:]) else . end) as $shown
    | "resolved content for \u0027\($shown)\u0027 \($lead); copying a side is not a merge, refusing (SIDE_COPY)"'
}

check_resolved_path() { # path content-file label
  local rpath="$1" rfile="$2" label="$3" rlen floor rours rtheirs rdropped
  copy_detected=""
  rlen="$(wc -c <"$rfile")"
  floor="${side_cur_min[$rpath]:-0}"
  if (( floor > 4096 )) && (( rlen < floor / 2 )); then
    fail "resolved content for '$rpath' is $rlen bytes, under half of the smaller current side ($floor bytes); the model returned a placeholder or a truncated file, refusing"
  fi
  rours="${side_ours[$rpath]:-}"
  rtheirs="${side_theirs[$rpath]:-}"
  if [[ -n "$rours" && -n "$rtheirs" ]]; then
    # A verbatim copy of one current side passes the size floor, so it is checked against the
    # other side byte-for-byte. An exact copy is only accepted when the other side is
    # contained in it; otherwise the upstream sync would publish a silent revert.
    if copy_matches "$rfile" "$rours"; then
      if ! side_fully_contained "$rtheirs" "$rfile"; then
        copy_detected=ours
        side_copy_side["$rpath"]=ours
        side_copy_note["$rpath"]="$(side_copy_reason "$rpath" ours)"
        retry_paths+=("$rpath")
        return 0
      fi
    elif copy_matches "$rfile" "$rtheirs"; then
      if ! side_fully_contained "$rours" "$rfile"; then
        copy_detected=theirs
        side_copy_side["$rpath"]=theirs
        side_copy_note["$rpath"]="$(side_copy_reason "$rpath" theirs)"
        retry_paths+=("$rpath")
        return 0
      fi
    fi
    # Only a path that exists on both sides can lose a declaration both sides shared; a
    # modify/delete conflict has exactly one side to compare with.
    rdropped="$(dropped_shared_declarations "$rours" "$rtheirs" "$rfile")"
    [[ -z "$rdropped" ]] \
      || fail "resolved content for '$rpath' no longer declares $rdropped, which both sides declared; the merge lost code, refusing (DROPPED_DECLARATIONS)"
  fi
  log "$label accepted a merged answer for '$rpath'"
}

for ((b = 1; b <= nb; b++)); do
  mapfile -t bpaths < <(printf '%s\n' "${batch_paths[$b]}")
  breq="$req/b$b"
  bjob="$jobKey-b$b"
  mkdir -p "$breq"
  bobjs=()
  for p in "${bpaths[@]}"; do bobjs+=("${obj_for[$p]}"); done
  jq -s '.' "${bobjs[@]}" >"$breq/conflicts.json" \
    || fail "could not assemble the conflict payload for batch $b/$nb"
  bpaths_json="$(jq -c '[.[].path]' "$breq/conflicts.json")"

  jq -n --arg job "$bjob" --argjson timeout "$MODEL_TIMEOUT_MS" --arg sdir "$SESSION_DIR/$bjob" \
    --slurpfile conflicts "$breq/conflicts.json" \
    '{mode:"resolve", jobKey:$job, conflicts:$conflicts[0], timeoutMs:$timeout, sessionDir:$sdir}' \
    >"$breq/resolve.req.json" || fail "could not build the resolve request for batch $b/$nb"

  bout="$breq/resolve.out.json"
  rc=0
  run_adapter "$breq/resolve.req.json" "$bout" "$breq/resolve.err" || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    detail="$(adapter_error_detail "$bout" "$rc")"
    if [[ "$detail" == *OUTPUT_TRUNCATED* ]]; then
      detail+=" [one answer is capped at $MODEL_OUTPUT_TOKENS tokens; a longer batch cannot finish in one turn]"
    fi
    fail "resolver adapter failed (batch $b/$nb): $detail"
  fi
  require_single_object "$bout" "resolve batch $b/$nb"
  check_resolve_result "$bout" "$bjob" "$bpaths_json" "resolver result for batch $b/$nb"
  check_region_answers "$bout" "resolver result for batch $b/$nb"
  # Every path of this batch resolves from this answer until a retry replaces it; deletion
  # decisions have no content to guard and keep this source.
  for p in "${bpaths[@]}"; do
    final_src["$p"]="$bout"
    retry_bjob["$p"]="$bjob"
  done
  # A merged file cannot be shorter than its smaller current side. A model that gives up
  # on a large file answers with a stub such as "// Conflict resolution placeholder", which
  # passes the shape checks above and would be committed as the merge result.
  jq -r '.files[] | select(.content != null) | [.path, (.content | utf8bytelength)] | @tsv' "$bout" \
    >"$breq/sizes.tsv" || fail "could not read the resolved content sizes for batch $b/$nb"
  rn=0
  while IFS=$'\t' read -r rpath rlen; do
    [[ -n "$rpath" ]] || continue
    rn=$((rn + 1))
    rfile="$breq/resolved.$rn"
    jq -j --arg p "$rpath" '.files[] | select(.path == $p) | .content' "$bout" >"$rfile" \
      || fail "could not extract the resolved content for '$rpath' from batch $b/$nb"
    check_resolved_path "$rpath" "$rfile" "resolver result for batch $b/$nb"
  done <"$breq/sizes.tsv"
  resolve_outs+=("$bout")
done

# A path whose assembled file reproduced one side verbatim is retried exactly once, alone,
# in a fresh session, with the rejected region named in the request. A second copy fails the
# run with the original refusal, so the guard is never weakened and the retry never loops.
if (( ${#retry_paths[@]} > 0 )); then
  log "retrying ${#retry_paths[@]} path(s) refused for copying a side (one fresh session each)"
  declare -A retried=()
  rk=0
  for rpath in "${retry_paths[@]}"; do
    [[ -z "${retried[$rpath]:-}" ]] || continue
    retried["$rpath"]=1
    retry_used["$rpath"]=1
    rk=$((rk + 1))
    rjob="${retry_bjob[$rpath]}-r1"
    (( rk == 1 )) || rjob="${rjob}-$rk"
    rreq="$req/r1.$rk"
    mkdir -p "$rreq"
    jq -s '.' "${obj_for[$rpath]}" >"$rreq/conflicts.json" \
      || fail "could not assemble the retry payload for '$rpath'"
    rpaths_json="$(jq -c '[.[].path]' "$rreq/conflicts.json")"
    # The regions the adapter reported as a copy name what the fresh session must redo; an
    # empty list means the assembled file as a whole was the copy.
    rregions="$(jq -c --arg p "$rpath" \
      '[((.proof.sideCopies // [])[] | select(.path == $p) | .region)] | unique' "${final_src[$rpath]}")" \
      || fail "could not read the rejected regions of '$rpath'"
    jq -n --arg job "$rjob" --argjson timeout "$MODEL_TIMEOUT_MS" --arg sdir "$SESSION_DIR/$rjob" \
      --arg p "$rpath" --arg side "${side_copy_side[$rpath]}" --arg reason "${side_copy_note[$rpath]}" \
      --argjson regions "$rregions" --slurpfile conflicts "$rreq/conflicts.json" \
      '{mode:"resolve", jobKey:$job, conflicts:$conflicts[0], timeoutMs:$timeout, sessionDir:$sdir,
        refusals:[{path:$p, side:$side, regions:$regions, reason:$reason}]}' \
      >"$rreq/resolve.req.json" || fail "could not build the retry request for '$rpath'"

    rout="$rreq/resolve.out.json"
    rc=0
    run_adapter "$rreq/resolve.req.json" "$rout" "$rreq/resolve.err" || rc=$?
    if [[ "$rc" -ne 0 ]]; then
      fail "${side_copy_note[$rpath]}; the retry (-r1) failed too: $(adapter_error_detail "$rout" "$rc")"
    fi
    require_single_object "$rout" "resolve retry for '$rpath'"
    check_resolve_result "$rout" "$rjob" "$rpaths_json" "resolver retry for '$rpath'"
    check_region_answers "$rout" "resolver retry for '$rpath'"
    if [[ "$(jq -r --arg p "$rpath" '[.files[] | select(.path == $p) | .content != null] | any' "$rout")" == "true" ]]; then
      rfile="$rreq/resolved"
      jq -j --arg p "$rpath" '.files[] | select(.path == $p) | .content' "$rout" >"$rfile" \
        || fail "could not extract the retry content for '$rpath'"
      check_resolved_path "$rpath" "$rfile" "resolver retry for '$rpath'"
      if [[ -n "$copy_detected" ]]; then
        fail "${side_copy_note[$rpath]}; retried once in a fresh session (-r1) and the copy reproduced, refusing (SIDE_COPY)"
      fi
    fi
    final_src["$rpath"]="$rout"
  done
fi

# One merged result in the shape the rest of the run reads; the union must cover every
# conflicted path exactly once, so no batch can silently drop or duplicate a path. The
# review retry below re-runs this, so a revised answer can also change a deletion decision.
resolve_out="$req/resolve.out.json"
declare -A deleted=()
finalize_resolution() {
  local p decision
  : >"$req/files.ndjson"
  for p in "${paths[@]}"; do
    jq -c --arg p "$p" '.files[] | select(.path == $p)' "${final_src[$p]}" >>"$req/files.ndjson" \
      || fail "could not collect the resolution for '$p'"
  done
  jq -s '.' "$req/files.ndjson" >"$req/files.json" || fail "could not assemble the resolution file list"
  jq -s --arg job "$jobKey" --slurpfile files "$req/files.json" '
    {ok: true, mode: "resolve", jobKey: $job,
     model: .[0].model, session: .[0].session, proof: .[0].proof,
     files: $files[0]}' "${resolve_outs[@]}" >"$resolve_out" \
    || fail "could not merge the batch resolutions"
  jq -e --argjson paths "$conflict_paths_json" '
    ([.files[].path] | sort) == ($paths | sort)
    and ([.files[].path] | unique | length) == ($paths | length)
  ' "$resolve_out" >/dev/null 2>&1 \
    || fail "the merged resolution does not cover every conflicted path exactly once; refusing"

  # Each allowlisted path resolves to exactly one decision: replacement content or a
  # deletion. The independent review sees that exact proposal, deletions included.
  deleted=()
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
}
finalize_resolution

# Apply nothing yet: the proposed resolution must survive an independent review first.
# The review turn reads the same regions plus the replacement proposed for each one, never
# the assembled files, so it is batched with the same partition as the resolve turns; the
# merged verdict accepts only when every batch accepted it.
res_total=0
run_review() { # merged-output label
  local merged="$1" label="$2" b p breq bjob bpaths bpaths_json bout rc bres_bytes
  local -a outs=()
  res_total=0
  for ((b = 1; b <= nb; b++)); do
    mapfile -t bpaths < <(printf '%s\n' "${batch_paths[$b]}")
    breq="$req/b$b"
    bjob="$jobKey-b$b"
    bpaths_json="$(jq -c '[.[].path]' "$breq/conflicts.json")"
    # The review judges the accepted proposal, so a retried path is reviewed with the
    # retry's answers, never the refused batch answer.
    : >"$breq/review.resolutions.ndjson"
    for p in "${bpaths[@]}"; do
      jq -c --arg p "$p" '.resolutions[] | select(.path == $p)' "${final_src[$p]}" \
        >>"$breq/review.resolutions.ndjson" \
        || fail "could not collect the proposed regions for '$p'"
    done
    jq -s '.' "$breq/review.resolutions.ndjson" >"$breq/review.resolutions.json" \
      || fail "could not assemble the proposed regions for batch $b/$nb"
    bres_bytes="$(jq '[.[] | .content | utf8bytelength] | add // 0' "$breq/review.resolutions.json")" \
      || fail "could not measure the proposed regions for batch $b/$nb"
    res_total=$((res_total + bres_bytes))

    jq -n --arg job "$bjob" --argjson timeout "$MODEL_TIMEOUT_MS" --arg sdir "$SESSION_DIR/$bjob" \
      --slurpfile conflicts "$breq/conflicts.json" --slurpfile res "$breq/review.resolutions.json" \
      '{mode:"review", jobKey:$job, conflicts:$conflicts[0], resolutions:$res[0], timeoutMs:$timeout, sessionDir:$sdir}' \
      >"$breq/review.req.json" || fail "could not build the review request for batch $b/$nb"

    bout="$breq/review.out.json"
    rc=0
    run_adapter "$breq/review.req.json" "$bout" "$breq/review.err" || rc=$?
    if [[ "$rc" -ne 0 ]]; then
      fail "review adapter failed (batch $b/$nb): $(adapter_error_detail "$bout" "$rc")"
    fi
    require_single_object "$bout" "review batch $b/$nb"
    check_review_result "$bout" "$bjob" "$bpaths_json" "review result for batch $b/$nb"
    # The retry below targets paths named by error findings, and the re-review covers only
    # those paths, so a batch that rejected without naming one could never be retried and its
    # rejection would be dropped once another batch's path cleared. Fail closed here instead.
    jq -e '.verdict == "accepted" or any(.findings[]; .severity == "error")' "$bout" >/dev/null 2>&1 \
      || fail "review rejected the resolution for batch $b/$nb without naming a path with an error finding, so its rejection cannot be retried; refusing"
    outs+=("$bout")
  done

  (( res_total <= MAX_RESOLUTION )) \
    || fail "proposed resolution is $res_total bytes (limit $MAX_RESOLUTION); refusing to review it"
  (( total_text + res_total <= 16000000 )) \
    || fail "conflicted text plus proposed resolution exceeds the adapter input budget"

  jq -s --arg job "$jobKey" '
    {ok: true, mode: "review", jobKey: $job,
     model: .[0].model, session: .[0].session, proof: .[0].proof,
     verdict: (if all(.[]; .verdict == "accepted") then "accepted" else "rejected" end),
     findings: [.[].findings[]]}' "${outs[@]}" >"$merged" \
    || fail "could not merge the batch reviews"

  # The merged review must still describe a single review of the whole set before anything
  # is applied: same allowlist, no error finding under an accepting verdict.
  check_review_result "$merged" "$jobKey" "$conflict_paths_json" "$label"
}
review_out="$req/review.out.json"
run_review "$review_out" "review result"
verdict="$(jq -r '.verdict' "$review_out")"

# --- one bounded review-feedback retry --------------------------------------------
# The review is the last gate before publication, so its rejection earns exactly one
# further attempt per path it names with an error finding: a fresh resolve session that
# carries the path's region plan, the answers the review rejected, and the findings. Only
# the paths whose answers changed are reviewed again, in fresh batches grouped per path:
# every other path's bytes are identical to what the first review accepted, so re-judging
# them would add payload and review variance without covering a changed byte. A batch that
# rejected without naming an error finding stopped the run before this point. A path that
# already spent its one retry on a side copy is never retried twice, and a second rejection
# fails the run with the findings, so no unreviewed variant can be published.
review_retry_line=""
if [[ "$verdict" != "accepted" ]]; then
  retry_error_paths=()
  while IFS= read -r rp; do
    [[ -n "$rp" ]] && retry_error_paths+=("$rp")
  done < <(jq -r '[.findings[] | select(.severity == "error") | .path] | unique[]' "$review_out")
  findings="$(jq -r '.findings[] | "\(.severity) \(.path): \(.message)"' "$review_out" | tr '\n' ';')"
  (( ${#retry_error_paths[@]} > 0 )) \
    || fail "review rejected the resolution without an error finding naming a path, so no retry can target it: $findings"
  log "review rejected the resolution; re-resolving ${#retry_error_paths[@]} path(s) once in fresh sessions (-rev1): $(printf '%s ' "${retry_error_paths[@]}")"
  rk=0
  retry_cert=()
  for rp in "${retry_error_paths[@]}"; do
    [[ -z "${retry_used[$rp]:-}" ]] \
      || fail "review rejected '$rp' after its one retry (a side-copy retry already ran); refusing a second retry: $findings"
    rk=$((rk + 1))
    rjob="${jobKey}-rev1-$rk"
    rreq="$req/rev1.$rk"
    mkdir -p "$rreq"
    jq -s '.' "${obj_for[$rp]}" >"$rreq/conflicts.json" \
      || fail "could not assemble the review retry payload for '$rp'"
    rpaths_json="$(jq -c '[.[].path]' "$rreq/conflicts.json")"
    jq -n --arg p "$rp" --slurpfile review "$review_out" --slurpfile prior "${final_src[$rp]}" '
      {path: $p,
       regions: ([$prior[0].resolutions[] | select(.path == $p) | .region] | sort),
       findings: [$review[0].findings[] | select(.severity == "error" and .path == $p) | .message],
       priorAnswers: [$prior[0].resolutions[] | select(.path == $p) | {region, content}]}' \
      >"$rreq/feedback.json" || fail "could not build the review feedback for '$rp'"
    rregions="$(jq -c '.regions' "$rreq/feedback.json")" \
      || fail "could not read the review feedback regions for '$rp'"

    jq -n --arg job "$rjob" --argjson timeout "$MODEL_TIMEOUT_MS" --arg sdir "$SESSION_DIR/$rjob" \
      --slurpfile conflicts "$rreq/conflicts.json" --slurpfile fb "$rreq/feedback.json" \
      '{mode:"resolve", jobKey:$job, conflicts:$conflicts[0], timeoutMs:$timeout, sessionDir:$sdir,
        reviewFeedback:[$fb[0]]}' >"$rreq/resolve.req.json" \
      || fail "could not build the review retry request for '$rp'"

    rout="$rreq/resolve.out.json"
    rc=0
    run_adapter "$rreq/resolve.req.json" "$rout" "$rreq/resolve.err" || rc=$?
    if [[ "$rc" -ne 0 ]]; then
      fail "review retry for '$rp' (-rev1) failed: $(adapter_error_detail "$rout" "$rc"); review findings: $findings"
    fi
    require_single_object "$rout" "resolve retry for '$rp'"
    check_resolve_result "$rout" "$rjob" "$rpaths_json" "review retry for '$rp'"
    check_region_answers "$rout" "review retry for '$rp'"
    if [[ "$(jq -r --arg p "$rp" '[.files[] | select(.path == $p) | .content != null] | any' "$rout")" == "true" ]]; then
      rfile="$rreq/resolved"
      jq -j --arg p "$rp" '.files[] | select(.path == $p) | .content' "$rout" >"$rfile" \
        || fail "could not extract the review retry content for '$rp'"
      check_resolved_path "$rp" "$rfile" "review retry for '$rp'"
      if [[ -n "$copy_detected" ]]; then
        fail "${side_copy_note[$rp]}; retried once after the review rejection (-rev1) and the copy reproduced, refusing (SIDE_COPY)"
      fi
    fi
    final_src["$rp"]="$rout"
    retry_used["$rp"]=1
    retry_cert+=("$rp#$(jq -r 'map(tostring) | join(",")' <<<"$rregions")")
  done

  # The retry answers changed the candidate, so the union and the deletion decisions
  # describe the new proposal. The re-review judges only the paths whose answers changed:
  # every other path's bytes are identical to what the first review accepted, so re-judging
  # them would add payload and review variance without covering a changed byte. The retried
  # paths are re-reviewed in token-budgeted batches (typically one) that cover exactly the
  # changed answers, so no path whose bytes changed is left unreviewed.
  finalize_resolution
  declare -a rr_batches=()
  rbn=0
  rci=0
  rco=0
  for rp in "${retry_error_paths[@]}"; do
    p_in="$(tokens_of "${est_in[$rp]}")"
    p_out="$(tokens_of "${est_out[$rp]}")"
    if (( rbn == 0 )) || (( rci + p_in > BATCH_IN )) || (( rco + p_out > BATCH_OUT )) \
      || (( rci + rco + p_in + p_out > BATCH_IN + BATCH_OUT )); then
      rbn=$((rbn + 1))
      rr_batches[rbn]="$rp"
      rci=$p_in
      rco=$p_out
    else
      rr_batches[rbn]+=$'\n'"$rp"
      rci=$((rci + p_in))
      rco=$((rco + p_out))
    fi
  done

  retry_review_outs=()
  rres_total=0
  for ((rb = 1; rb <= rbn; rb++)); do
    mapfile -t rpaths < <(printf '%s\n' "${rr_batches[$rb]}")
    rreq2="$req/rv2.$rb"
    mkdir -p "$rreq2"
    robjs=()
    for rp in "${rpaths[@]}"; do robjs+=("${obj_for[$rp]}"); done
    jq -s '.' "${robjs[@]}" >"$rreq2/conflicts.json" \
      || fail "could not assemble the re-review payload for retried paths"
    rpaths_json="$(jq -c '[.[].path]' "$rreq2/conflicts.json")"
    : >"$rreq2/resolutions.ndjson"
    for rp in "${rpaths[@]}"; do
      jq -c --arg p "$rp" '.resolutions[] | select(.path == $p)' "${final_src[$rp]}" \
        >>"$rreq2/resolutions.ndjson" \
        || fail "could not collect the retried regions for '$rp'"
    done
    jq -s '.' "$rreq2/resolutions.ndjson" >"$rreq2/resolutions.json" \
      || fail "could not assemble the retried regions for the re-review"
    rres_total=$((rres_total + $(jq '[.[] | .content | utf8bytelength] | add // 0' "$rreq2/resolutions.json")))
    rjob2="$jobKey-rv2-$rb"
    jq -n --arg job "$rjob2" --argjson timeout "$MODEL_TIMEOUT_MS" --arg sdir "$SESSION_DIR/$rjob2" \
      --slurpfile conflicts "$rreq2/conflicts.json" --slurpfile res "$rreq2/resolutions.json" \
      '{mode:"review", jobKey:$job, conflicts:$conflicts[0], resolutions:$res[0], timeoutMs:$timeout, sessionDir:$sdir}' \
      >"$rreq2/review.req.json" || fail "could not build the re-review request for retried paths"
    rout2="$rreq2/review.out.json"
    rc=0
    run_adapter "$rreq2/review.req.json" "$rout2" "$rreq2/review.err" || rc=$?
    if [[ "$rc" -ne 0 ]]; then
      fail "re-review adapter failed (retried paths): $(adapter_error_detail "$rout2" "$rc")"
    fi
    require_single_object "$rout2" "re-review of retried paths"
    check_review_result "$rout2" "$rjob2" "$rpaths_json" "re-review of retried paths"
    retry_review_outs+=("$rout2")
  done
  (( rres_total <= MAX_RESOLUTION )) \
    || fail "proposed resolution is $rres_total bytes (limit $MAX_RESOLUTION); refusing to re-review it"
  (( total_text + rres_total <= 16000000 )) \
    || fail "conflicted text plus proposed resolution exceeds the adapter input budget"

  jq -s --arg job "$jobKey" '
    {ok: true, mode: "review", jobKey: $job,
     model: .[0].model, session: .[0].session, proof: .[0].proof,
     verdict: (if all(.[]; .verdict == "accepted") then "accepted" else "rejected" end),
     findings: [.[].findings[]]}' "${retry_review_outs[@]}" >"$req/review2.retry.json" \
    || fail "could not merge the re-reviews of the retried paths"

  # The first review keeps binding exactly the paths it judged and that did not change; the
  # re-review supersedes its findings for the retried paths.
  retried_json="$(jq -c -n --args '$ARGS.positional' "${retry_error_paths[@]}")"
  review_out="$req/review2.out.json"
  jq -n --arg job "$jobKey" --slurpfile first "$req/review.out.json" \
    --slurpfile again "$req/review2.retry.json" --argjson retried "$retried_json" '
    {ok: true, mode: "review", jobKey: $job,
     model: $first[0].model, session: $again[0].session, proof: $again[0].proof,
     verdict: $again[0].verdict,
     findings: ([$first[0].findings[] | select(.path as $p | ($retried | index($p)) == null)] + $again[0].findings)}' \
    >"$review_out" || fail "could not merge the first review with the re-review"
  check_review_result "$review_out" "$jobKey" "$conflict_paths_json" "review result after a retry"
  verdict="$(jq -r '.verdict' "$review_out")"
  retry_cert_join="$(IFS=';'; printf '%s' "${retry_cert[*]}")"
  if [[ "$verdict" != "accepted" ]]; then
    findings="$(jq -r '.findings[] | "\(.severity) \(.path): \(.message)"' "$review_out" | tr '\n' ';')"
    fail "review rejected the resolution again after one retry (-rev1: $retry_cert_join): $findings"
  fi
  review_retry_line="Review-Retry: v1 re-resolved after a rejected review ($retry_cert_join; the re-review of the retried paths accepted)"
fi

[[ "$(jq -r '.verdict' "$review_out")" == "accepted" ]] \
  || fail "review did not accept the resolution"
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

# Assembly is code, so the only way a block can survive is a block that was not replaced or an
# answer that opened one (both refused above). The scan therefore re-runs the region parser on
# the assembled file — it must hold no conflict block at all — and allows no more marker-like
# lines than git's merged file already carried outside its blocks (a "=======" setext underline,
# say) plus exactly the marker-like lines the accepted answers carried for that path (a region
# body may legitimately contain one). Those lines must not fail a valid sync. A block-free
# (modify/delete) conflict is one whole-file region whose marker-like lines are all counted,
# which only widens the allowance: the count can never admit a "<<" opener, and any surviving
# block is refused above.
for p in "${kept[@]}"; do
  [[ -f "$work/$p" ]] || continue
  assembled="$(region_bytes "$work/$p")" \
    || fail "conflict markers in the resolved '$p': the assembled file leaves a malformed or unterminated marker block; refusing"
  IFS=$'\t' read -r _ _ assembled_blocks assembled_markers <<<"$assembled"
  answer_markers="$(jq -r --arg p "$p" '
    [.resolutions[] | select(.path == $p) | .content | splits("\n")
     | sub("\r$"; "") | select(test("^(=======$|\\|{7}( |$)|>{7}( |$))"))] | length' "${final_src[$p]}")" \
    || fail "could not count the marker-like answer lines for '$p'"
  allowed_markers=$(( ${merged_markers[$p]:-0} + answer_markers ))
  (( assembled_blocks == 0 )) \
    || fail "conflict markers in the resolved '$p': the assembled file still carries $assembled_blocks conflict block(s); refusing"
  (( assembled_markers <= allowed_markers )) \
    || fail "conflict markers in the resolved '$p': $assembled_markers marker line(s) after assembly, $allowed_markers allowed ($(( allowed_markers - answer_markers )) in git's merged file outside its conflict regions plus $answer_markers carried by the accepted answers); a block survived or an answer opened one, refusing"
done
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
# to bind a later scheduled run to this exact review. A review retry is recorded beside them
# as its own metadata paragraph: sync-upstream.sh refuses any trailer key it does not know,
# so a retry marker must not become an OMP-AI-* trailer, and the certificate's four trailer
# lines stay exactly what that parser validates.
reviewed_tree="$("${GIT[@]}" -C "$work" write-tree)" || fail "could not write the reviewed tree"
merge_msg_file="$req/merge-message"
{
  printf '%s\n\n' "$merge_msg"
  if [[ -n "$review_retry_line" ]]; then
    printf '%s\n\n' "$review_retry_line"
  fi
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
