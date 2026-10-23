# omp custom fork: provenance and inventory

This is an **unofficial fork** of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). It is not affiliated with or endorsed by the upstream project.

## Provenance

- Upstream baseline: `can1357/oh-my-pi` tag `v18.10.3`, commit `81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b`.
- Snapshot: local customizations of the installed `@oh-my-pi/*` 18.10.3 packages, applied onto the upstream tag. Upstream `package.json` files are kept as-is. Publish-only rewrites from the installed packages are not carried.
- Planned port target: upstream `v18.12.6`, commit `45c35e40c46166dc726ccc52f5d27f40f2449f99`. **Not done in this snapshot.**
- License: MIT. `LICENSE` and `THIRD-PARTY-NOTICES.txt` are retained unchanged from upstream.

## Scope of this snapshot

Only TypeScript packages and root build inputs are included (sparse checkout). Rust crates, Bazel, Nix, infra, CI workflows, and unrelated Python trees are excluded. `python/robomp/web` is included only because it is a root workspace. The `packages/natives` native binary is consumed as a prebuilt `@oh-my-pi/pi-natives-linux-x64` package. Its Rust source is not part of this snapshot.

## Audit: installed source vs upstream v18.10.3

Method: `git archive 81e1d89` for each `src/` tree, then `diff -rq` against the installed `~/node_modules/@oh-my-pi/<pkg>/src`, excluding `dist/`, `*.pre-pfb-bak`, and `tool-views.generated.js`.

Result: 53 source files differ or exist only on the live side. All 53 are in the commit. The set difference against the commit's `src/` changes is empty, except for one source-only file listed below.

| Package | Differing src entries |
|---|---|
| coding-agent | 46 |
| agent (pi-agent-core) | 1 |
| ai | 2 |
| catalog | 1 |
| mnemopi | 1 |
| tui | 2 |

Classification:

- **Custom source (manifest):** the 46 coding-agent entries, the agent, ai, catalog, and mnemopi entries, and `tui/src/overlays/agent-hub.ts`. Groups are listed below.
- **Custom source (not in manifest):** `tui/src/overlays/agent-hub-judge.ts` (new). Its consumer is `coding-agent/src/modes/agent-hub-judge-source.ts`.
- **Typecheck-only stubs (carried, do not treat as source of truth):** `coding-agent/src/export/html/template.d.ts` and `tool-views.generated.d.ts`. Both are the same one-line `declare const path: string; export default path;` shim.
- **Generated, excluded:** `coding-agent/src/export/html/tool-views.generated.js`.
- **Source-only divergence (not in the installed package):** `coding-agent/src/main.ts` and `coding-agent/src/cli/update-cli.ts`. The startup update check resolves the `omp` path on `PATH` before calling `managedInstallName`, and `resolveOmpPath` is exported. Requested to suppress the update nag under the custom launcher. **Unverified.**
- **Typecheck workaround, not carried as separate source:** `catalog/src/effort.ts` (`const enum` → `enum`). It is in the commit because it is manifest-owned. Upstream 18.12.6 still has `const enum Effort`. Port only if monorepo typecheck needs it.

Non-src files compared against the installed package:

- `coding-agent/CHANGELOG.md`: the installed file differs from upstream by 10 added lines, all in a new `[Unreleased]` section (one Added and three Fixed bullets). This section is now carried. The bullets are documentation. The Judge view is backed by `tui/src/overlays/agent-hub-judge.ts`. The mnemopi autoRetain and IMPORTED-tag behavior is backed by manifest rows in `coding-agent/src/mnemopi/`.
- `package.json` (every package): publish transforms (`types`/`main`/`bin` pointing at `dist/`, `files` additions). Not carried.
- `THIRD-PARTY-NOTICES.txt` appears only in the installed package. Upstream keeps `THIRD-PARTY-NOTICES.txt` at the repo root, which is carried.
- `dist/`: excluded.

## Excluded artifacts (never publish)

- Config, auth, models, presets, sessions, memory databases, evidence, repair-backups, and state.
- Installed bundles and generated output: `dist/`, `*.pre-pfb-bak`, `tool-views.generated.js`, `docs-index.generated.txt`, `embedded-client.generated.txt`.
- Launcher and autopatch tooling outside the source tree: `~/.local/share/omp-launcher/*`, `~/.local/share/omp-preset-fallback-patch/ensure.sh`, the experience-memory patch framework (`bin/`, `manifest.tsv`, `patches/`, `state/`, `evidence/`, `repair-backups/`), `~/.omp/agent/extensions/orca-*.ts` (third-party generated).
- Live-machine harnesses that depend on an installed bundle or local model cache: `bundle-memory-smoke.ts`, `invalid-tool-runtime.ts`, `semantic-runtime.ts`.
- Live-config scenario `test/session-presets/rpc-scenario.ts`, which reads the real `~/.omp/agent/config.yml`.
- Superseded `acceptance-main/` suite (evidence-era).
- Private operator policy and config: `~/.omp/agent/rules/*`, `~/.omp/agent/agents/*`, managed skills, `omp-stats.service` (contains a private hostname), `watch-pr.sh` (reads a secrets file).

## Change groups

Group names match the local stage manifest (`judgment`, `session`, `experience`, `identity`, `stall`, `tool-loop`, `fallback`, `cleanup`, `typefix`). Paths are relative to `packages/`.

