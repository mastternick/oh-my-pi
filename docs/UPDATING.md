# Updating omp-custom

Scripts live in `scripts/custom/`. Run them from a checkout of the verified tag, not from a working branch.

## One-time setup (operator)

1. `custom` is the default branch of the fork. Scheduled sync runs only from the default branch, so `main` is not used for automation. `main` contents are unchanged.
2. The upstream workflows `ci.yml`, `bun-cache-warm.yml`, and `nix.yml` are disabled, not deleted: `gh workflow disable ci.yml bun-cache-warm.yml nix.yml`.

## Sync upstream

- `custom-sync.yml` runs weekly on the default branch and on `workflow_dispatch` with an optional `upstream_tag` (`vX.Y.Z`).
- It merges the upstream stable tag into `sync/upstream-<tag>` with `--no-ff`, opens a PR against `custom`, and dispatches `custom-ci` on the sync branch with `gh workflow run custom-ci.yml --ref <branch>`. PRs opened with `GITHUB_TOKEN` do not trigger `pull_request` workflows, so this dispatch is the CI trigger.
- A merge conflict fails the job. Resolve it locally on a branch and open the PR by hand.
- The job never pushes to `custom` or `main`, never force-pushes, and never merges the PR.

## Gate and release

1. Merge the sync PR once `custom-ci` passes: privacy gate, shell checks, `bun run ci:check:full`, and pack plus smoke.
2. Create an annotated tag on the `custom` commit and push it:
   `git tag -a custom-v<X.Y.Z>-c<N> -m "omp-custom <X.Y.Z> c<N>" <commit>` then `git push origin custom-v<X.Y.Z>-c<N>`.
3. `custom-release.yml` runs on the tag. It re-runs CI, checks that the tag is on `custom`, packs the bundle `omp-custom-<X.Y.Z>-c<N>.tgz`, writes `SHA256SUMS.txt` for that bundle, creates the GitHub release with `--verify-tag`, and attests the bundle and checksums with `actions/attest-build-provenance`. The attestation is extra evidence. The installer does not require it.

The bundle holds `package.json`, `bun.lock`, and the packed workspace packages of `coding-agent`, `agent`, `ai`, `catalog`, `mnemopi`, and `tui`. `@oh-my-pi/pi-natives` is not bundled. It is installed from npm at the pinned version, because it is unmodified.

## Install

```
scripts/custom/install.sh --tag custom-v<X.Y.Z>-c<N>
```

Checks, in order. Nothing becomes `current` unless every check passes:

1. The tag resolves to a commit through the GitHub API. `git` in the local clone must resolve the same commit.
2. That commit is an ancestor of `origin/custom`.
3. The `custom-release.yml` run for that tag and commit has conclusion `success`, checked through the Actions API.
4. The bundle matches `SHA256SUMS.txt` (`sha256sum -c`).
5. The bundle is extracted into a staging directory and installed with `bun install --frozen-lockfile --ignore-scripts`, then passes the packaged smoke test (`--version`, `--help`, `--smoke-test`).

Only then does `versions/<label>` appear and `current` move to it.

The existing launcher is kept. The installer:

- copies `scripts/custom/launcher/omp` into the launcher directory only when no launcher exists there;
- backs up the launcher config once to `state/launcher-config.pre-custom`;
- rewrites `OMP_REAL_BIN` to `current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js` (stable across upgrades), `OMP_REAL_RUNNER` to the bun path, and `OMP_REAL_VERSION`;
- sets `OMP_LAUNCHER_PFB_ENSURE=` to disable the legacy preset-fallback guard, which patches `~/node_modules` and is not used by the custom channel.

`~/.local/bin/omp` and `~/.bun/bin/omp` are repointed at the launcher. Original entrypoint links are recorded in `state/entrypoints.tsv`. The installer refuses to replace an entrypoint that is a regular file.

Sessions already running keep the binary they started with until they exit. New sessions use `current`.

## Rollback

- `scripts/custom/rollback.sh` swaps `current` and `previous`.
- `scripts/custom/rollback.sh --restore-entrypoints` also restores the links from `state/entrypoints.tsv`. Entries recorded as absent are removed.
- Rollback does not restore the launcher config. To undo the config rewrite, copy `state/launcher-config.pre-custom` back over the launcher config by hand.

## Notes

- `omp update` is not used on the custom channel. Upgrade by installing a newer tag.
- Requires bun ≥ 1.4 (`packageManager` floor in `package.json`). CI pins 1.4.2.
- Requires `gh` with `api` and `release` support, and `git`. `gh attestation` is not needed to install.
