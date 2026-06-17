# Tool-Surface Inventory & Feature-Budget Recommendation

> Decision-framing doc for the agent tool surface (review item #9). Data current as of v0.112.x.
> Keep the table in sync when tools are added/removed.

## TL;DR

SideCar ships **76 built-in agent tools** across 28 files in `src/agent/tools/`. The original review flagged this as feature sprawl threatening a small-team project. The data says the situation is **better than it looks** — two mitigations already exist:

1. **Config gating** — 22 tools are excluded from the LLM catalog entirely when their `sidecar.*.enabled` flag is off (`TOOL_REGISTRY` in [tools.ts](../src/agent/tools.ts) builds conditionally).
2. **Tier stubbing** — `getToolDefinitionsForTier('full', …)` sends non-core built-ins as one-line stubs (name + first sentence + `describe_tool` pointer) instead of full schemas, so extended tools cost ~1 line of catalog each.

The **remaining opportunity** is narrower: a cluster of ~17 *always-on, context-irrelevant* tools (Kickstand LoRA, database, GitHub-PR, academic) are listed in every session — including a default Ollama user editing TypeScript who will never use them. That's catalog noise a local model can still mis-select against, with no usage signal justifying it.

This is a **tuning** problem, not a sprawl crisis. Recommendation: relevance-gate that cluster (no feature loss), fix two small hygiene gaps, and adopt a lightweight feature-budget norm.

**Status (implemented):** relevance gating shipped for Kickstand/database/Zotero (11 tools, Tier A); GitHub-PR deferred (async signal). The two test gaps are closed (Tier C). See the tiers below for details.

## How the catalog is assembled

- [`TOOL_REGISTRY`](../src/agent/tools.ts) is a module-level `const`. Core tools spread unconditionally; 11 tool-groups spread conditionally on `getConfig().*Enabled`.
- `getToolDefinitions()` returns `TOOL_REGISTRY` defs + `spawn_agent`, plus `delegate_task` **only** when provider is anthropic/openai (the one runtime-relevance gate that exists today).
- `getToolDefinitionsForTier('full')` stubs extended built-ins; `'read'` returns only observation tools.
- **Caveat:** the config gating is evaluated **once at import**, so toggling a gated flag needs a window reload. All gated flags are marked `requiresWindowReload: true`, so this is consistent — but it means the gate is static, unlike the dynamic `delegate_task` gate.

## Inventory

### Core — always on, universally relevant (keep as-is): 28 tools
| Group | File | LOC | Tools |
|---|---|---|---|
| File ops | fs.ts | 700 | read/write/edit/delete_file, list_directory (5) |
| Search | search.ts | 206 | search_files, grep, find_references (3) |
| Shell | shell.ts | 274 | run_command, run_tests (2) |
| Git | git.ts | 495 | git_* (10) |
| Diagnostics | diagnostics.ts | 74 | get_diagnostics (1) |
| System monitor | systemMonitor.ts | 205 | system_monitor (1) |
| Project knowledge | projectKnowledge.ts | 146 | project_knowledge_search (1) |
| Knowledge | knowledge.ts | 139 | web_search, display_diagram (2) |
| Settings | settings.ts | 230 | get/update_setting, switch_backend (3) |
| Meta | tools.ts | — | ask_user, describe_tool, spawn_agent (3) |

### Always-on but context-specific — relevance-gating candidates: ~17 tools
| Group | File | Tools | Relevant only when… | Heavy deps |
|---|---|---|---|---|
| Kickstand LoRA | kickstand.ts | 3 | provider is Kickstand | — |
| Database | database.ts | 6 | a DB connection is configured | pg, mysql2 (bundled); duckdb, better-sqlite3 (external) |
| GitHub PR | github.ts | 5 | workspace has a GitHub remote w/ PRs | — |
| Academic | zotero.ts, pdf.ts, citation.ts | 5 | research/writing workflow | pdf-parse (external) |
| Viz | vizSpec.ts | 1 | diagram output wanted | mermaid (bundled) |

### Default-ON gated groups (in catalog unless disabled): 5 tools
`docTests` (3, default ON), `deps` (1, ON), `monorepo` (1, ON), `ci` (1, ON). Reasonable defaults; low noise.

### Default-OFF gated groups (excluded until enabled): 22 tools
`vision` (4), `notebook` (6), `research` (8), `profiling` (1), `latex` (1), `mcpDelegation` (1), `evalHistory` (1). **Correctly invisible by default** — these carry zero catalog cost for typical users. This is the sprawl mitigation working as intended.

## Recommendation

### Tier A — Relevance-gate the always-on niche cluster (highest value, no feature loss)
Extend the `delegate_task` provider-gate pattern to the context-specific cluster, so a tool is advertised only when it *could* apply. Implemented via `RELEVANCE_GATED_GROUPS` in [tools.ts](../src/agent/tools.ts) (synchronous config signals, null-safe):

- **Kickstand LoRA** (3) → ✅ included only when `detectProvider(...) === 'kickstand'`.
- **Database** (6) → ✅ included only when ≥1 profile is configured (`databaseProfiles.length > 0`).
- **Zotero** (2) → ✅ included only when Zotero credentials are set (`zoteroUserId` + `zoteroApiKey`).
- **GitHub PR** (5) → ⏸ **deferred.** Remote detection (`GitCLI.getRemoteUrl`) is async; gating it would force the synchronous catalog-assembly path async. The PR tools also degrade gracefully without a remote, so the cost/benefit doesn't justify the ripple yet.
- **pdf / citation** → intentionally left always-on (broadly useful, need no external setup).

Net effect: a default local-LLM coding session now sheds 11 catalog entries (Kickstand + database + Zotero) with no capability removed — each gate is reversible by configuring the relevant signal. Serves the local-first design goal: smaller models behave better with tighter tool lists, and it cuts per-call token cost on cloud backends.

### Tier B — Make the gate dynamic (consistency fix)
Move the config-conditional spreads out of the `TOOL_REGISTRY` module-const and into `getToolDefinitions()` (computed per call, like `delegate_task`). Removes the import-time freeze, lets toggles take effect without reload, and makes all gating consistent. Low risk, contained to `tools.ts`.

### Tier C — Hygiene & governance
- **Close the 2 test gaps:** ✅ done — `deps.ts` ([deps.test.ts](../src/agent/tools/deps.test.ts)) and `history.ts` ([history.test.ts](../src/agent/tools/history.test.ts)) now have co-located tests. Every tool file is now covered.
- **Feature-budget norm:** new always-on tools should justify universal relevance or ship gated/relevance-scoped by default. Niche additions default OFF.
- **Plugin question (longer-term):** the academic + research + notebook cluster (zotero/pdf/citation/notebook/research ≈ 22 tools, ~2,000 LOC) is the most self-contained, least-coding-centric surface. If/when usage telemetry exists and shows low adoption, it's the natural candidate to split into an optional companion extension rather than carry in core. Not actionable today — flagged so the decision is deliberate, not default.

## What NOT to do
- Don't delete features to reduce the count — the gating + stubbing infra already neutralizes most of the cost, and deletion is irreversible churn.
- Don't add a custom log-level/relevance config knob users must tune — relevance should be inferred from context (provider, repo, files), as Tier A does.
