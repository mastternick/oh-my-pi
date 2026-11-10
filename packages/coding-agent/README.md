# @oh-my-pi/pi-coding-agent

Core implementation package for the `omp` coding agent in the `omp` monorepo.

For installation, setup, provider configuration, model roles, slash commands, and full CLI reference, see:

- [Monorepo README (local)](../../README.md)
- [Monorepo README (GitHub)](https://github.com/can1357/oh-my-pi#readme)

Package-specific references:

- [CHANGELOG](./CHANGELOG.md)
- [MCP configuration guide](../../docs/mcp-config.md)
- [MCP runtime lifecycle](../../docs/mcp-runtime-lifecycle.md)
- [MCP server/tool authoring](../../docs/mcp-server-tool-authoring.md)
- [DEVELOPMENT](./DEVELOPMENT.md)

## Model routing and fallback chains

`retry.fallbackChains` maps a model role, an exact model selector (`provider/model-id`), or a provider wildcard (`provider/*`) to an ordered list of fallback selectors. Model resolution is explicit-only (this is unrelated to the `explicit-only` extension-root mode):

- A chain applies only to the key that literally names it. The `default` chain belongs to the `default` role alone; another role never borrows it, and a role is never selected because another role happens to run the same model.
- A configured role is authoritative: it is attempted as exactly its configured primary plus its own `fallbackChains[role]` entries. A configured role without a chain fails closed on its first failure rather than continuing through the catalog priority list, so an empty `[]` entry is not needed to express "no fallback".
- A configured model that is unavailable or cannot authenticate surfaces a visible role/request error instead of being replaced by another catalog model, a parent session's model, or a bundled local model. A configured `image` role errors when its model cannot serve, and configured `speech`/`dictation` roles stay off instead of falling back to the bundled local model.
- Exact model-selector and `provider/*` wildcard chains still apply to whatever model or provider they name, across roles.

Catalog priority defaults are bootstrap only: a role with no `modelRoles` entry resolves from the catalog list, which is distinct from substituting a model that the user did configure. The rule lives in the central role resolver used at startup, retry, subagent dispatch, and preset application, so already saved presets and future ones follow it without rewriting their stored chains.

## Memory backends

The agent supports three mutually-exclusive memory backends, selected via the `memory.backend` setting (Settings → Memory tab, or `~/.omp/config.yml`):

- `off` (default) — no memory subsystem runs.
- `local` — existing rollout-summarisation pipeline; writes `memory_summary.md` and consolidated artifacts under the agent dir.
- `hindsight` — talks to a [Hindsight](https://hindsight.vectorize.io) server (Cloud or self-hosted Docker), retains transcripts every Nth user turn, recalls memories on the first turn of a session, and exposes `retain`, `recall`, and `reflect`.

### Hindsight quickstart

1. Run a Hindsight server (Cloud or `docker run -p 8888:8888 ghcr.io/vectorize-io/hindsight:latest`).
2. Set `memory.backend = "hindsight"` and `hindsight.apiUrl = "http://localhost:8888"` (or your Cloud URL).
3. Optional environment overrides (env wins over settings):
   - `HINDSIGHT_API_URL`, `HINDSIGHT_API_TOKEN` — connection
   - `HINDSIGHT_BANK_ID`, `HINDSIGHT_DYNAMIC_BANK_ID`, `HINDSIGHT_AGENT_NAME` — bank addressing
   - `HINDSIGHT_AUTO_RECALL`, `HINDSIGHT_AUTO_RETAIN`, `HINDSIGHT_RETAIN_MODE` — lifecycle
   - `HINDSIGHT_RECALL_BUDGET`, `HINDSIGHT_RECALL_MAX_TOKENS` — recall sizing
   - `HINDSIGHT_BANK_MISSION`, `HINDSIGHT_DEBUG`

Switching backends mid-session immediately replaces the live backend, memory tools, listeners, and system-prompt context. Existing users with `memories.enabled = true|false` are migrated to `memory.backend = "local"|"off"` exactly once on first launch; afterward, `memory.backend` is the sole runtime selector.
