# omp custom fork: provenance and inventory

This is an **unofficial fork** of [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi). It is not affiliated with or endorsed by the upstream project.

## Provenance

- Upstream baseline: `can1357/oh-my-pi` tag `v18.10.3`, commit `81e1d8927a3c16cfaff2e9456baa8c060e1e0e9b`.
- Snapshot: local customizations of the installed `@oh-my-pi/*` 18.10.3 packages, applied onto the upstream tag. Upstream `package.json` files are kept as-is. Publish-only rewrites from the installed packages are not carried.
- Planned port target: upstream `v18.12.6`, commit `45c35e40c46166dc726ccc52f5d27f40f2449f99`. **Not done in this snapshot.**
- License: MIT. `LICENSE` and `THIRD-PARTY-NOTICES.txt` are retained unchanged from upstream.

## Scope of this snapshot

Only TypeScript packages and root build inputs are included (sparse checkout). Rust crates, Bazel, Nix, infra, CI workflows, and unrelated Python trees are excluded. The `packages/natives` native binary is consumed as a prebuilt `@oh-my-pi/pi-natives-linux-x64` package. Its Rust source is not part of this snapshot.

## Excluded artifacts (never publish)

- Config, auth, models, presets, sessions, memory databases, evidence, repair-backups, and state.
- Installed bundles and generated output: `dist/`, `*.pre-pfb-bak`, `tool-views.generated.js`, `docs-index.generated.txt`, `embedded-client.generated.txt`.
- Launcher and autopatch tooling outside the source tree: `~/.local/share/omp-launcher/*`, `~/.local/share/omp-preset-fallback-patch/ensure.sh`, and the experience-memory patch framework (`bin/`, `manifest.tsv`, `patches/`, `state/`, `evidence/`, `repair-backups/`).
- Live-machine harnesses that depend on an installed bundle or local model cache: `bundle-memory-smoke.ts`, `invalid-tool-runtime.ts`, `semantic-runtime.ts`.
- Live-config scenario `tests/session-presets/rpc-scenario.ts`, which reads the real `~/.omp/agent/config.yml`.
- Superseded `acceptance-main/` suite (evidence-era).

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

Source-only divergence (not present in the installed live package): `coding-agent/src/main.ts` and `coding-agent/src/cli/update-cli.ts`. The startup update check now resolves the `omp` path on `PATH` before calling `managedInstallName`, and `resolveOmpPath` is exported. This was requested to suppress the update nag under the custom launcher. It is **unverified**.

Tests included:

- `coding-agent/acceptance/` (11 files, including `support.ts`, `unresolved-tool-loop.test.ts`, and `embed-stub-child.ts`). These import package subpaths, not absolute paths.
- `coding-agent/test/session-presets/{unit,sdk-race}.test.ts`. These require `SOURCE_ROOT=packages/coding-agent`.

## Generated inputs required for a clean build

- `packages/collab-web`: `bun --cwd=packages/collab-web run gen:tool-views` writes `packages/coding-agent/src/export/html/tool-views.generated.js`. The checked-in `tool-views.generated.d.ts` stub lets typecheck pass without it.
- Docs index: generated from `packages/coding-agent/scripts/generate-docs-index.ts` during `gen:bundle`. It reads repo `docs/`, not the installed package.
- Stats client: `bun --cwd=packages/stats run gen:stats`.

## Verification status

No build, typecheck, lint, or test has been run on this snapshot. Every check is NOT_RUN.
