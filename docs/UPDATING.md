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
5. The bundle is extracted into a staging directory and installed with `bun install --frozen-lockfile --ignore-scripts` using a private bun cache that is deleted afterwards. A shared cache could reuse an older same-version tarball (`18.12.6-c2` vs `18.12.6-c3`), so it is not used. The installed `@oh-my-pi` packages are then compared byte-for-byte with the bundle tarballs, and the staged copy must pass the packaged smoke test (`--version`, `--help`, `--smoke-test`).

Only then does `versions/<label>` appear and `current` move to it.

A same-commit re-run skips the install only when the installed packages still match the bundle. Otherwise the version is reinstalled.

The existing launcher is kept. The installer:

- copies `scripts/custom/launcher/omp` into the launcher directory only when no launcher exists there;
- backs up the launcher config once to `state/launcher-config.pre-custom`;
- rewrites `OMP_REAL_BIN` to `current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js` (stable across upgrades) and `OMP_REAL_RUNNER` to the bun path;
- sets `OMP_PFB_GUARD_SKIP=1` to disable the legacy preset-fallback guard, which patches `~/node_modules` and is not used by the custom channel.

`~/.local/bin/omp` and `~/.bun/bin/omp` are repointed at the launcher. Original entrypoint links are recorded in `state/entrypoints.tsv`. The installer refuses to replace an entrypoint that is a regular file.

Sessions already running keep the binary they started with until they exit. New sessions use `current`.

## Daily update

`scripts/custom/omp-daily-update.sh` installs the newest published `custom-v*` release once a day. It never merges, tags, or publishes. The systemd user units are `scripts/custom/systemd/omp-daily-update.service` and `omp-daily-update.timer`.

- The timer fires at 05:40 with up to a 2 h random delay (`OnCalendar=*-*-* 05:40:00`, `RandomizedDelaySec=2h`, `Persistent=true`).
- Discovery reads every release page and picks the newest non-draft, non-prerelease `custom-v*` tag by semver.
- If that tag is already `current`, the run does nothing. A tag older than `current` is refused.
- A run is refused when free space on the install root is below `OMP_DAILY_MIN_FREE` (default 1.5 GiB).
- The install is delegated to `install.sh`, so every check in the Install section applies. Previous and current versions are kept; nothing is deleted.
- A failure appends a line to `state/last-failure` and runs `OMP_DAILY_NOTIFY_CMD` if set. A successful install clears that file.

Layout: the service runs `~/.local/bin/omp-daily-update.sh`. The wrapper finds the installer at `~/.local/libexec/omp-custom/install.sh`, so the installer suite (`scripts/custom/*.sh` and `launcher/`) is copied there. The units go in `~/.config/systemd/user/`. Timers run while logged out only if linger is enabled (`loginctl enable-linger <user>`).

```
systemctl --user daemon-reload
systemctl --user enable --now omp-daily-update.timer
systemctl --user start omp-daily-update.service   # run once now
journalctl --user -u omp-daily-update.service
```

## Rollback

- `scripts/custom/rollback.sh` swaps `current` and `previous`.
- `scripts/custom/rollback.sh --restore-entrypoints` also copies `state/launcher-config.pre-custom` back over the launcher config and restores the links from `state/entrypoints.tsv`. Entries recorded as absent are removed.
- A plain `rollback.sh` leaves the launcher config and entrypoints alone; `OMP_REAL_BIN` follows `current`, so the swap is enough.

## Notes

- `omp update` is not used on the custom channel. Upgrade by installing a newer tag.
- Requires bun ≥ 1.4 (`packageManager` floor in `package.json`). CI pins 1.4.2.
- Requires `gh` with `api` and `release` support, and `git`. `gh attestation` is not needed to install.
