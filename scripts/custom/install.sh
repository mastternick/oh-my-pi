#!/usr/bin/env bash
# Install one verified omp-custom release. Nothing becomes current unless every check passes:
#   1. the tag resolves to a commit that is an ancestor of origin/custom, and git agrees with the API
#   2. the custom-release workflow succeeded for that tag and commit (GitHub Actions API)
#   3. the release bundle matches SHA256SUMS.txt
#   4. the unpacked CLI passes the smoke test before the atomic switch
#
# The existing omp launcher is kept. Only its config is rewritten to point at the current version,
# and the legacy preset-fallback guard is disabled. Sessions started under an older binary keep it
# until they exit.
#   install.sh --tag custom-v<X.Y.Z>[-c<N>]
# Environment:
#   OMP_CUSTOM_HOME              install root (default ${XDG_DATA_HOME:-~/.local/share}/omp-custom)
#   OMP_LAUNCHER_DIR             launcher data dir (default ${XDG_DATA_HOME:-~/.local/share}/omp-launcher)
#   OMP_CUSTOM_REPO              GitHub repo (default mastternick/oh-my-pi)
#   OMP_CUSTOM_RELEASE_WORKFLOW  release workflow file (default custom-release.yml)
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$script_dir/lib.sh"

REPO="${OMP_CUSTOM_REPO:-mastternick/oh-my-pi}"
ROOT="${OMP_CUSTOM_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/omp-custom}"
LAUNCHER_DIR="${OMP_LAUNCHER_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/omp-launcher}"
WORKFLOW="${OMP_CUSTOM_RELEASE_WORKFLOW:-custom-release.yml}"

