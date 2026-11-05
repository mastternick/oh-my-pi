# Updating omp-custom

Scripts live in `scripts/custom/`. Run them from a checkout of the verified tag, not from a working branch.

## One-time setup (operator)

1. `custom` is the default branch of the fork. Scheduled sync runs only from the default branch, so `main` is not used for automation. `main` contents are unchanged.
2. The upstream workflows `ci.yml`, `bun-cache-warm.yml`, and `nix.yml` are disabled, not deleted: `gh workflow disable ci.yml bun-cache-warm.yml nix.yml`.

## Sync upstream

- `custom-sync.yml` runs daily at 06:17 UTC from the default branch, and on `workflow_dispatch` with an optional `upstream_tag` (`vX.Y.Z`; empty means newest stable) and `force_release`.
- The workflow needs `contents: write`, `pull-requests: write`, and `actions: write`: it dispatches CI and the release workflow with the job token. Tags pushed with `GITHUB_TOKEN` do not start workflows, which is why the release is dispatched explicitly. Runs are serialized by a `custom-sync` concurrency group.
- `scripts/custom/sync-upstream.sh` performs the whole cycle:
  1. resolve the upstream stable tag (newest `v*`, or the requested one);
  2. if that version is already merged into `custom` and a published `custom-v<X.Y.Z>-c<N>` release contains it, stop: there is nothing to do. `force_release=1` instead publishes a new `c<N>` for the current `custom` HEAD, which is how an already-merged version that never got a release is published;
  3. otherwise merge the tag into `sync/upstream-<tag>` with `--no-ff`. An existing remote branch is reused and updated, so manually resolved commits are kept; a branch that no longer relates to `custom` is refreshed onto the current base;
  4. dispatch `custom-ci` on that exact commit and wait for it (bounded by `OMP_SYNC_TIMEOUT`, default 7200 s, polling `OMP_SYNC_POLL`, default 30 s). Only a `success` run of `custom-ci.yml` whose `head_sha` is the tested commit and whose `head_branch` is the ref it was dispatched on counts: the sync branch in this case, `custom` in the already-merged recovery of step 2;
  5. re-fetch `custom`. If it moved to a commit that does not contain the tested one, fail without publishing and retry next cycle. Otherwise fast-forward `custom` to the tested commit (`git push`, never forced) and push the annotated tag `custom-v<X.Y.Z>-c<N>`; an existing tag for the same commit is reused;
  6. dispatch `custom-release.yml` on that tag and wait for it.
- A conflict, a red, cancelled, or timed-out gate, or a `custom` that moved leaves `custom` and the release list untouched. The run fails and the reason is written to the job summary.
- Every `gh` command names the repository explicitly: the API calls use `repos/<owner>/<repo>/...` paths and the workflow dispatches and sync PR use `--repo mastternick/oh-my-pi`. In a fork checkout `gh` can otherwise resolve the upstream project, where `custom-ci.yml` does not exist, and the run dies with `HTTP 404: workflow custom-ci.yml not found` instead of gating the fork.
- Reruns are idempotent: the sync branch, a successful CI run for the same commit, the tag, and the release are reused instead of duplicated. A tag whose release failed is retried.
- The sync PR exists for visibility; nothing depends on merging it.

Prerequisite: branch protection on `custom`, if enabled, must let the Actions token push to it. Otherwise the fast-forward is rejected and the run fails without publishing.

## Gate and release

`custom-release.yml` runs on a tag push and on `workflow_dispatch` with a required `tag` input. Its `validate` job rejects a dispatch unless the ref is `refs/tags/<tag>`, the input equals the ref name, the tag is annotated, its commit is `GITHUB_SHA`, and that commit is on `custom`. It then re-runs CI, packs `omp-custom-<X.Y.Z>-c<N>.tgz`, writes `SHA256SUMS.txt` for that bundle, creates or updates the GitHub release with `--verify-tag`, and attests the bundle and checksums with `actions/attest-build-provenance`. A rerun uploads the assets with `--clobber` instead of failing on an existing release. The attestation is extra evidence. The installer does not require it.

The manual path still works: create the annotated tag on a `custom` commit and push it.

