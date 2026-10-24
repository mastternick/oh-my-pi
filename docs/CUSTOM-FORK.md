# omp-custom (unofficial fork)

This is an **unofficial** fork of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), maintained by mastternick. It is not affiliated with or endorsed by the upstream project.

## Status

- Branch `custom` carries local customizations on top of pinned upstream releases.
- Branch `main` is unchanged from the upstream-derived fork base.
- Releases are tags `custom-v<upstream>-c<N>` (for example `custom-v18.12.6-c1`). The package version stays the upstream version.

## License

The project is MIT-licensed. The upstream `LICENSE` and `THIRD-PARTY-NOTICES.txt` are kept verbatim and must stay in every release. Modifications made in this fork are offered under the same MIT terms.

## What the fork adds

- `scripts/custom/launcher/omp`: a self-locating tmux launcher wrapper. Its data directory is set by `OMP_LAUNCHER_DIR`, and the preset-fallback guard is off unless `OMP_LAUNCHER_PFB_ENSURE` is set.
- `scripts/custom/`: pack, smoke, privacy, sync, install, and rollback tooling.
- `.github/workflows/custom-*.yml`: CI, tag-driven release with build attestation, and weekly upstream sync PRs. `custom` is the default branch, so scheduled sync runs from it.
- `docs/`: this file, `UPDATING.md` (operator runbook), and `PRIVACY.md` (what is never published).

## Not included

Configuration, credentials, sessions, memory databases, presets, local evidence, and repair backups are never published. See `docs/PRIVACY.md`.

## Changes from upstream

Local source changes are recorded in the commit history of `custom`. Upstream history is merged, not rewritten.

Known deliberate source change: `checkForNewVersion` in `main.ts` resolves the real launcher path before calling `managedInstallName`, so the custom channel's `manager.json` is honored and the startup update prompt does not suggest `omp update`.

Known deliberate source change: Mnemopi embedding model chain. `mnemopi.embeddingFallbackModels` (env `MNEMOPI_EMBEDDING_FALLBACK_MODELS`) is an ordered list tried after `embeddingModel`. `memory_embeddings` is keyed by (memory_id, model) with a migration, and reconcile runs per model. Query-time fallback skips a failed model for 5 minutes. Non-fastembed models route to the API without `MNEMOPI_EMBEDDINGS_VIA_API`.

## Upstream CI

Upstream workflows that target `omp-kata` runners or Bazel are disabled on the fork, not deleted, so upstream merges stay conflict-free.