tag=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) [[ $# -ge 2 ]] || die "--tag requires a value"; tag="$2"; shift 2 ;;
    *) die "usage: install.sh --tag custom-v<X.Y.Z>[-c<N>]" ;;
  esac
done
[[ "$tag" =~ ^custom-v([0-9]+\.[0-9]+\.[0-9]+(-c[0-9]+)?)$ ]] || die "--tag must look like custom-v18.12.6-c1"
label="${BASH_REMATCH[1]}"
asset="omp-custom-$label.tgz"

for cmd in bun git gh sha256sum; do
  command -v "$cmd" >/dev/null || die "missing required command: $cmd"
done
[[ "$(printf '%s\n' "$(bun --version)" 1.4 | sort -V | head -n1)" == "1.4" ]] || die "bun >= 1.4 required (package.json packageManager floor)"

mkdir -p "$ROOT"/{source,downloads,versions,state}
omp_custom_lock "$ROOT"

# 1. Tag -> commit: git and the API must agree, and the commit must be on custom.
commit="$(gh api "repos/$REPO/commits/$tag" --jq .sha)" || die "tag $tag not found on $REPO"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || die "could not resolve $tag to a commit"

src="$ROOT/source"
[[ -d "$src/.git" ]] || git clone --quiet --filter=blob:none --no-checkout "https://github.com/$REPO.git" "$src"
git -C "$src" fetch --quiet --no-tags --filter=blob:none origin \
  "+refs/tags/$tag:refs/tags/$tag" "+refs/heads/custom:refs/remotes/origin/custom"
[[ "$(git -C "$src" rev-parse --verify "refs/tags/$tag^{commit}")" == "$commit" ]] \
  || die "git and API disagree on the commit for $tag"
git -C "$src" merge-base --is-ancestor "$commit" refs/remotes/origin/custom \
  || die "$tag commit is not on the custom branch"

# 2. The release workflow must have succeeded for this exact tag and commit.
ok_runs="$(gh api "repos/$REPO/actions/workflows/$WORKFLOW/runs?head_sha=$commit&per_page=100" \
  --jq "[.workflow_runs[] | select(.conclusion == \"success\" and .event == \"push\" and .head_branch == \"$tag\")] | length")"
[[ "$ok_runs" -ge 1 ]] || die "no successful $WORKFLOW run for $tag at $commit"

# 3. Release assets must match the checksums published by that run.
dl="$ROOT/downloads/$tag"
rm -rf "$dl"
mkdir -p "$dl"
gh release download "$tag" -R "$REPO" -D "$dl" -p SHA256SUMS.txt -p "$asset"
(cd "$dl" && sha256sum -c --quiet SHA256SUMS.txt) || die "release checksum mismatch for $tag"

# 4. Unpack and install into a staging dir, smoke-test it, then move it into place.
vdir="$ROOT/versions/$label"
if [[ -f "$vdir/.commit" && "$(cat "$vdir/.commit")" == "$commit" ]]; then
  echo "$label already installed at $commit"
else
  stage=""
  trap '[[ -z "$stage" ]] || rm -rf "$stage"' EXIT
  stage="$(mktemp -d "$ROOT/versions/.stage-$label.XXXXXX")"
  omp_custom_install_bundle "$dl/$asset" "$stage"
  omp_custom_smoke "$stage"
  printf '%s\n' "$commit" > "$stage/.commit"
  rm -rf "$vdir"
  mv "$stage" "$vdir"
  stage=""
  trap - EXIT
fi

# Keep the rollback target: current becomes previous, and the new version becomes current.
if [[ -L "$ROOT/current" ]]; then
  omp_custom_atomic_link "$(readlink "$ROOT/current")" "$ROOT/previous"
fi
omp_custom_atomic_link "versions/$label" "$ROOT/current"

runner="$(command -v bun)"

# Launcher: install the repo copy only on a fresh machine. An existing launcher is left in place.
L="$LAUNCHER_DIR"
mkdir -p "$L/bin"
if [[ ! -x "$L/bin/omp" ]]; then
  git -C "$src" show "$commit:scripts/custom/launcher/omp" > "$L/bin/.omp.new"
  chmod 755 "$L/bin/.omp.new"
  mv -f "$L/bin/.omp.new" "$L/bin/omp"
fi

# Save the launcher config once, before the first custom install, so it can be restored by hand.
cfg="$L/config"
[[ -f "$cfg" ]] || : > "$cfg"
pre="$ROOT/state/launcher-config.pre-custom"
[[ -f "$pre" ]] || cp "$cfg" "$pre"

# Rewrite only the keys the custom channel owns; keep the rest of the config untouched.
tmp_cfg="$cfg.new.$$"
{
  grep -Ev '^(OMP_REAL_BIN|OMP_REAL_RUNNER|OMP_REAL_VERSION|OMP_PFB_GUARD_SKIP|OMP_LAUNCHER_PFB_ENSURE)=' "$cfg" || true
  printf '# omp-custom channel (managed by scripts/custom/install.sh)\n'
  printf 'OMP_REAL_BIN=%q\n' "$ROOT/current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js"
  printf 'OMP_REAL_RUNNER=%q\n' "$runner"
  printf '# The legacy preset-fallback guard patches ~/node_modules; the custom channel does not use it.\n'
  printf 'OMP_PFB_GUARD_SKIP=1\n'
} > "$tmp_cfg"
mv -f "$tmp_cfg" "$cfg"

# Entrypoints: record each original link once so rollback --restore-entrypoints can undo it.
state="$ROOT/state/entrypoints.tsv"
touch "$state"
repoint() {
  local link="$1" target="$2" old=""
  if [[ -e "$link" && ! -L "$link" ]]; then die "$link is a regular file; refusing to replace it"; fi
  [[ -L "$link" ]] && old="$(readlink "$link")"
  if ! grep -qF -- "$link"$'\t' "$state"; then printf '%s\t%s\n' "$link" "$old" >> "$state"; fi
  mkdir -p "$(dirname "$link")"
  omp_custom_atomic_link "$target" "$link"
}
repoint "$HOME/.local/bin/omp" "$L/bin/omp"
[[ -d "$HOME/.bun/bin" ]] && repoint "$HOME/.bun/bin/omp" "$L/bin/omp"

echo "installed $tag (commit $commit)"
echo "current -> versions/$label; previous kept for scripts/custom/rollback.sh"
echo "launcher: $L/bin/omp (config: $cfg)"
echo "entrypoints: ~/.local/bin/omp and ~/.bun/bin/omp -> $L/bin/omp"
