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

The same refresh carries the opt-in AI conflict resolver: `ai-conflict-controller.sh`, `ai-conflict-model.ts`, and `install-ai-conflicts.sh` into the libexec directory, plus the unit and drop-in sources the helper installs from. Deploying them enables nothing. The unit and the daily drop-in are only (re)applied when this user's opt-in marker exists, so an install never turns the resolver on and never leaves the wiring behind for a user who did not ask for it.

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

With the opt-in AI conflict resolver enabled, this same service also starts it first (next section). The installer still runs when the resolver fails, and the resolver reports on its own unit.

Enable only the timer. `omp-daily-update.service` also carries `WantedBy=default.target`, so enabling the service would run the daily update (and, once enabled, the resolver) at every login instead of on the timer.

```
systemctl --user daemon-reload
systemctl --user enable --now omp-daily-update.timer   # the only unit to enable
systemctl --user start omp-daily-update.service        # run once now; keep it disabled
journalctl --user -u omp-daily-update.service
```

## AI conflict resolution (opt-in)

A conflicting upstream merge is the one case the scheduled sync cannot finish, because a resolution is a decision. `scripts/custom/ai-conflict-controller.sh` makes that decision on a narrow model boundary and hands one reviewed candidate to the existing pipeline. It never publishes on its own; the CI gate, the fast-forward, the tag, the release, and the install are unchanged.

What it does, and what stops it:

1. It probes the newest upstream stable tag against `custom` in a fresh blobless clone under the RAM work root. A clean merge is left to the existing GitHub run: the job ends successfully with no model call.
2. A conflicting merge is refused unless every unmerged path is a regular UTF-8 text file in one of the ordinary classes: modify/modify, add/add (no merge base, both sides present), or modify/delete (base present and exactly one side present, with content or an allowlisted deletion). Binary or non-UTF-8 files, symlinks, submodules, mode disagreements, a path absent on both sides, and a one-sided add/rename half without a merge base stop the job instead of being guessed at.
3. For exactly those paths it stages base/ours/theirs (an absent stage is sent as JSON `null`, never as empty text), asks `ai-conflict-model.ts` to resolve them, and then asks it for an independent review. Both turns run as bounded subprocesses: a timeout, a rejected review, an unusable answer, or output over the size cap stops the job.
4. It applies only the allowlisted results, runs deterministic checks, commits the merge, re-checks that the base branch did not move, and pushes the non-force branch `sync/upstream-<tag>`.
5. It dispatches `custom-sync` with the expected base and tree and waits for the run. Everything after that is the normal path.

Enable it per user (an install never does this):

```
scripts/custom/install-ai-conflicts.sh --enable     # from a checkout, or ~/.local/libexec/omp-custom/
```

That writes:

- `~/.local/share/omp-custom/state/ai-conflicts/enabled`, the opt-in marker;
- `~/.config/systemd/user/omp-ai-conflicts.service`, a `Type=oneshot` unit with `SuccessExitStatus=75`, a start bound under 3 h, and no `Restart=` (the daily timer is the retry);
- `~/.config/systemd/user/omp-daily-update.service.d/10-ai-conflicts.conf`, which adds `Wants=` and `After=` for that unit to the daily installer. There is still exactly one timer.

`Wants=` is weak on purpose: the resolver runs first, but a failed or deferred resolver never stops the release installer, and it reports on its own unit:

```
systemctl --user status omp-ai-conflicts.service
journalctl --user -u omp-ai-conflicts.service
```

Disable it again with `--disable`. That removes only `10-ai-conflicts.conf` and the marker: the daily service, the daily timer, other drop-ins, installed versions, the unit file, and the env file are left untouched (the unit is inert once the drop-in is gone). Every later install re-applies the wiring while the marker exists, so an enabled user keeps current assets without repeating the step.

