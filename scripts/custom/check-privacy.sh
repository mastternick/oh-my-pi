#!/usr/bin/env bash
# Fail if any git-tracked file looks like local secrets, runtime state, or private evidence.
# Matches basenames and path fragments only; never denies whole directories such as src/secrets/.
# Content scan covers fork-owned files only: upstream test fixtures and changelogs carry literal
# /home/<user> paths and fake tokens by design.
# Dry-run verified against upstream v18.12.6: .env.example, ISSUE_TEMPLATE/config.yml and ca.crt pass.
#   check-privacy.sh [<git-dir-or-worktree>]     (default: current directory)
set -euo pipefail

cd "${1:-.}"

deny='(^|/)(\.env|\.env\.(local|secret|secrets|prod|production)|auth\.json|credentials\.json|models\.ya?ml|presets?\.ya?ml|.*\.(db|sqlite3?|pem|key|p12|pfx)|id_(rsa|ed25519|ecdsa)(\.pub)?|known_hosts|allowed_signers)$|(^|/)(sessions|repair-backups|\.omp-state|state|local-evidence|mnemopi-data)/|(^|/)memory[^/]*\.db$'

hits="$(git ls-files | grep -E "$deny" || true)"
if [[ -n "$hits" ]]; then
  printf 'privacy: tracked files match the deny list:\n%s\n' "$hits" >&2
  exit 1
fi

fork_paths=(
  scripts/custom
  .github/workflows/custom-ci.yml
  .github/workflows/custom-release.yml
  .github/workflows/custom-sync.yml
  docs/CUSTOM-FORK.md
  docs/UPDATING.md
  docs/PRIVACY.md
)
scan="$(mktemp)"
trap 'rm -f "$scan"' EXIT
if git grep -nIE '/home/[a-z_][a-z0-9_-]*/|(api[_-]?key|token|secret)[[:space:]]*[:=][[:space:]]*["'\''][A-Za-z0-9_-]{16,}' \
  -- "${fork_paths[@]}" >"$scan" 2>/dev/null; then
  printf 'privacy: suspicious content (machine paths or inline credentials):\n' >&2
  cut -c1-200 "$scan" >&2
  exit 1
fi
echo "privacy: ok"