The bundle holds `package.json`, `bun.lock`, and the packed workspace packages of `coding-agent`, `agent`, `ai`, `catalog`, `mnemopi`, and `tui`. `@oh-my-pi/pi-natives` is not bundled. It is installed from npm at the pinned version, because it is unmodified.

## Install

```
scripts/custom/install.sh --tag custom-v<X.Y.Z>-c<N>
```

Checks, in order. Nothing becomes `current` unless every check passes:

1. The tag resolves to a commit through the GitHub API. `git` in the local clone must resolve the same commit.
2. That commit is an ancestor of `origin/custom`.
3. A `custom-release.yml` run for that tag and commit has conclusion `success`, with event `push` or `workflow_dispatch` and `head_branch` equal to the tag, checked through the Actions API.
4. The bundle matches `SHA256SUMS.txt` (`sha256sum -c`).
5. The bundle is extracted into a staging directory and installed with `bun install --frozen-lockfile --ignore-scripts` using a private bun cache that is deleted afterwards. A shared cache could reuse an older same-version tarball (`18.12.6-c2` vs `18.12.6-c3`), so it is not used. The installed `@oh-my-pi` packages are then compared byte-for-byte with the bundle tarballs, and the staged copy must pass the packaged smoke test (`--version`, `--help`, `--smoke-test`). Bun writes its own `node_modules/<pkg>/.bun-tag` integrity marker during that install; it is exempt from the file-by-file comparison but, when present, must equal the bundle tarball's sha512, so an install of another tarball still fails, while an installer that writes no marker is accepted.

Only then does `versions/<label>` appear and `current` move to it.

A same-commit re-run skips the install only when the installed packages still match the bundle. Otherwise the version is reinstalled.

The existing launcher is kept. The installer:

- copies `scripts/custom/launcher/omp` into the launcher directory only when no launcher exists there;
- backs up the launcher config once to `state/launcher-config.pre-custom`;
- rewrites `OMP_REAL_BIN` to `current/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js` (stable across upgrades) and `OMP_REAL_RUNNER` to the bun path;
- sets `OMP_PFB_GUARD_SKIP=1` to disable the legacy preset-fallback guard, which patches `~/node_modules` and is not used by the custom channel.

The installer also refreshes the deployed tooling from the installed tag: `scripts/custom/*.sh` and `launcher/` into `~/.local/libexec/omp-custom/`, `omp-daily-update.sh` into `~/.local/bin/`, and the systemd units into `~/.config/systemd/user/`, then runs `systemctl --user daemon-reload` when a user session is available. Files missing from an older tag are skipped, so old releases stay installable.

Bootstrap: an install deployed before this change keeps running the previously deployed updater and timer, which never refresh themselves. Run `scripts/custom/install.sh --tag custom-v<X.Y.Z>-c<N>` once from a tag that carries the new installer; from then on each install refreshes the deployed tooling, so later releases reach the new updater and the single-slot timer without manual steps.

`~/.local/bin/omp` and `~/.bun/bin/omp` are repointed at the launcher. Original entrypoint links are recorded in `state/entrypoints.tsv`. The installer refuses to replace an entrypoint that is a regular file.

Sessions already running keep the binary they started with until they exit. New sessions use `current`.

## Daily update

`scripts/custom/omp-daily-update.sh` installs the newest published `custom-v*` release. The timer runs it once a day; a run with nothing new to install only checks and exits. It never merges, tags, or publishes. The systemd user units are `scripts/custom/systemd/omp-daily-update.service` and `omp-daily-update.timer`.

- The timer fires once a day, at 05:40 local time, with up to a 2 h random delay (`OnCalendar=*-*-* 05:40:00`, `RandomizedDelaySec=2h`, `Persistent=true`). The timer runs on local time while the sync publishes at 06:17 UTC, so whether a release is installed on the same day depends on the machine's UTC offset; a release the window misses is installed by the next daily cycle, and `Persistent=true` also fires a run missed while the machine was off.
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
- Requires bun ≥ 1.4.4 (`packageManager` floor in `package.json`). CI pins 1.4.4.
- Requires `gh` with `api` and `release` support, and `git`. `gh attestation` is not needed to install.