An interrupted hand-off resumes safely. If the controller has already pushed `sync/upstream-<tag>` and its dispatch dies (reboot, timeout, killed run), the next scheduled `custom-sync` run picks that branch up. The controller stamps the certificate into the merge commit it creates — `OMP-AI-Conflict-Review: v1`, `OMP-AI-Reviewed-Base: <sha>`, `OMP-AI-Reviewed-Tree: <sha>`, `OMP-AI-Model: opencode-go/deepseek-v4.1-flash` — and the scheduled run scans `base..remote-branch` for that block even when it is buried under later commits, requires exactly one complete and valid block with those exact keys and model, and checks that its tree is the branch tip. With no explicit `expected_base_sha`/`expected_tree_sha` (the scheduled case) the guards are inferred from the certificate, so a resume needs no manual step; when guards are supplied they must match it. An incomplete, duplicated, or stale certificate — one whose base moved or whose tree is not the tip — fails before any push, CI run, or publication, and a branch with no certificate is never treated as reviewed: it takes the ordinary manual path, which still publishes only through the ordinary CI gate. **A certified AI branch cannot be refreshed into the gate with a different, unreviewed tree.**

Requirements and settings:

- `bun`, `git`, `gh`, `jq`, `flock`, `iconv`, and a writable RAM work root (`OMP_AI_CONFLICTS_TMPDIR`, default `/dev/shm`) with at least 2 GiB free. A missing or unwritable work root fails the run; a busy install/controller lock or too little free space defers it with exit 75.
- `gh` must be logged in with write access to the fork. When the host's active `gh` account is not the fork owner, set `OMP_AI_CONFLICTS_GH_USER` to the account that is (`mastternick` for `mastternick/oh-my-pi` on this host): its existing token is exported to the controller's child processes and stripped from the model subprocess, no global account is switched, and no secret is stored.
- Non-secret settings live in `~/.config/omp-custom/ai-conflicts.env` (for example `OMP_AI_CONFLICTS_GH_USER`, `OMP_CUSTOM_REPO`, `OMP_CUSTOM_BRANCH`). Credentials are never stored there: the job uses the existing `gh` login, and `GH_TOKEN`/`GITHUB_TOKEN` are stripped from the model subprocess.
- The model is pinned: `opencode-go/deepseek-v4.1-flash`. The adapter resolves the installed OMP's public SDK and the existing credentials for that provider without touching the global config, and the controller refuses a turn whose proof reports any other provider or model, so a reconfigured fallback fails closed instead of resolving with an unverified model. Sessions run in `state/ai-conflicts/sessions` (mode 700), not in the interactive session store. Changing the provider is outside this feature.
- Logs, staged conflict files, and the marker live under `~/.local/share/omp-custom/state/ai-conflicts/`.

Failure boundaries, stated plainly:

- There is no timing guarantee. The job is started by the daily timer (local time, 05:40 plus up to 2 h of jitter) while the sync publishes at 06:17 UTC, so which calendar day a conflict is resolved on depends on the machine's UTC offset. One run at a time is enforced by locks; a busy lock defers.
- Only plain-text conflicts are resolved. Anything else, a provider outage, a model answer that fails the deterministic checks or the review, or a base branch that moved while the job worked leaves `custom` and the releases untouched, and the job fails with the reason in the journal.
- Exit 75 (lock busy, low space) is a deferred success for systemd, not a failure; the next daily run tries again.
- Cleanup covers only the transient work: the temporary RAM work directory is removed when a run ends, and `OMP_AI_CONFLICTS_KEEP_WORK=1` keeps it for inspection instead (not used in service). Persisted sessions, the run log, and the state directory are not rotated or deleted automatically, and `--disable` removes only the daily drop-in and the marker, so it deletes none of them.

## Rollback

- `scripts/custom/rollback.sh` swaps `current` and `previous`.
- `scripts/custom/rollback.sh --restore-entrypoints` also copies `state/launcher-config.pre-custom` back over the launcher config and restores the links from `state/entrypoints.tsv`. Entries recorded as absent are removed.
- A plain `rollback.sh` leaves the launcher config and entrypoints alone; `OMP_REAL_BIN` follows `current`, so the swap is enough.

## Notes

- `omp update` is not used on the custom channel. Upgrade by installing a newer tag.
- Requires bun ≥ 1.4.4 (`packageManager` floor in `package.json`). CI pins 1.4.4.
- Requires `gh` with `api` and `release` support, and `git`. `gh attestation` is not needed to install.