| Group | Files |
|---|---|
| tool-loop | `agent/src/agent-loop.ts`, `ai/src/providers/openai-completions.ts`, `ai/src/utils/tool-call-loop-guard.ts`, `ai/acceptance/provider-tool-name.test.ts` |
| typefix | `catalog/src/effort.ts`, `coding-agent/src/config/{model-presets,settings}.ts`, `coding-agent/src/export/html/template.d.ts`, `coding-agent/src/export/html/tool-views.generated.d.ts`, `coding-agent/src/lsp/workspace-diagnostics.ts`, `coding-agent/src/modes/controllers/selector-controller.ts`, `coding-agent/src/session/agent-session.ts` |
| judgment | `coding-agent/src/{auto-thinking/classifier,eval/judgment-bridge,judgment/index,modes/agent-hub-judge-source,modes/types,session/model-controls,session/session-manager,session/turn-recovery,session/unexpected-stop-classifier,slash-commands/builtin-session,tools/jfind/index}.ts`, `coding-agent/src/modes/controllers/selector-controller.ts`, `coding-agent/src/session/agent-session.ts` |
| judgment (tui overlay, not in manifest) | `tui/src/overlays/agent-hub.ts` (modified), `tui/src/overlays/agent-hub-judge.ts` (new) |
| identity | `coding-agent/src/mnemopi/{config,project-identity,project-identity.test}.ts` |
| experience | `coding-agent/src/mnemopi/{backend,config,experience,project-identity,settings,state}.ts`, `coding-agent/src/prompts/system/experience-lesson-extraction.md`, `coding-agent/src/task/executor.ts` |
| cleanup | `mnemopi/src/core/beam/store.ts`, `coding-agent/src/mnemopi/{backend,state}.ts`, `coding-agent/src/prompts/system/mnemopi-instructions.md` |
| session | `coding-agent/src/{config/{model-settings,settings-ui},main,sdk,slash-commands/builtin-modes}.ts`, `coding-agent/src/modes/interactive-mode.ts`, `coding-agent/src/session/{session-manager,session-worktree}.ts`, `coding-agent/src/task/{isolation-ownership,isolation-runner,structured-subagent,worktree}.ts` |
| stall | `coding-agent/src/prompts/judge/task-stall.json`, `coding-agent/src/task/{restore,settings,stall-guard,stall-judge,workpool}.ts`, `coding-agent/src/vibe/runtime.ts` |
| fallback | `coding-agent/src/config/{model-presets,model-settings}.ts` |

Source-only divergence: `coding-agent/src/cli/update-cli.ts` (see above). `coding-agent/src/main.ts` is also a divergence from the installed package, from the same change.

## Tests included

- `coding-agent/acceptance/` (11 files, including `support.ts`, `unresolved-tool-loop.test.ts`, and `embed-stub-child.ts`). These import package subpaths, not absolute paths. Gated by `XM_ACCEPTANCE_HARNESS` (not verified against the gate).
- `coding-agent/test/session-presets/{unit,sdk-race}.test.ts`. Require `SOURCE_ROOT=packages/coding-agent`. `sdk-race.test.ts` also reads `ANTHROPIC_API_KEY` and `TMPDIR`.
- `ai/acceptance/provider-tool-name.test.ts`.

## Deferred, not in the commit

- **Preset fallback PR #14490 test** (`coding-agent/test/model-presets.test.ts`). The PR head `cc15b618a3` (in local clone `~/.local/share/omp-preset-fallback-patch/omp-pr`) has a 32023-byte test and a different `model-presets.ts` (26075 bytes) and `settings.ts` (169765 bytes) than the snapshot. The snapshot's fallback rows are a different revision. The test has not been reconciled with the snapshot source. Choosing a source revision is a decision for the integration owner.
- **Stall-guard tests**: the scout's source is `~/.omp/agent/backups/stall-guard-20261013/corrected/test/`. Not copied: backup tree, not verified against the manifest rows. The original `stall-guard.patch` is marked UNSAFE and is not a source of truth.
- **Judge-view tests**: none found in any location searched. Report as a gap, not a completion signal.
- **Typefix declaration-only workarounds** under `pi-tui/dist/types/` and `pi-catalog/dist/types/` are not carried (generated declarations).
- **Portable runtime pieces** (launcher `bin/omp`, `enable.sh`, `rollback.sh`, `omp-launcher-gc.{service,timer}`, `custom-provider-login.ts`, and the JEV advisory extension in shadow mode): outside the source tree. Delivery scope, not carried here.
- **Manifest test locations**: `ai/acceptance/` and `coding-agent/src/mnemopi/project-identity.test.ts` are kept at their manifest paths. Moving them to `test/` would require a manifest update.

## Generated inputs required for a clean build

- `packages/collab-web`: `bun --cwd=packages/collab-web run gen:tool-views` writes `packages/coding-agent/src/export/html/tool-views.generated.js`. The checked-in `tool-views.generated.d.ts` stub lets typecheck pass without it.
- Docs index: generated by `coding-agent/scripts/generate-docs-index.ts` during `gen:bundle`. It reads repo `docs/`, not the installed package.
- Stats client: `bun --cwd=packages/stats run gen:stats`.

## Verification status

No build, typecheck, lint, or test has been run on this snapshot. Every check is NOT_RUN. The audit above is a file comparison only.
