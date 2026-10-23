# Privacy: what is never published

The fork must never contain local state. `scripts/custom/check-privacy.sh` enforces the file rules below in CI and fails the build on a match.

## Never tracked

- Configuration with providers or model settings: `models.yml`, `presets.yml`, and similar.
- Credentials and auth: `auth.json`, `credentials.json`, `.env` and `.env.local` / `.env.secret` / `.env.prod`, private keys (`*.pem`, `*.key`, `*.p12`, `*.pfx`), SSH keys, `known_hosts`.
- Installer state: `state/` under the install root, and the launcher config (`omp-launcher/config`) and its backups. These live on the machine, not in the repo.
- Runtime state: `sessions/`, `state/`, `.omp-state/`, `repair-backups/`, `local-evidence/`, `mnemopi-data/`.
- Memory databases: `*.db`, `*.sqlite`, `memory*.db`.

`.env.example` and `*.example` templates without real values are allowed.

## Never in content

- Absolute paths to a user home (`/home/<user>/`). Scripts resolve paths relative to the repo or to `OMP_*` environment variables.
- Inline credentials matching `api_key|token|secret = "…"` with 16 or more characters.

The content rules scan fork-owned files: `scripts/custom/`, the `custom-*` workflows, and `docs/CUSTOM-FORK.md`, `docs/UPDATING.md`, `docs/PRIVACY.md`. Upstream files are not content-scanned, because upstream test fixtures and changelogs contain literal `/home/<user>` paths and fake tokens by design. The file-name rules apply to the whole tree.

## Local-only

The live launcher, its config (`~/.local/share/omp-launcher/config`), and the preset-fallback guard (`~/.local/share/omp-preset-fallback-patch/ensure.sh`) stay on the machine. The published launcher reads `OMP_LAUNCHER_PFB_ENSURE` and is off by default.

## Dry-run result

The file-name deny list was dry-run against the upstream `v18.12.6` tree and matches no files. An earlier draft matched three upstream files (`.github/ISSUE_TEMPLATE/config.yml`, `infra/bazel-remote/ca.crt`, `python/robomp/.env.example`). The rules were narrowed so those pass, and real secret extensions still match. The content rules were run over the fork-owned paths listed above, and passed.
