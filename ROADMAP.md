# SideCar Roadmap

Planned improvements and features for SideCar. Audit findings from v0.34.0 comprehensive review are in the Audit Backlog section. All critical fixes were addressed in v0.35.0.

Last updated: 2026-04-16 (**v0.59.0 shipped — Sandbox primitives**. First release of the Release-Plan-driven v0.59+ roadmap. Agent `run_command` / `run_tests` now render live in a dedicated *SideCar Agent* terminal via VS Code's shell-integration API (transparency + SSH / Dev Container / WSL / Codespaces correctness). The new opt-in Shadow Workspace feature runs agent tasks in an ephemeral git worktree at `.sidecar/shadows/<task-id>/` so writes never touch the user's main tree until explicit accept. Also closes audit #13 + #15, a latent output-stomp bug in `ShellSession.checkSentinel`, and establishes a CI coverage ratchet. 1984 tests passing, +40 for the release.)

---

## Release Plan

Each release ships **1–2 features** plus a paired **refactor beat** (code-quality/architecture work aligned with the feature surface) and a **coverage focus** (testing work chosen to climb toward the 80/70/80/80 target). Audit findings (cycle-3) and Deferred items are folded into the release whose scope they naturally belong to. Anchor links below point to the full Feature Specifications later in this file.

**Release cadence assumption**: ~1 release every 1–2 weeks based on v0.52 → v0.58.1 pace. At that cadence v0.59 → v0.79 is ~5 months; v1.0 realistic by end of year.

**Coverage floor policy**: starting v0.59, CI enforces a monotonic coverage ratchet via `--coverage.thresholds`. PRs that drop any of the four metrics fail CI. New code ships with ≥80% coverage per-file by policy.

### v0.58.1 — Security patch ✅ *shipped 2026-04-16*
- Workspace-trust gates for `sidecar.scheduledTasks` (CRITICAL) and `sidecar.customTools` (HIGH)
- Deleted empty `src/chat/` directory
- Tag: [`v0.58.1`](https://github.com/nedonatelli/sidecar/releases/tag/v0.58.1)

### v0.59 — Sandbox primitives ✅ *shipped 2026-04-16*
- **Features shipped**: [Shadow Workspaces](#shadow-workspaces) (MVP — git worktree + cwd pinning + accept/reject via showQuickPick; per-hunk review UI, gate integration, shell-tool cwd pinning, symlinked build dirs, rebase-on-moved-main deferred to v0.60) · [Shell-Integrated Agent Command Execution](#shell-integrated-agent-command-execution) (full — runs through `terminal.shellIntegration.executeCommand` with ShellSession fallback)
- **Refactor beat shipped**: audit #13 + #15 closed, plus fixed a latent output-stomp bug in `ShellSession.checkSentinel` that was silently discarding accumulated bytes on any command with >200 chars of output.
- **Coverage ratchet shipped**: CI gate at 60/53/60/61; `*/types.ts`, `*/constants.ts`, `src/__mocks__/**`, `src/test/**`, `*.d.ts` excluded from the denominator.
- **Tag**: [`v0.59.0`](https://github.com/nedonatelli/sidecar/releases/tag/v0.59.0). +40 tests, 1984 total.

### v0.60 — Approval gates ✅ *shipped 2026-04-16*
- **Features shipped**: [Regression Guard Hooks](#regression-guard-hooks--declarative-post-edit-verification) (full — `sidecar.regressionGuards` entries fire on post-write / post-turn / pre-completion triggers through the existing `HookBus`; blocking guards inject synthetic user messages with stdout + exit, non-blocking guards surface via `callbacks.onText`; scope globs + per-guard attempt budget + global `strict`/`warn`/`off` mode + workspace-trust gate) · [Audit Mode](#audit-mode--virtual-fs-write-buffer-with-treeview-approval) (MVP — `sidecar.agentMode: 'audit'` buffers every `write_file`/`edit_file`/`delete_file` into an in-memory `AuditBuffer` with read-through; three review commands drive bulk accept/reject + per-file diff; atomic flush with rollback via `workspace.fs`. Per-file accept/reject, persistence across reloads, conflict detection, and git-commit buffering deferred to v0.61.)
- **Refactor beat shipped**: Secret redaction (`redactSecrets()` in `securityScanner.ts`) wired into hook + custom-tool env vars (audit finding #7). Hook + approval pattern unification (single abstract surface across Audit Buffer / Pending Changes / Regression Guard feedback) ***deferred to v0.61*** — all three currently use distinct UI patterns and unifying is a cross-cutting refactor that doesn't belong on v0.60's critical path.
- **Coverage ratchet shipped**: `src/review/` lifted from ~27% to 100/85.7/100/100 each. Aggregate 60.99 → 61.79 stmts · 53.37 → 54.06 branches · 61.11 → 61.80 funcs · 61.76 → 62.63 lines. CI ratchet bumped to 61/53/61/62.
- **Tag**: [`v0.60.0`](https://github.com/nedonatelli/sidecar/releases/tag/v0.60.0). +91 tests, 2075 total.

### v0.61 — Retrieval core ✅ *shipped 2026-04-16*
- **Features shipped**: [Project Knowledge Index](#project-knowledge-index--symbol-level-vectors--graph-fusion-in-an-on-disk-vector-db) (MVP — symbol-level `SymbolEmbeddingIndex` primitive, wired to the `SymbolIndexer` pipeline with debounced batch drain, new `project_knowledge_search` agent tool, graph-walk retrieval enrichment via `SymbolGraph.getCallers` with budget cap + decayed scoring. LanceDB backend, sidebar panel, Merkle fingerprint, and migration of `SemanticRetriever` to prefer the symbol index all deferred to v0.62.) · **Audit Mode Phase 2** — finishes the v0.60 MVP: per-file accept/reject in the review loop, conflict detection against mid-review disk edits, buffer persistence across extension reloads (with `Review` / `Discard` recovery prompt), and `git_commit` buffering end-to-end.
- **Refactor beat shipped**: PKI feature flag (`sidecar.projectKnowledge.enabled`, default `false` for opt-in preview), `ToolRuntime.symbolEmbeddings` wiring mirroring the existing `setSymbolGraph` pattern, persistence schema versioning (v1 → v2 envelope) with transparent migration. Embedding subsystem perf improvements (async reads, listener dispose, batch-size tuning per audit #4/#10) ***deferred to v0.62*** — the v0.61 scope was already large.
- **Coverage delta**: 61.79 → 61.79 (neutral; new code shipped with ≥90% per-file coverage as per policy, but denominator grew proportionally). No ratchet bump this release — next bump targets v0.62 once RAG-eval infrastructure ships.
- **Tag**: [`v0.61.0`](https://github.com/nedonatelli/sidecar/releases/tag/v0.61.0). +83 tests, 2158 total.

### v0.61 deferrals folded into v0.62+
- `SemanticRetriever` migration to symbol index (contingent on RAG-eval showing no regression)
- LanceDB HNSW backend behind `sidecar.projectKnowledge.backend: 'lance' | 'flat'`
- Merkle-addressed fingerprint (structural addressing layer)
- Project Knowledge sidebar panel (UI work → v0.63)
- Hook + approval pattern unification (carried from v0.60; now contingent on RAG-eval + UI design)
- `src/parsing/treeSitterAnalyzer.ts` coverage lift (originally planned as v0.61 focus; defer with the analyzer's PKI-adjacent work to v0.62)

### v0.62 — Retrieval quality ✅ *shipped 2026-04-17*
- **Features shipped**: [Merkle-Addressed Semantic Fingerprint](#merkle-addressed-semantic-fingerprint--keystroke-live-structural-index) (MVP — 3-level tree with SHA-256 leaf hashing + mean-pooled aggregated embeddings + query-time descent in `SymbolEmbeddingIndex.search`; keystroke-live updates via `setMerkleTree` hook that replays persisted state; `sidecar.merkleIndex.enabled` default `true`; blake3 adapter, directory-aware hierarchy, persistence, and live-root-snapshot log all deferred to v0.63+) · [RAG-Native Eval Metrics (RAGAs) + Qualitative LLM-as-Judge (G-Eval)](#rag-native-eval-metrics-ragas--qualitative-llm-as-judge-g-eval) (deterministic golden-case harness + `contextPrecisionAtK` / `contextRecallAtK` / `f1ScoreAtK` / `reciprocalRank` + CI ratchet at 0.45/0.95/0.55/0.90 against a 0.49/1.00/0.59/0.94 baseline; LLM-as-judge runs `Faithfulness` + `AnswerRelevancy` against every golden case under `npm run eval:llm`) · **PKI Phase 2** — v0.61 deferrals closed: `SemanticRetriever` prefers symbol-level hits when PKI is enabled (c.1); vector backend is abstracted behind a `VectorStore<M>` interface with `FlatVectorStore` implementation + `sidecar.projectKnowledge.backend: 'flat' | 'lance'` setting (c.2).
- **Refactor beat shipped**: Vector backend abstraction (`VectorStore` interface; flat impl today; Lance reserved). PKI retrieval migration (symbol index is now the retrieval default when enabled). `SymbolMetadata` on-disk schema gains optional `merkleHash` field with forward-compat replay. Retrieval infrastructure cleanup (cross-encoder reranker, per-source budget caps, fusion parallelization, `onToolOutput` backpressure) ***deferred to v0.63+*** — each stands alone and bundling them all into v0.62 would have blown past the release cadence.
- **Coverage delta**: +133 tests (2158 → 2291). Retrieval-eval CI ratchet now gates at 0.45/0.95/0.55/0.90. Coverage-ratchet bump to 70/62/69/70 (original v0.62 target) ***deferred to v0.63*** — the new code ships with ≥90% per-file coverage, but backend test harmonization across fireworks/groq/openai (the ROADMAP focus) didn't happen and that's where the backend-coverage work lives.
- **Tag**: [`v0.62.0`](https://github.com/nedonatelli/sidecar/releases/tag/v0.62.0). +133 tests, 2291 total.

### v0.62 deferrals folded into v0.63+
- PKI default-on (`sidecar.projectKnowledge.enabled: true`) — flip requires another release cycle of opt-in exposure.
- LanceDB HNSW backend — native-binding cross-platform project; Merkle descent gave us most of the speedup so the deferral is cheaper than originally sized.
- Project Knowledge sidebar panel — UI work (→ v0.63+).
- Cross-encoder reranker + per-source budget caps + fusion parallelization + `onToolOutput` backpressure — retrieval-infrastructure refactor beat carries.
- Hook + approval pattern unification — carried from v0.60 and v0.61. Still contingent on the third surface stabilizing.
- Blake3 hash algorithm — Merkle ships with SHA-256; blake3 adapter gated on a cross-platform-safe binding.
- Backend-coverage harmonization (fireworks/groq/openai) — original v0.62 coverage focus; carries as a v0.63 refactor beat.

### v0.63 — Skills core
- **Feature**: [First-Class Skills 2.0 — Typed Personas with Tool Allowlists, Preferred Models, and Composition](#first-class-skills-20--typed-personas-with-tool-allowlists-preferred-models-and-composition)
- **Refactor beat**: `executor.ts` god-function decomposition (audit #5) — split the 413-line `executeTool` into `executor/{approval,reviewMode,securityPipeline,diffPreview}.ts` following the `loop.ts` (v0.50) and `chatHandlers.ts` (v0.57) extraction pattern.
- **Coverage focus**: each newly-extracted `executor/*.ts` submodule ships with ≥80% coverage — testability is one of the decomposition's payoffs. Target ≥72/64/71/72.
- **Acceptance**: `allowed-tools` frontmatter enforced at runtime; `preferred-model` scoped `updateModel()` swap; skill stacking via `/with`; three scope modes (turn / task / session).

### v0.64 — Skills distribution + model routing
- **Features**: [Skill Sync & Registry](#skill-sync--registry--git-native-distribution-across-machines-and-projects) · [Role-Based Model Routing & Hot-Swap](#role-based-model-routing--hot-swap)
- **Refactor beat**: Backend abstraction maturity — unify retry / circuit-breaker / rate-limit / outbound-allowlist via a single `sidecarFetch` helper (audit #3). `npm outdated` review with focus on `@xenova/transformers` v2 → v3 migration (audit #18).
- **Coverage focus**: `kickstandBackend` (36.52% → ≥80%) · `hfSafetensorsImport` (0% → ≥80% via fs-mock pattern). Also add `settings.ts` decomposition (`config/settings/{backends,agent,completion,retrieval,security,telemetry}.ts`) to support Model Routing's new rules schema. Target ≥74/66/73/74.
- **Deferred folded in**: Provider `usage` response integration for MODEL_COSTS auto-update.
- **Acceptance**: `~/.sidecar/user-skills/` git-clone sync works across machines; `sidecar.modelRouting.rules` routes each dispatch role to the right model.

### v0.65 — Loop ergonomics (big test-hardening release)
- **Features**: [Steer Queue & Rich Interrupt UI](#steer-queue--rich-interrupt-ui) (extension of existing Human-in-the-Loop Steerability) · [Multi-File Edit Streams — DAG-Dispatched Parallel Writes](#multi-file-edit-streams--dag-dispatched-parallel-writes)
- **Refactor beat**: Loop subsystem test hardening — unit tests for all 14 `src/agent/loop/` helpers (audit #6), shared test-helper module (`src/__tests__/helpers/`) that bundles the `fs` / `os` / `workspace` / `child_process` mocks we keep rediscovering, bounded `SideCarClient._modelUsageLog` ring-buffer (audit #8).
- **Coverage focus**: the biggest single-release jump. `chatHandlers.ts` (19.63% — largest single-file gap even post-decomposition), `scheduler` / `eventHooks` / `lintFix` / `localWorker` / `inlineChatProvider` (audit #12). Target ≥78/68/77/78.
- **Deferred folded in**: `/resume` webview button affordance — pairs with the Steer Queue's new interrupt UI.
- **Acceptance**: FIFO steer queue with same-urgency coalescing; atomic multi-file edit DAG review; every `loop/*.ts` helper has branch-coverage tests; shared test-helper module in use across ≥5 test files.

### v0.66 — Facets
- **Feature**: [Typed Sub-Agent Facets & Expert Panel](#typed-sub-agent-facets--expert-panel)
- **Refactor beat**: Tool-registration DSL — collapse the ~300 lines of `{ definition, executor, requiresApproval }` boilerplate across 23+ tools into a decorator or fluent-builder pattern. Handler registry pattern for `webview/handlers/` — typed message-kind → handler map replaces the manual switch in `chatView.ts`.
- **Coverage focus**: webview handlers — `agentHandlers` · `githubHandlers` · `systemPrompt`. Facets UI touches all three. Target ≥80/70/79/80 — **enters the target band**.
- **Acceptance**: Expert Panel UI with multi-select facet dispatch; typed RPC across facets; each facet runs in its own Shadow Workspace.

### v0.67 — Fork & compare
- **Feature**: [Fork & Parallel Solve (Multi-Path Reasoning)](#fork--parallel-solve-multi-path-reasoning)
- **Refactor beat**: Parallel execution primitives extraction — shadow-worktree orchestration, `AbortSignal` propagation unification, shared cross-fork telemetry. Folds deferred *Anthropic Batch API for non-interactive workloads* as the batching substrate for parallel-fork dispatch.
- **Coverage focus**: `src/terminal/errorWatcher.ts` (34.84% → ≥80%) — Shell unification from v0.59 left branches untouched. Maintain ≥80/70/80/80.
- **Acceptance**: `/fork <task>` spawns N parallel approaches with side-by-side review; Hybrid hunk-picking across forks; per-fork metrics table (LOC / tests / benchmarks / guards).

### v0.68 — Reasoning
- **Feature**: [Advanced Thinking Visualization & Depth Control](#advanced-thinking-visualization--depth-control)
- **Refactor beat**: `ollama/types.ts` split into domain modules: `types/{messages,tools,streaming,usage}.ts` — has grown organically into 300+ lines of mixed concerns.
- **Coverage focus**: steady ≥80/70/80/80 drumbeat; opportunistic backfill of paths the feature touches.
- **Acceptance**: Live Thinking Panel with four modes (single / self-debate / tree-of-thought / red-team); steerable mid-stream via the Steer Queue; persistent traces at `.sidecar/thinking/<task-id>.md` with `/replay`.

### v0.69 — Native VS Code integration
- **Features**: [`@sidecar` Native Chat Participant](#sidecar-native-chat-participant) · [Zero-Latency Local Autocomplete via Speculative Decoding](#zero-latency-local-autocomplete-via-speculative-decoding)
- **Refactor beat**: FIM + completion subsystem cleanup — draft-model plumbing, `InlineCompletionProvider` consolidation, `completeFIM` signature normalization across backends.
- **Coverage focus**: `src/completions/provider.ts` + `src/ollama/client.ts completeFIM` path. Maintain ≥80/70/80/80.
- **Acceptance**: `@sidecar` registered as a first-class VS Code chat participant with slash-command parity (`/review`, `/commit-message`, etc.); SideCar backends exposed as `LanguageModelChat` providers for other participants to consume; speculative decoding delivers measured 2–4× tok/s on supported model pairs.

### v0.70 — Live awareness
- **Features**: [Live Diagnostic Subscription & Reactive Fixer](#live-diagnostic-subscription--reactive-fixer) · [Inline Code Visualization Dashboards (MCP-backed)](#inline-code-visualization-dashboards-mcp-backed)
- **Refactor beat**: Diagnostics push/pull abstraction — unify the existing `get_diagnostics` pull tool with the new `onDidChangeDiagnostics` subscription behind one provider. Eval-harness gap closure: auto-fix and critic paths (deferred from v0.50.0) get their required mocks and land in the llm-eval suite.
- **Coverage focus**: diagnostics + auto-fix + critic paths. Maintain ≥80/70/80/80.
- **Acceptance**: Push-based diagnostic subscription with reactive fix loop gated by Shadow Workspace; interactive `VizSpec` dashboard rendering in the chat panel under diffs.

### v0.71 — Jupyter notebooks
- **Feature**: [First-Class Jupyter Notebook Support](#first-class-jupyter-notebook-support)
- **Refactor beat**: File-type plugin architecture — generalized cell/segment-aware handling the notebook work introduces can be reused by ERD entities (v0.77), source chunks (v0.72), tutorial walkthroughs.
- **Coverage focus**: 8 new cell-aware tools; roundtrip-fidelity property tests (500 fuzz notebooks). Maintain ≥80/70/80/80.
- **Acceptance**: `read_notebook` / `edit_notebook_cell` / `run_notebook_cell` etc. via native `NotebookEdit` API; cell-granular diff tiles in Pending Changes; auto-bridge cell outputs to Visual Verification.

### v0.72 — Literature
- **Feature**: [Literature Synthesis & PDF/Zotero Bridge](#literature-synthesis--pdfzotero-bridge)
- **Refactor beat**: Source-backend abstraction — shared PDF / YouTube / Web / audio source plumbing (prepares the v0.79 NotebookLM Mode expansion).
- **Coverage focus**: source indexer pipeline. Maintain ≥80/70/80/80.
- **Acceptance**: PDF indexing via `pdf-parse`; Zotero SQLite read-through; citation insertion respecting document style.

### v0.73 — Database integration (safe core)
- **Feature**: [First-Class Database Integration (SQL + NoSQL)](#first-class-database-integration-sql--nosql) — Tier 1 only (read-only query + introspection)
- **Refactor beat**: `DatabaseProvider` abstraction mirroring `ApiBackend` anticorruption layer.
- **Coverage focus**: `DatabaseProvider` drivers (SQLite / Postgres / MySQL / DuckDB). Maintain ≥80/70/80/80.
- **Acceptance**: `db_list_tables` / `db_describe_table` / `db_query` work against four dialects with parameterized queries + hard timeouts; results render as sortable tables in the chat panel.

### v0.74 — Visual verification
- **Feature**: [Browser-Agent Live Preview Verification (Screenshot-in-the-Loop)](#browser-agent-live-preview-verification-screenshot-in-the-loop)
- **Refactor beat**: Integration-layer maturity — share the Playwright MCP client between visual-verification and the Browser-Automation integration entry.
- **Coverage focus**: Playwright tool wrappers + VLM-verdict pipeline. Maintain ≥80/70/80/80.
- **Acceptance**: `screenshot_page` + `analyze_screenshot` + cheap-deterministic pre-filter loop delivers visual self-correction on a matplotlib FIR plot scenario end-to-end.

### v0.75 — Research Assistant
- **Feature**: [Research Assistant — Structured Lab Notebook, Experiment Manifests, and Hypothesis Graph](#research-assistant--structured-lab-notebook-experiment-manifests-and-hypothesis-graph)
- **Refactor beat**: Integration-layer maturity — `.sidecar/research/` store, hypothesis-graph data model, experiment-manifest reproducibility harness.
- **Coverage focus**: new research tools + reproducibility harness. Maintain ≥80/70/80/80.
- **Acceptance**: `/experiment run` reproduces against pinned git SHA + requirements hash; hypothesis graph renders; reviewer-simulation personas ship.

### v0.76 — Doc-to-Test
- **Feature**: [Doc-to-Test Synthesis Loop](#doc-to-test-synthesis-loop)
- **Refactor beat**: Constraint-extraction infrastructure shared with the Literature + Research Assistant layers.
- **Coverage focus**: constraint extractor + test synthesis templates. Maintain ≥80/70/80/80.
- **Acceptance**: A source paper's mathematical identities become `pytest` tests that fail when the implementation doesn't satisfy them; Doc/Impl Mismatch review classifies failures and proposes fixes.

### v0.77 — Database integration (writes + migrations)
- **Feature**: [Database Integration Tier 2](#first-class-database-integration-sql--nosql) — writes routed through Audit Mode + ORM-aware migrations (Prisma / TypeORM / Sequelize / Alembic / Flyway / Knex / Rails)
- **Acceptance**: `db_execute` writes buffer in Audit treeview; `db_migrate_up` runs migrations inside a DuckDB-backed shadow DB before touching the real one.

### v0.78 — Database integration (NoSQL via MCP)
- **Feature**: [Database Integration Tier 3](#first-class-database-integration-sql--nosql) — MongoDB / Redis / DynamoDB / Cassandra / Elasticsearch as `mcp-sidecar-<engine>` servers
- **Acceptance**: At least the Mongo + Redis servers ship with install paths in the MCP marketplace entry.

### v0.79 — NotebookLM parity
- **Feature**: [NotebookLM-Style Source-Grounded Research Mode](#notebooklm-style-source-grounded-research-mode)
- **Acceptance**: `/notebook` mode enters source-grounded state with mandatory inline citations; YouTube / web URL / audio / slides sources index alongside PDFs; five study-aid generators emit tracked markdown; opt-in two-voice podcast pipeline ships.

### v1.0 — GA
- **Final decompositions**: `src/extension.ts` (987 lines — audit #16) · `stubCheck` async patterns (audit #17) · `package.json` command descriptions sweep (audit #14) · `chatView.ts` decomposition unlocks its 0% → coverage uplift
- **Unused-export sweep**: audit of every `export` in `src/` for actual consumers; drop what's dead
- **CLAUDE.md refresh**: sync architectural notes against the post-v0.79 reality
- **Acceptance**: Coverage ≥80/70/80/80 sustained across all four metrics; public marketplace for Skill Sync & Registry (v0.64) goes live.

### Unscheduled / Vision Shelf
Kept for future consideration — not promised to any specific release. See *Deferred* section below for brief rationale on each.

- Semantic Time Travel · GPU-Native Hot-Swapping · GPU-Aware Load Balancing · Memory Guardrails · Multi-repo cross-talk · Semantic Agentic Search for Monorepos · Auto Mode · Next Edit Suggestions · Adaptive Paste · Selective Regeneration · Persistent Executive Function · LaTeX Agentic Debugging · Integrated LaTeX Preview & Compilation · Inline Edit Enhancement · Zen Mode Context Filtering · Dependency Drift Alerts · Most Enterprise & Collaboration entries · Voice Input · `@sidecar/sdk` Extension API · MCP Marketplace · Agentic Task Delegation via MCP · Model Comparison / Arena Mode · Real-time Code Profiling · Bitbucket/Atlassian integration · `maxCharsPerTurn` as a SideCarConfig setting (pending demand)

---

## Cross-Cutting Refactor Themes

Three themes span multiple releases and are worth tracking at the roadmap level, not buried inside release notes.

### Theme 1 — God-module decomposition

Single-responsibility extraction for files over ~700 lines, using the same pattern each time: extract helpers to a subdirectory, bundle shared state, keep re-exports for backward-compat, verify with a full test+eval pass.

| File | Size | Status |
|---|---|---|
| `tools.ts` | was ~1,200 lines | ✅ decomposed in v0.47 |
| `loop.ts` | was 1,216 lines → 255 lines | ✅ decomposed in v0.50 |
| `chatHandlers.ts` | was 1,955 lines → 770 lines | ✅ decomposed in v0.57 |
| `executor.ts` | 413-line `executeTool` in a ~900-line file | 🔜 v0.63 |
| `settings.ts` | large and growing with each feature | 🔜 v0.64 |
| `extension.ts` | 987 lines | 🔜 v1.0 |
| `chatView.ts` | 695 lines, currently 0% coverage | 🔜 v1.0 (decomposition unlocks testability) |

### Theme 2 — Test-surface hardening

Shared mocks for `fs` / `os` / `workspace` / `child_process`; branch coverage for decomposed subsystems; eval harness expansion for fuzzy paths; CI ratchet preventing coverage regressions.

| Track | Status / target |
|---|---|
| 3 host-dependent bugs closed | ✅ v0.58.0 (kickstand token × 2, `fs.statfsSync`) |
| CI coverage ratchet | 🔜 v0.59 |
| Shared test-helper module | 🔜 v0.65 |
| Unit coverage for `src/agent/loop/` helpers (14 files, 3 covered today) | 🔜 v0.65 |
| Eval harness: retriever fusion / cost warning / summarizer cap fixtures | 🔜 v0.62 |
| Eval harness: auto-fix + critic paths | 🔜 v0.70 |
| Subsystem unit tests (scheduler · eventHooks · lintFix · localWorker · inlineChatProvider) | 🔜 v0.65 |

### Theme 3 — Boilerplate reduction

Collapse duplicated plumbing: tool registration, backend retry/breaker/rate-limit, content-block types, shell execution paths.

| Track | Status / target |
|---|---|
| Shell execution unification (`ShellSession` / `run_command` / `TerminalErrorWatcher` / execAsync) | 🔜 v0.59 |
| Backend abstraction maturity (`sidecarFetch` with shared retry / breaker / rate-limit / allowlist) | 🔜 v0.64 |
| Tool-registration DSL (replace `{ definition, executor, requiresApproval }` triples) | 🔜 v0.66 |
| Handler registry pattern (webview/handlers typed-message-kind → handler map) | 🔜 v0.66 |
| `ollama/types.ts` split into `types/{messages,tools,streaming,usage}.ts` | 🔜 v0.68 |
| `settings.ts` split into domain modules | 🔜 v0.64 |

---

## Coverage Plan

**Current (v0.62.0)**: +133 tests for v0.62 (PKI Phase 2 + RAG-eval arc + Merkle arc), 2291 tests / 142 files. Aggregate coverage ratchet still at 61/53/61/62 — no bump this release; backend-coverage harmonization that would have driven it up was deferred to v0.63. The new RAG-eval ratchet is a parallel gate: retrieval quality is pinned at `meanPrecisionAtK ≥ 0.45`, `meanRecallAtK ≥ 0.95`, `meanF1AtK ≥ 0.55`, `meanReciprocalRank ≥ 0.90` against a baseline of 0.49/1.00/0.59/0.94. (v0.61 baseline: 61.79/54.06/61.80/62.63 / 2158 tests.)

**Target**: 80% stmts · 70% branches · 80% funcs · 80% lines (the 80/70/80/80 split reflects that branch coverage is harder to pay for — error paths, concurrent races, partial failures — so it carries a lower bar).

### Per-release coverage targets

| Release | Target (stmts/branch/funcs/lines) | Expected delta | Focus |
|---|---|---|---|
| v0.59 | ≥63/55/62/63 | +1–2 pp (mostly "free" from `*/types.ts` exclusion) | CI ratchet setup |
| v0.60 | ≥65/57/64/65 | +2 pp | `src/review/` |
| v0.61 | ≥67/59/66/67 | +2 pp | `parsing/treeSitterAnalyzer.ts` (0% → ≥80%) |
| v0.62 | ≥70/62/69/70 | +3 pp | backends (fireworks/groq/openai) |
| v0.63 | ≥72/64/71/72 | +2 pp | executor/ decomposition |
| v0.64 | ≥74/66/73/74 | +2 pp | kickstandBackend + hfSafetensorsImport |
| v0.65 | ≥78/68/77/78 | +4 pp — biggest single-release jump | loop/ helpers + chatHandlers + subsystems |
| v0.66 | ≥80/70/79/80 | +2 pp | webview handlers |
| v0.67 | ≥80/70/80/80 — **target band hit** | +0–1 pp | terminal/errorWatcher |
| v0.68–v0.79 | steady ≥80/70/80/80 | maintenance | opportunistic per feature |
| v1.0 | sustained ≥80/70/80/80 | final lift | `chatView.ts` decomposition + `extension.ts` |

### Enforcement mechanisms

1. **CI ratchet** (v0.59): `vitest run --coverage.thresholds.stmts=62 --branches=54 --funcs=61 --lines=62` with thresholds bumped every release. Drops fail CI.
2. **New-code policy** (v0.59): every new file lands with ≥80% coverage by policy; per-PR coverage-diff check in CI (codecov-style) blocks merges that add uncovered code.
3. **Denominator hygiene** (v0.59): exclude `*/types.ts`, `*/constants.ts`, `src/__mocks__/**` from coverage — structural, not behavioral.
4. **Quarterly coverage-gap triage**: review remaining zero-coverage files with explicit decision per file — "test it" / "refactor-then-test" / "exclude with rationale in `vitest.config.ts`".
5. **Branch coverage deserves its own attention**: 53.51% branches is the worst current metric. Error-path coverage gaps hide real bugs. Every new test suite deliberately covers the error branches, not just happy paths.

---

## Feature Specifications

Detailed specifications for every entry in the release plan above. Each entry describes the problem, the mechanism, integration points with other roadmap items, and the configuration surface. Organized thematically for reading coherence; navigate from the Release Plan via the anchor links above.

### Context & Intelligence

- **Multi-repo cross-talk** — impact analysis across dependent repositories via cross-repo symbol registry
- **Semantic Agentic Search for Monorepos** — cross-repository memory backed by a dedicated MCP server that indexes multiple local folders simultaneously into a unified vector store. The agent can answer questions like "does the algorithm in `repo-a` match the implementation in `repo-b`?" by running a semantic diff across both indices, surfacing divergences, stale copies, and interface mismatches in a single response. Each root is indexed independently so adding or removing a repo doesn't invalidate the others. Configured via `sidecar.monorepoRoots` (array of absolute paths) and exposed as a `search_repos` tool the agent calls automatically when a prompt references multiple packages. A *Repo Index* status-bar item shows live indexing progress per root.
- **Memory Guardrails** — vector-based permanent context pinning. A dedicated UI section lets users lock specific documents (chapters, papers, specs) into the agent's long-term memory so they survive context compaction and are always fused back in via RRF regardless of relevance score. Prevents core theory from being evicted while the agent is focused on a minor bug fix. Pinned entries are stored in `.sidecar/memory/` as chunked embeddings and surfaced in a new *Pinned Memory* panel in the sidebar.

- **Project Knowledge Index — Symbol-Level Vectors + Graph Fusion in an On-Disk Vector DB** — upgrades the shipped [EmbeddingIndex](src/config/embeddingIndex.ts) (which today stores one 384-dim `all-MiniLM-L6-v2` vector per file in a flat `Float32Array` at `.sidecar/cache/embeddings.bin` with a JSON metadata sidecar and a linear cosine scan at query time) into a Pro-grade codebase intelligence layer that stays entirely on disk, answers global questions, and models relationships — not just text matches. The gap this closes is best illustrated by the canonical repo-awareness question "where is the auth logic handled?": the current flat index returns files whose text happens to mention "auth" somewhere, which usually means the middleware file is found but the routes that *use* it without saying "auth" are missed, and on a 10k-file repo the linear scan is slow enough to be noticeable. Copilot Pro answers this well because it indexes at symbol granularity and understands the call graph; this entry brings the same capability on-disk and local-first. **Three layered changes**: (1) **Proper on-disk vector store** via embedded **LanceDB** — a Rust-native columnar vector DB with a Node binding, HNSW indexes for sub-ms ANN over millions of vectors, metadata filtering (query "auth" only inside `src/middleware/**`), atomic writes, and zero external processes to manage. LanceDB is chosen over ChromaDB because Chroma's Node support goes through a Python subprocess, which is a deployment footgun in a VS Code extension; LanceDB ships as a single `.node` binary with no runtime dependencies. Storage lives at `.sidecar/cache/lance/` (already covered by the gitignored-subdirs carve-out). (2) **Symbol-level chunking** replaces one-vector-per-file — every function, class, method, interface, and significant top-level comment block becomes its own indexed chunk. The existing [symbolGraph.ts](src/config/symbolGraph.ts) already runs tree-sitter over the workspace and knows symbol boundaries, so it becomes the chunker: each `SymbolNode` produces one vector from its body text plus docstring, tagged with `{ filePath, range, kind, name, containerSymbol, hash }`. Granularity goes from thousands of file-vectors to hundreds of thousands of symbol-vectors; retrieval returns the specific function, not the whole file. (3) **Graph-walk retrieval** closes the "middleware vs routes" gap — after the initial vector hit, the retriever walks the symbol graph's typed edges (`defines`, `calls`, `imports`, `used-by`) up to `sidecar.projectKnowledge.graphWalkDepth` (default `2`) and surfaces symbols reachable from the hit even when their text doesn't match the query. So "where is auth handled?" retrieves `requireAuth` middleware via vector similarity, then walks the `used-by` edges to return every route handler that wraps it — without those routes needing to say the word "auth." The walk is budgeted (breadth-first up to `maxGraphHits`, default `10`) so a popular symbol like `logger.info` can't drown the result list. **Incremental updates**: VS Code's `onDidChangeTextDocument` / `onDidCreateFiles` / `onDidDeleteFiles` / `onDidRenameFiles` events drive re-embedding of only the *changed* symbols (not the whole file), resolved by content-hashing each symbol's body — unchanged symbols keep their cached vectors so a one-line edit in a 2000-line file costs one re-embed, not 200. Rename events move the vector metadata instead of re-embedding. A background queue with 500ms debounce + 30s persist-to-disk matches the existing pattern at [embeddingIndex.ts:24-25](src/config/embeddingIndex.ts#L24-L25). **New agent tool**: `project_knowledge_search(query, { maxHits?, graphWalkDepth?, kindFilter?, pathGlob? })` returns structured `{ symbol, filePath, range, score, relationship }[]` with `relationship` tagging whether each hit was a direct vector match or reached via graph walk (`"vector: 0.82"`, `"graph: used-by → 2 hops from requireAuth"`), so the model sees *why* each result surfaced and can weight accordingly. **Migration from the flat index is transparent**: on first activation with the new backend, the existing `.sidecar/cache/embeddings.bin` is read, re-chunked to symbol-level, and ingested into LanceDB; the old file is kept for one version as a rollback safety net, then deleted. **UI**: a *Project Knowledge* sidebar panel shows index health (symbols indexed, last update time, vector count, disk footprint), a rebuild-from-scratch button for pathological cache states, and a search box that exposes the same `project_knowledge_search` tool for the user to query interactively. **Composes with every earlier retrieval entry**: SemanticRetriever in the fusion pipeline now queries symbols rather than files (hits are smaller and more precise, so RRF competes them more fairly against doc and memory hits); Semantic Time Travel uses per-commit LanceDB snapshots at `.sidecar/cache/lance/history/<sha>/`; Memory Guardrails pins entries go in the same store with a `pinned: true` metadata flag and a filter that always includes them regardless of score; the Semantic Agentic Search for Monorepos entry becomes "N LanceDB tables queried in parallel" — same code path, different roots. Configured via `sidecar.projectKnowledge.enabled` (default `true`), `sidecar.projectKnowledge.backend` (`lance` | `flat`, default `lance`; `flat` preserves the current behavior for users on constrained platforms where the native binding won't load), `sidecar.projectKnowledge.chunking` (`symbol` | `file`, default `symbol`), `sidecar.projectKnowledge.graphWalkDepth` (default `2`), `sidecar.projectKnowledge.maxGraphHits` (default `10`), `sidecar.projectKnowledge.indexPath` (default `.sidecar/cache/lance/`), `sidecar.projectKnowledge.maxSymbolsPerFile` (default `500` — guard against generated files with 50k symbols), and `sidecar.projectKnowledge.embedOnSave` (default `true`; set `false` for manual rebuild only).

  ```mermaid
  flowchart TD
      Q[Query: 'where is auth handled?'] --> E[Embed query<br/>all-MiniLM-L6-v2]
      E --> ANN[LanceDB HNSW search<br/>sub-ms ANN over<br/>symbol vectors]
      ANN --> V[Vector hits<br/>e.g. requireAuth middleware]
      V --> GW{Graph walk<br/>depth ≤ 2}
      GW -->|used-by edges| R1[Route handlers<br/>wrapping requireAuth]
      GW -->|calls edges| R2[Called helpers<br/>verifyToken, etc.]
      GW -->|imports edges| R3[Modules importing<br/>the middleware]
      V & R1 & R2 & R3 --> RANK[Rank + tag by<br/>relationship path]
      RANK --> OUT[Structured hits:<br/>symbol, filePath, range,<br/>score, relationship]

      subgraph Updates
          W[onDidChangeTextDocument] --> H[Hash changed symbols]
          H --> D{Diff vs cached}
          D -->|changed| RE[Re-embed only<br/>changed symbols]
          D -->|unchanged| SKIP[Keep cached vector]
          RE --> UP[Atomic upsert<br/>to LanceDB]
      end
  ```

- **Merkle-Addressed Semantic Fingerprint — Keystroke-Live Structural Index** — layers a content-addressed Merkle tree over the Project Knowledge Index so change detection, integrity verification, and sync across sessions/machines become O(log n) instead of O(n), and re-embedding on a per-file save compresses to re-hashing on a per-keystroke basis with no latency cost. Current state honestly: [EmbeddingIndex](src/config/embeddingIndex.ts) runs a 500ms debounced incremental update on `onDidChangeTextDocument`, re-embeds the whole file each time, persists as a flat binary every 30s. Works, but two things fall out of this: (a) large monorepos pay an index-walk cost for every query because there's no hierarchy to prune with, and (b) "what changed since you were last here?" requires re-hashing everything because nothing is addressed structurally. This entry adds a Merkle layer that makes both of those sub-linear. **The structure**: every symbol-level chunk (already the granularity proposed in Project Knowledge Index) becomes a Merkle leaf with a content hash `blake3(body ‖ path ‖ kind ‖ range)` and its embedding as leaf metadata. Interior nodes aggregate their children's hashes (`blake3(child1 ‖ child2 ‖ …)`) and also carry a *mean-pooled aggregated embedding* of their subtree, so the retriever can score whole subtrees at the interior level and skip them entirely without touching the leaves. The root hash is the repository's *semantic fingerprint* — a single 32-byte string that changes iff any symbol in the workspace changed. **Keystroke-live updates**: VS Code's `onDidChangeTextDocument` fires on every edit with the modified ranges; the Merkle layer intercepts this and does the cheap work (re-hashing the containing symbol's leaf, then the O(log n) parent chain up to the root) on every keystroke with no debounce — blake3 is fast enough that a 100-file-deep hash walk finishes in well under a millisecond. The *expensive* work (re-embedding) stays on a 300ms debounce because embedding is what actually takes ~20-50ms per chunk on-device — so the Merkle state is always current, the embedding state is eventually consistent within ~300ms, and the retriever can distinguish "this subtree is stale" (hash changed but embed hasn't caught up — score with last-known embed, flag as `stale: true` for honest UX) from "this subtree is fresh." **Where the latency comes from on a large monorepo** — at query time the retriever walks *down* the tree: compute query embedding, compare against each of the root's direct children's aggregated embeddings, descend into the top-k subtrees, recurse. A workspace with 500k symbols becomes ~20 interior-level comparisons to narrow down to the top ~2k leaves, then an HNSW ANN search over those 2k (sub-ms in LanceDB). Total end-to-end latency: ~10–30ms on typical hardware even against a million-symbol index, which is the regime where "find that function three folders away" starts to feel instant rather than noticeable. **Cache validity and sync** become trivial byproducts of the root hash: on startup, SideCar recomputes the root over the current disk state (fast — just content hashes, no embeddings) and compares to the cached root; if they match, the whole index is reused as-is (no rebuild); if they differ, a tree walk finds exactly the changed subtrees and only those are re-embedded. The same mechanism gives cross-machine parity at trivial cost — Multi-User Agent Shadows' `shadow.json` can include the Merkle root, so a teammate's instance verifies index alignment in one 32-byte comparison and requests only the diff subtrees if misaligned. For Semantic Time Travel per-commit snapshots, unchanged subtrees dedup automatically (two commits that differ only in `src/utils/foo.ts` share every other subtree hash and therefore every other subtree's cached embeddings) — a git-like compression ratio on the snapshot store without any custom encoding work. **Lineage queries** (`/diff-since <commit-or-timestamp>`) become a Merkle diff: two roots, descend into subtrees whose hashes differ, return the symbol-level changes — answerable in O(differences) rather than O(repo size), which is what makes "what changed since I was last here?" feel instant in sessions that span weeks. **~200-272k token context-window utilization**: a frontier-model context window of this size is big enough to fit a small project outright, but for a 500k-symbol monorepo even 272k tokens is maybe 2% of the repo by token count, so the retriever's job is to pick the 2% that matters. Merkle-addressed aggregated embeddings at interior nodes let the retriever select the most relevant subtrees first and materialize exactly as many as the context budget allows, with provably correct "you got the top-k subtrees for your budget" semantics rather than the current best-effort flat scan. Near-zero latency doesn't come from precomputation alone — it comes from *not having to walk most of the tree per query*. **Storage layout** (`.sidecar/cache/merkle/`, covered by the gitignored-subdirs carve-out): `tree.bin` for the structure (parent/child pointers + hashes, mmapped), `embeddings.lance/` for leaf and interior-node vectors (the same LanceDB store from Project Knowledge Index, now with an extra `level: 0|1|2|…` metadata column for interior-node rows), `roots.log` for an append-only history of root hashes with timestamps so time-travel queries work without keeping full per-commit trees. Live root hash persists to `roots.log` every `sidecar.merkleIndex.rootSnapshotEveryMs` (default `10000`, 10s) so a crash loses at most that interval of lineage data — the Merkle state itself is rebuildable from disk in ~seconds for any repo size. **Integration with every earlier entry**: Project Knowledge Index becomes the *similarity* layer and Merkle becomes the *addressing* layer (they compose — Merkle narrows candidate subtrees, LanceDB HNSW ranks within them); Semantic Time Travel stores per-commit roots instead of per-commit full indexes (dedup-heavy; a 500-commit history costs ~the same as 10 if the churn is low); Multi-User Agent Shadows syncs Merkle roots in `shadow.json` for team index parity; Fork & Parallel Solve shows root-diff between forks as a structural summary of "what did each fork actually change" alongside the file diff; Model Routing can gate on change velocity (symbols under a high-churn subtree escalate to a more thorough model); Regression Guards can be targeted by subtree (a physics guard only fires when the touched symbols' Merkle path contains `src/physics/**`). Configured via `sidecar.merkleIndex.enabled` (default `true` when Project Knowledge is enabled — they're architecturally coupled), `sidecar.merkleIndex.hashAlgorithm` (`blake3` default for speed, `sha256` fallback for environments without a blake3 binding), `sidecar.merkleIndex.liveUpdates` (default `true` — hash on keystroke; set `false` to match the current 500ms-debounce-on-save behavior), `sidecar.merkleIndex.rootSnapshotEveryMs` (default `10000`), `sidecar.merkleIndex.aggregationStrategy` (`mean-pool` | `max-pool` | `attention-pool`, default `mean-pool` — `attention-pool` is future work needing a trained head; mean-pool is the boring-and-correct default), and `sidecar.merkleIndex.maxSymbolsForLiveHash` (default `50000` — above this, fall back to debounced updates even in live mode because keystroke-rate hashing of a 500k-leaf tree becomes non-trivial even at blake3 speeds).

  ```mermaid
  flowchart TD
      subgraph Tree ["Merkle tree of symbols"]
          R["Root hash<br/>blake3 + mean-pooled<br/>aggregated embedding"]
          R --> S1["Subtree src/<br/>hash + agg-embed"]
          R --> S2["Subtree tests/<br/>hash + agg-embed"]
          S1 --> F1["File hash<br/>agg of symbols"]
          S1 --> F2["File hash<br/>agg of symbols"]
          F1 --> L1["Leaf: function authN<br/>content hash +<br/>384-dim embedding"]
          F1 --> L2["Leaf: class AuthMiddleware<br/>..."]
      end
      K[User keystroke] --> UL[Re-hash modified leaf]
      UL --> UP[Walk up O(log n)<br/>update ancestor hashes]
      UP --> R
      UL -.debounced 300ms.-> EM[Re-embed leaf]
      EM --> AGG[Recompute aggregated<br/>embeddings on ancestor path]

      subgraph Query ["Query path"]
          Q[Query embedding] --> QR[Compare vs root's<br/>direct children]
          QR --> DESC[Descend top-k subtrees]
          DESC --> HNSW[HNSW ANN<br/>over narrowed leaves]
          HNSW --> HITS[Ranked symbol hits]
      end
  ```

### Editing & Code Quality

- **Next edit suggestions (NES)** — predict next logical edit location after a change using symbol graph ripple analysis
- **Inline edit enhancement** — extend ghost text to `write_file`, batch edits, syntax highlighting
- **Selective regeneration** — "pin and regen" UI: lock good sections, regenerate only unlocked portions
- **Adaptive paste** — intercept paste events and auto-refactor to match local naming, imports, and conventions

- **Multi-File Edit Streams — DAG-Dispatched Parallel Writes** — closes the Copilot-free-vs-Pro gap on wide refactors by letting the agent stream changes across N files at once instead of serializing them one at a time. The current loop already batches multiple `tool_use` blocks within a single assistant turn (the model can emit `write_file src/a.ts` + `write_file src/b.ts` in one message and `executeToolUses` dispatches them together), but two gaps stop this from feeling like Pro-grade multi-file editing: (1) the agent rarely *plans* a multi-file edit up front — it tends to edit one file, wait to see the result, then decide the next edit, which serializes execution even when the edits are logically independent; and (2) the UI streams one diff preview at a time rather than N in parallel, so even batched writes feel sequential to the user. This entry addresses both. **Up-front edit planning**: when a task is large enough (`sidecar.multiFileEdits.minFilesForPlan`, default `3`), the loop inserts a mandatory *Edit Plan* pass before any `write_file` fires. The planner agent produces a typed manifest — `EditPlan { edits: { path, op: 'create' | 'edit' | 'delete', rationale, dependsOn: path[] }[] }` — and the runtime builds a DAG from the `dependsOn` edges. Independent nodes run in parallel up to `sidecar.multiFileEdits.maxParallel` (default `8`); edits with dependencies wait for their prerequisites (rename a symbol's definition before editing the call sites). The plan surfaces in the chat UI as a collapsible *Planned edits* card the user can inspect — and amend via Steer Queue nudges like "skip src/legacy/**, I'll do those manually" — before execution starts, so the scope is transparent up front instead of discovered one file at a time. **Parallel streaming diff previews**: the webview's existing `streamingDiffPreviewFn` path is extended to handle N concurrent streams. A *Pending Changes* panel tile renders per in-flight file with its own live diff, chars-streamed progress bar, and per-file abort button; on an 8-wide edit the user sees all eight files populate simultaneously rather than watching them tick through one by one. **Conflict detection at plan time, not write time** — the DAG builder rejects plans with two `edit` ops targeting the same file (merged into one op with combined rationale) or with circular dependencies (the planner is asked to revise once, then surfaced as an error). **Atomic review semantics**: by default, the Pending Changes panel treats a multi-file plan as a single *unit of work* — accepting one file without the others can leave the codebase in a broken intermediate state (renamed definition + unrenamed call sites), so the default is accept-all or reject-all. Two escapes: `sidecar.multiFileEdits.reviewGranularity` set to `per-file` exposes individual file checkboxes for advanced users who want surgical control, and `per-hunk` drops down to hunk-level even across files. **Integration with every earlier feature**: all N streams land in the Shadow Workspace, so the main tree sees only the final bulk merge regardless of how many files are in flight; Regression Guards fire once against the full edit set rather than per-file, which is often what the user actually wants (a guard that only makes sense after the whole rename is done shouldn't fail N−1 times during intermediate states); Audit Mode's treeview shows N parallel buffered writes with per-file checkboxes matching the same granularity setting; Fork & Parallel Solve lets each fork contain its own multi-file plan for side-by-side comparison of wide-refactor strategies; Skills 2.0 can cap multi-file fanout per skill (a narrow `test_author` skill might set `max-parallel-edits: 1` in its tool-budget). **Planning-pass cost** — adds one extra LLM turn before edits start, so the feature is opt-out-able when the user knows better (`@no-plan` sentinel in the prompt skips the planner), and the planner can reuse a small local model via `sidecar.multiFileEdits.plannerModel` (default falls back to main model) since planning is structured-output-heavy and doesn't need the full reasoning budget of the editing model. Configured via `sidecar.multiFileEdits.enabled` (default `true`), `sidecar.multiFileEdits.maxParallel` (default `8`), `sidecar.multiFileEdits.planningPass` (default `true`), `sidecar.multiFileEdits.minFilesForPlan` (default `3` — skip the planner for small edits), `sidecar.multiFileEdits.plannerModel` (default empty — reuses main model), and `sidecar.multiFileEdits.reviewGranularity` (`bulk` | `per-file` | `per-hunk`, default `per-file`).

  ```mermaid
  flowchart TD
      U[User task<br/>span > 3 files] --> PL[Edit Plan pass<br/>planner model]
      PL --> PLAN[EditPlan manifest<br/>edits + dependsOn DAG]
      PLAN --> CARD[Planned edits card<br/>in chat UI]
      CARD -->|User nudge via Steer Queue| PL
      CARD -->|OK to proceed| DAG[Topological schedule]
      DAG --> PAR[Dispatch independent nodes<br/>up to maxParallel]
      PAR --> S1[write_file src/a.ts]
      PAR --> S2[write_file src/b.ts]
      PAR --> SN[...up to 8 streams]
      S1 & S2 & SN --> PC[Pending Changes panel<br/>N parallel diff previews]
      PC --> DEP[Dependent nodes fire<br/>after prereqs land]
      DEP --> PC
      PC --> GATE{Gate + Guards<br/>against full edit set}
      GATE -->|green| REV[Review: bulk /<br/>per-file / per-hunk]
      GATE -->|red| FB[Feedback to agent<br/>+ refine plan]
      REV --> M[Atomic merge to shadow]
  ```

- **Zero-Latency Local Autocomplete via Speculative Decoding** — pairs a tiny "draft" model (≤300M params, e.g. `qwen2.5-coder:0.5b`, `deepseek-coder:1.3b`-distill, or the new generation of sub-B code drafts) with the user's main FIM model (typically 7B–30B) and runs speculative decoding on the two in lockstep, amortizing the cost of the big model's forward pass across k draft tokens per step. The existing `completeFIM` path at [client.ts:286](src/ollama/client.ts#L286) and `InlineCompletionProvider` at [completions/provider.ts:79](src/completions/provider.ts#L79) stream the result straight into VS Code's ghost-text surface; today this runs the big model alone and inherits its raw tok/s. With a well-matched draft pair on decent local hardware (RTX 4090 / M3 Max / 128GB+ unified memory), empirically observed speedups are 2–4× on code continuations where the draft's guesses agree with the target most of the time — pushing a 30B coder from ~30 tok/s to ~80–120 tok/s, which crosses the perception threshold from "noticeably waiting" to "appearing as you type." Target UX: autocomplete that feels like Copilot / Cursor Pro without the round-trip to a cloud provider and without ongoing token spend. **Mechanism**: draft generates k candidate tokens serially (cheap — the small model runs in microseconds per token), target verifies all k in a single parallel forward pass (one big-model step cost covers k tokens of throughput), accept the longest prefix where target's argmax matches draft's proposal, use the target's token at the first disagreement, discard the rest of the draft. Rejection-sampled variant is supported for temperature>0 but default is greedy since autocomplete wants determinism. **Backend integration**: Ollama and Kickstand both back onto llama.cpp, which has native speculative decoding support (`--draft-model`, `--draft` parameters); the path is to surface this through the backend abstraction as a new optional `draftModel` field on `SideCarConfig`, have `OllamaBackend.completeFIM` pass `draft_model` to `/api/generate` when set, and have `KickstandBackend.completeFIM` pass the equivalent to its OAI-compat endpoint. For backends that don't expose speculative decoding (Anthropic, OpenAI, remote OpenAI-compatible that haven't enabled it), the setting is a silent no-op and completion runs target-only — no breakage, no warnings. **Model pairing**: a curated `DRAFT_MODEL_MAP` ships with sensible defaults (`qwen3-coder:30b` → `qwen2.5-coder:0.5b`, `deepseek-coder:33b` → `deepseek-coder:1.3b-base`, `codellama:34b` → `codellama:7b-code`) so users who just select a big model from the picker get the speedup automatically if the draft is installed, with a one-click "install recommended draft" affordance if not. Tokenizer compatibility is a hard requirement (same family, same vocab) — the map only pairs models known to share tokenizers, and manual overrides that violate this are rejected with a specific error rather than producing garbled output. **VRAM guardrails** — running two models costs memory; integrates with the GPU-Aware Load Balancing roadmap entry so if VRAM headroom drops below the threshold while a big training job is going, speculative mode auto-disables and falls back to target-only rather than crashing. **FIM prompt format** carries through unchanged — the existing `<|fim_prefix|>` / `<|fim_suffix|>` / `<|fim_middle|>` delimiters are respected by both models in a matched pair. Configured via `sidecar.speculativeDecoding.enabled` (default `true` when a draft mapping exists for the active model, `false` otherwise — zero-config for the common case), `sidecar.completionDraftModel` (explicit override, falls back to the curated map), `sidecar.speculativeDecoding.lookahead` (default `5` — number of draft tokens per verification step; higher = more speedup when draft is accurate, lower = less wasted compute when draft is wrong), `sidecar.speculativeDecoding.temperature` (default `0` — greedy; raise for rejection-sampled generation if autocomplete gains feel stale), and `sidecar.speculativeDecoding.minAcceptRateToKeepEnabled` (default `0.4` — if observed accept rate drops below this after a warmup window, disable speculation automatically because the draft isn't earning its keep and is just burning compute).

  ```mermaid
  sequenceDiagram
      participant E as Editor (ghost text)
      participant P as InlineCompletionProvider
      participant D as Draft model (0.5B)
      participant T as Target model (30B)

      E->>P: completion trigger (debounced)
      P->>P: build FIM prompt (prefix + suffix)
      loop Speculative step
          P->>D: generate k tokens (fast, serial)
          D-->>P: [t1, t2, ..., tk]
          P->>T: verify [t1..tk] in one parallel forward pass
          T-->>P: logits for each position
          P->>P: accept longest matching prefix, replace first mismatch
      end
      P-->>E: stream accepted tokens as ghost text
      Note over P: Typical accept rate 60-80%<br/>→ 2-4× throughput vs target alone
  ```

### Agent Capabilities

- **Chat threads and branching** — parallel branches, named threads, thread picker, per-thread persistence
- **Auto mode** — intelligent approval classifier that learns from user patterns
- **Persistent executive function** — multi-day task state in `.sidecar/plans/` tracking progress, decisions, and blockers across sessions

- **First-Class Skills 2.0 — Typed Personas with Tool Allowlists, Preferred Models, and Composition** — upgrades the shipped [SkillLoader](src/agent/skillLoader.ts) from "inject markdown into the prompt" into a full persona system where each `.agent.md` (or existing `.md`) skill is a declarative contract the runtime actually enforces. The parser at [skillLoader.ts:54](src/agent/skillLoader.ts#L54) already reads — but silently ignores — Claude-Code-compatible frontmatter fields (`allowed-tools`, `disable-model-invocation`); this entry makes every one of those fields load-bearing and adds several more. **Enforced frontmatter schema**:
  ```yaml
  ---
  name: Git Expert
  description: Focused git workflow assistance
  scope: session                 # turn | task | session — how long the skill stays active
  allowed-tools: [git_status, git_diff, git_log, git_commit, git_branch, git_push, read_file]
  preferred-model: claude-sonnet-4-6  # switch to this model while active; restore on exit
  system-prompt-override: false  # false = append to base prompt, true = replace it entirely
  disable-model-invocation: false  # when true, only the user can invoke — model can't auto-select
  extends: base-coder            # inherit frontmatter + prompt from another skill
  variables:                     # user-supplied args at invocation
    branch: { description: Target branch, required: false }
    message: { description: Commit message, required: false }
  auto-context:                  # auto-inject these tool calls' output as starting context
    - git_status
    - git log -n 10
  guards: [branch-protection]    # Regression Guards that activate with this skill
  tool-budget:                   # per-tool call caps while this skill is active
    git_commit: 3
  ---
  ```
  Each field maps to a concrete runtime behavior: **`allowed-tools`** intersects with the current `toolPermissions` map (most restrictive wins) so `/git_expert` literally cannot call `write_file` or `run_shell_command` regardless of the ambient mode — principle of least privilege per skill, turning a `db-writer` skill into a real capability boundary and not just an advisory one. **`preferred-model`** triggers a scoped `updateModel()` swap for the skill's duration; on exit the previous model restores (exceptions revert too, no sticky-state bugs). **`system-prompt-override: true`** fully replaces the base prompt with the skill's content for the hardest personality lock — useful when you want `latex_writer` to be a LaTeX-only assistant with no inherited general-coder instincts; default `false` keeps the existing append-as-context behavior for backward compatibility. **`disable-model-invocation`** prevents injection-style skill abuse where a hostile file could prompt the model into silently activating a privileged skill — the skill is user-invocation-only. **`extends`** gives single-inheritance composition: `frontend.agent.md` extends `base-coder` and inherits its tool allowlist + prompt preamble, overriding or extending per-field. **`variables`** are resolved at invocation (`/git_expert branch=feature/foo`) and substituted into the prompt as `${branch}` — Claude Code's `$ARGUMENTS` convention is also accepted as an alias. **`auto-context`** runs a fixed set of read-only tool calls before the skill's first turn so the model sees pre-fetched state (the `git_expert` skill always starts with current `git status` + last 10 commits in its context, no wasteful first-turn `git_status` call). **`guards`** registers per-skill Regression Guards that activate only while the skill is in effect. **`tool-budget`** caps per-tool calls (prevents a runaway skill from calling `git_commit` 50 times). **Skill stacking**: users can invoke multiple skills simultaneously via `/with git_expert /with technical-writer <task>` or a persistent stack via the UI picker. Tool allowlists intersect (`git_expert ∩ technical-writer` = only tools both permit); preferred-model conflicts resolve by last-invoked-wins with a visible indicator; prompts concatenate in stack order with section headers so the model sees the layered persona clearly. **Scopes**: `turn` skills apply for exactly one user turn and revert; `task` skills persist until the current task's completion gate passes; `session` skills persist until explicitly ended with `/unload <skill>` or a new session starts — matches the mental model users already have from similar systems. **Skills Picker UI**: a new sidebar panel replaces "type the slash command and hope you remember the name" with a searchable grid of available skills — tagged by category (git / frontend / security / scientific / writing), preview of the persona's opening instructions, the tool allowlist rendered as chips, and a *Stack* button to add without replacing. **Telemetry** (local-only, opt-in): per-skill usage count, average turns-to-completion, accept rate of the skill's proposed changes — surfaced in the picker so users can see which skills are earning their keep and which are dead weight. **Integration with every earlier entry**: Facets consume skills via their existing `skillBundle` field (a facet stacks its declared skills automatically on dispatch); Fork & Parallel Solve can wear different skills per fork (fork A with `fourier_approach.agent.md`, fork B with `wavelet_approach.agent.md`); Regression Guards declared in skill frontmatter fire only while the skill is active; Audit Mode can be required by a skill (`require-audit: true`) for write-heavy skills; Visual Verification criteria can be declared per-skill. **Backward compatibility**: every field is optional — the 8 shipped skills (`break-this`, `create-skill`, `debug`, `explain-code`, `mcp-builder`, `refactor`, `review-code`, `write-tests`) keep working unchanged since they declare none of the new fields; missing fields default to the current permissive behavior (full tool access, append-mode prompt, turn-scoped). Configured via `sidecar.skills.directories` (already exists — extends to accept both `.md` and `.agent.md`), `sidecar.skills.enforceAllowedTools` (default `true`; `false` for legacy "advisory only" parsing), `sidecar.skills.allowModelInvocation` (default `true`; when `false` only user-initiated invocation is ever honored, even for skills that don't declare `disable-model-invocation`), and `sidecar.skills.stackingMode` (`strict` | `union` | `last-wins`, default `strict` — strict intersects tool allowlists; union takes the superset; last-wins replaces prior skills entirely).

  ```mermaid
  flowchart TD
      U[User invokes /git_expert] --> L[SkillLoader resolves +<br/>merges extended skills]
      L --> FM{Frontmatter fields}
      FM --> AT[allowed-tools →<br/>intersect with toolPermissions]
      FM --> PM[preferred-model →<br/>scoped updateModel]
      FM --> SP[system-prompt-override →<br/>replace or append]
      FM --> V[variables → substitute<br/>user args into prompt]
      FM --> AC[auto-context →<br/>pre-fetch read-only tool output]
      FM --> G[guards → register on<br/>HookBus for skill lifetime]
      FM --> TB[tool-budget →<br/>per-skill call caps]
      AT & PM & SP & V & AC & G & TB --> ACT[Skill active]
      ACT --> SCOPE{scope}
      SCOPE -->|turn| T1[Revert after 1 turn]
      SCOPE -->|task| T2[Revert when gate<br/>closes cleanly]
      SCOPE -->|session| T3[Revert on /unload<br/>or session end]
      T1 & T2 & T3 --> REV[Restore prior model,<br/>tool perms, hooks]
  ```

- **Skill Sync & Registry — Git-Native Distribution Across Machines and Projects** — extends Skills 2.0 from "manually drop `.agent.md` files in each project's `.sidecar/skills/` or `~/.claude/commands/`" to a proper three-tier distribution model matching Copilot Pro / Cursor's global agent registry, but git-native and local-first so no SideCar-operated service stands between you and your skills. The three tiers, from smallest blast radius to largest, are already partially supported or genuinely new: (1) **Project-level team sync is already solved** — per the Multi-User Agent Shadows `.gitignore` carve-out, `.sidecar/skills/` at the project root stays tracked in git; teams that commit skills there get cross-developer sync for free via the main repo's history. No new feature needed at this tier, but this entry documents it as first-class. (2) **User-level cross-machine sync is the real gap** — `~/.claude/commands/*.md` works on one machine, but moving to a second laptop or a new dev container means copying files by hand. SideCar gains `sidecar.skills.userRegistry`, a git URL (or a local folder) the user owns: on activation, SideCar clones or pulls that repo into `~/.sidecar/user-skills/`, the SkillLoader picks up every `.agent.md` inside as a user-scope skill, and the "Create Skill" flow offers a *Publish to your registry* checkbox that writes the new skill into the clone + commits + pushes. Standard git auth (SSH keys, GitHub tokens) handles credentials — no custom auth plumbing. A `sidecar.skills.autoPull` schedule (`on-start` | `hourly` | `daily` | `manual`, default `on-start`) keeps the clone fresh; conflicts surface as notifications pointing to the managed directory for manual merge rather than being silently swallowed. (3) **Team-scoped additional registries** layer on top — `sidecar.skills.teamRegistries` accepts an array of git URLs, each cloned into a separate subdirectory of `~/.sidecar/team-skills/<registry-slug>/`, with the Skills Picker tagging hits by origin registry so a developer on three overlapping teams can see which registry each skill came from and resolve name collisions deterministically (explicit registry prefix: `/team-a/db-expert` vs `/team-b/db-expert`). (4) **Public marketplace is an optional fourth tier** — a lightweight hosted index at `registry.sidecar.ai` (or any compatible endpoint via `sidecar.skills.marketplace`) that crawls opted-in public git repos, exposes search / tags / author / install-count metadata, and the Skills Picker's *Browse* tab queries it at the user's request. Installing from the marketplace still does a standard git clone into a managed location — the registry is just an index, not a runtime dependency, so if it goes down your installed skills keep working and future installs fall back to direct git URLs. **Skill metadata for distribution** extends the Skills 2.0 frontmatter with: `version: 1.2.0` (semver, for pinning and update notifications); `author: @user` (renders in the picker, links to their registry); `repository: https://github.com/user/skill-repo` (source-of-truth URL for updates); `license: MIT` (surfaced in the picker so users see the legal posture before invoking); `tags: [git, automation]` (for marketplace filtering); `requires: [@core/base-coder@^1.0]` (inter-skill deps resolved transitively at install time). **Versioning and pinning**: `sidecar.skills.versions` accepts a map of `{ "@user/skill-name": "1.2.0" }` pins; the Skills Picker shows an *Update available* badge when a newer version exists upstream but never auto-updates a pinned skill without the user's explicit OK. **Trust model is explicit**: `sidecar.skills.trustedRegistries` lists registries that install without prompting; any other registry (including first-use of the public marketplace) prompts with "this skill will be allowed to suggest tool calls and prompt injections to your agent — review the source at <URL>?" on first install, with the skill's full frontmatter + body shown inline. Skills still respect the `allowed-tools` and `disable-model-invocation` guardrails from Skills 2.0, so even an untrusted skill can't silently escalate beyond its declared tool surface — the trust prompt is about the *intent* of the skill's prose, not about bypassing runtime enforcement. **Offline is a first-class mode**: once a skill is cloned, it works without network, the registry API is optional at runtime, and `sidecar.skills.offline` (default `false`) hard-disables every network operation — the extension becomes a pure local-cache reader, useful in air-gapped environments or in restrictive CI. **Integrates with every earlier feature**: Facets can reference skills via the same `@user/skill-name` identifier their `skillBundle` already uses, and the resolver fetches missing skills on first facet dispatch; Fork & Parallel Solve can pull different skill versions per fork (`fork A uses @core/refactor@1.0`, `fork B uses @core/refactor@2.0` — direct A/B test of a skill upgrade against real code); Project Knowledge Index can embed installed skills into the vector DB so `project_knowledge_search "git workflow"` finds a relevant skill as a retrieval hit; the Typed Sub-Agent Facets entry's `skillBundle` field resolves through this system so a facet's skill dependencies are fetched deterministically on install. Configured via `sidecar.skills.userRegistry` (git URL or local folder, default empty — opt-in), `sidecar.skills.teamRegistries` (array of git URLs, default empty), `sidecar.skills.marketplace` (URL, default `https://registry.sidecar.ai` but every install still passes through a trust prompt), `sidecar.skills.autoPull` (default `on-start`), `sidecar.skills.autoUpdate` (`manual` | `weekly` | `daily`, default `weekly` — respects pins), `sidecar.skills.trustedRegistries` (array of registry URLs that skip the first-install trust prompt; empty by default), `sidecar.skills.versions` (pin map), and `sidecar.skills.offline` (default `false`; when `true`, no network calls at all).

  ```mermaid
  flowchart TD
      subgraph Tiers ["Distribution tiers"]
          T1[Project-level<br/>.sidecar/skills/<br/>tracked in repo<br/>ALREADY WORKS]
          T2[User-level<br/>userRegistry<br/>git clone to<br/>~/.sidecar/user-skills/]
          T3[Team-level<br/>teamRegistries[]<br/>per-registry subdirs]
          T4[Public marketplace<br/>optional index<br/>still git under the hood]
      end
      A[SideCar activation] --> PULL{autoPull schedule}
      PULL --> T2
      PULL --> T3
      UI[Skills Picker<br/>Browse tab] --> MP[marketplace API]
      MP --> T4
      T1 & T2 & T3 & T4 --> SL[SkillLoader<br/>merges with conflict<br/>resolution by prefix]
      SL --> PICK[Unified picker<br/>tagged by origin]
      PICK --> INV[Skill invoked<br/>respects allowed-tools<br/>from Skills 2.0]

      subgraph Trust ["Trust on install"]
          INST[First install<br/>from new registry] --> PROMPT{trustedRegistries<br/>contains it?}
          PROMPT -->|yes| AUTO[Auto-install]
          PROMPT -->|no| MODAL[Show frontmatter +<br/>source link + Install button]
      end
  ```

- **LaTeX agentic debugging** — intercepts compiler output (pdflatex / xelatex / lualatex / bibtex / biber) and closes the loop between the raw log and the source tree without the user ever reading a `.log` file. When a build fails, a dedicated log-parsing agent classifies each error by type (missing brace, undefined reference, BibTeX key mismatch, undefined control sequence, overfull hbox, missing `\end`, etc.), maps the reported line number back to the actual offending location accounting for `\input` / `\include` transclusion, and stages a targeted fix directly in the *Pending Changes* diff view — ready to accept with one click. Multi-error runs are handled in a single pass: the agent resolves errors in dependency order (e.g. fix the missing `}` before re-evaluating the downstream undefined-reference cascade) so the build converges in as few iterations as possible. BibTeX / Biber mismatches get special treatment: the agent cross-references the `.bib` file, the `.aux` citations, and the bibliography style to distinguish a missing entry from a key typo from a field-format violation, and proposes the minimal `.bib` edit. Configured via `sidecar.latex.enabled` (default `true` when a `.tex` file is open) and `sidecar.latex.buildCommand` (defaults to auto-detected `latexmk` invocation). Surfaces in the chat UI as a *LaTeX Build* status-bar item that turns red on failure and opens the agent panel on click.

- **Shadow Workspaces** — an ephemeral, nearly-free sandbox the agent iterates in *before* any real file in the user's working tree is touched. When a task starts, SideCar creates a git worktree at `.sidecar/shadows/<task-id>/` off the current `HEAD` (already a gitignored subdir per the Multi-User Agent Shadows carve-out) and pins every subsequent tool call — `write_file`, `run_shell_command`, `grep`, `tsc`, `vitest`, `git_*` — to that path via a `cwd` field on `ToolExecutorContext`. **Hybrid layout to keep the cost sub-linear:** the tracked tree comes for free via git's shared object DB (worktrees don't duplicate `.git/objects`), and the big untracked runtime dirs that the gate command needs — `node_modules`, `.next`, `dist`, `build`, `target`, `__pycache__` — are mounted into the shadow as **read-only symlinks** to the main tree's copies, so `npm run check` works instantly without a reinstall. **Agent writes always land in real shadow-local files, never through a symlink**, so no write can bleed through to main regardless of how the agent or its subprocesses resolve paths. Pure symlink/overlay approaches were rejected because they can't make that guarantee cross-platform: Node's `fs.writeFileSync` follows symlinks to the target, macFUSE needs a kernel extension, OverlayFS is Linux-only, and Windows ProjFS requires admin. The agent can iterate freely in the shadow: draft, run the suite, see it fail, revise, repeat — main editor stays pristine the entire time, nothing to revert if the agent goes off the rails. The existing completion gate (`tsc` + `eslint` + `vitest` from `npm run check`, wired via the `gate.ts` hook) is what decides "task passed": only when the gate comes back green does SideCar compute a unified diff vs `HEAD` and surface a *Shadow Review* panel where the user can accept per-hunk, accept-all, or reject. Accept = `git diff shadow main | git apply` onto the main tree + `git worktree remove`. Reject = worktree teardown, zero footprint. If main has advanced while the agent was working, the shadow is rebased first; unresolvable conflicts are surfaced as conflict markers in the review panel rather than silently merged. Typical on-disk cost is <50MB (tracked source only, since git ODB and `node_modules` are both shared). Configured via `sidecar.shadowWorkspace.mode` (`off` | `opt-in` | `auto`, default `opt-in` — triggered by `/sandbox <task>` or a setting toggle), `sidecar.shadowWorkspace.gateCommand` (default `npm run check`, override for non-JS projects), `sidecar.shadowWorkspace.symlinkedDirs` (default `['node_modules', '.next', 'dist', 'build', 'target', '__pycache__']`, append project-specific artifact dirs here), and `sidecar.shadowWorkspace.autoCleanup` (default `true`; set `false` to keep failed shadows around for post-mortem). A *Shadow Active* status-bar pulse indicates the agent is working in a sandbox.

  ```mermaid
  sequenceDiagram
      participant U as User
      participant A as Agent
      participant S as Shadow Worktree
      participant G as Gate (tsc+lint+vitest)
      participant M as Main Tree

      U->>A: Prompt / /sandbox <task>
      A->>S: git worktree add off HEAD
      loop Iterate until gate green
          A->>S: edit / run_shell / grep
          S->>G: npm run check
          G-->>A: pass / fail output
      end
      A->>U: Shadow Review panel (diff vs HEAD)
      alt User accepts
          U->>M: git apply shadow diff
          M->>S: git worktree remove
      else User rejects
          M->>S: git worktree remove (no-op on main)
      end
  ```

- **Doc-to-Test Synthesis Loop** — a closed loop between a reference document (PDF, `.tex`, `.md`, `.rst`, `.docx`, or a Literature-indexed paper) and a Python test suite that verifies an implementation actually adheres to what the document claims. On invocation (right-click a doc → *Generate tests from document*, or `/doc-tests <path>`), a dedicated *Constraint Extractor* agent reads the source, separates prose from math (handling both inline `$...$` and `\begin{equation}` / `\begin{align}` blocks), and produces a structured `Constraint[]` manifest — each entry typed by classification (`mathematical_identity`, `numeric_example`, `boundary_condition`, `complexity_bound`, `invariant`, `qualitative_claim`), stamped with source provenance (`file:page:section`, exact quoted sentence, equation ID), tagged with a testability verdict, and scored with an extraction-confidence float. The manifest is surfaced in a *Constraint Review* panel **before** any test code is written — the user ticks which constraints to realize as tests, corrects any misreading of the math, and can mark qualitative claims as `non-testable` (surfaced separately as a design note, not dropped silently). Approved constraints feed a *Test Synthesis* agent that generates `pytest` cases under `tests/from_docs/<doc-slug>/` (configurable; `unittest` and `nose` supported), with one test function per constraint: mathematical identities become parametrized tests with `hypothesis` strategies over realistic input distributions (so `fft` unitarity is checked with a thousand random vectors, not just one); numeric examples become `pytest.approx` asserts pinned to the paper's exact stated values; complexity bounds use `pytest-benchmark` with big-O regression asserts; boundary conditions get explicit edge-case cases. Every generated test carries a docstring containing the full provenance — source file, page, equation ID, and the quoted constraint text — so a failing assertion points straight back to the paragraph in the spec that was violated. This is the **loop** part: the synthesized suite runs against the implementation, and failures don't just dump a traceback — they go into a *Doc/Impl Mismatch* review where the agent classifies each failure as (a) the implementation is wrong, (b) the document is wrong, or (c) the extraction misread the math, and proposes a patch for the correct side. The user picks, the patch lands, the suite re-runs, and the cycle converges. Re-running the loop after a doc edit produces an incremental diff — new/changed/removed constraints — against the existing test suite rather than regenerating from scratch, so hand-edits to the generated tests survive. Integrates with the typed-facet system: the *Test Synthesis* role is a built-in `test-author` facet, and the doc extractor can be backed by the `latex-writer` or `technical-writer` facet depending on source format. Integrates with Shadow Workspaces: generated tests land in a shadow first, are required to pass against the current implementation before the review panel opens, and merge bulk on accept. A *Doc Coverage* badge in the sidebar tracks the percentage of approved constraints currently covered by passing tests, giving a concrete adherence metric rather than a vibes-based "does the code match the paper." Language-agnostic by design: `pytest` is the default, but `sidecar.docTests.testFramework` supports `vitest`, `jest`, `junit`, `gotest`, `rust-test`, `hypothesis` (Python property-based as a standalone mode), each with their own synthesis templates. Configured via `sidecar.docTests.enabled` (default `true`), `sidecar.docTests.testFramework` (default `'pytest'`), `sidecar.docTests.outputDir` (default `'tests/from_docs/'`), `sidecar.docTests.floatTolerance` (default `1e-9` for exact math, overridable per-constraint during review), `sidecar.docTests.extractionModel` (falls back to the main model; can be pinned to a cheaper one since extraction is bounded and deterministic), and `sidecar.docTests.requireConstraintApproval` (default `true`; set `false` in trusted pipelines to skip the review step and synthesize directly).

  ```mermaid
  flowchart TD
      D[Source doc<br/>pdf / tex / md] --> X[Constraint Extractor agent]
      X --> M{Constraint manifest<br/>typed + provenanced}
      M --> R[Constraint Review panel<br/>user approves/edits]
      R --> S[Test Synthesis agent<br/>pytest / hypothesis / ...]
      S --> T[tests/from_docs/]
      T --> E{Run vs implementation}
      E -->|all green| C[Doc Coverage % updated<br/>loop complete]
      E -->|failures| F[Doc/Impl Mismatch review]
      F -->|impl wrong| PI[Patch implementation]
      F -->|doc wrong| PD[Propose doc edit]
      F -->|extraction wrong| PE[Re-extract + re-review]
      PI --> E
      PD --> X
      PE --> M
  ```

- **Live Diagnostic Subscription & Reactive Fixer** — promotes the existing pull-based `get_diagnostics` tool into a first-class push subscription so SideCar no longer has to ask before it knows something broke. On activation the extension registers a listener on `vscode.languages.onDidChangeDiagnostics` and hydrates from `vscode.languages.getDiagnostics()` for the initial state. Every diagnostic event — whether it came from `tsc`, `eslint`, `pyright`, `ruff`, `rust-analyzer`, a language-server MCP tool, or a custom linter — flows through a *Diagnostic Router* with four filters applied in order: **scope** (glob include/exclude so vendored code and generated files can be ignored), **source** (allowlist per diagnostic `source` string so `eslint-plugin-yaml` warnings in markdown don't trigger a refactor), **severity floor** (error / warning / info / hint threshold), and **dedupe window** (1.5s default, collapses the keystroke-storm most linters emit into a single settled event). Surviving diagnostics are classified by reaction mode: `during-turn` injects them into the running loop as a synthetic tool-result ("new diagnostic appeared elsewhere: ..."), piggybacking the Steer Queue's `nudge` urgency so the agent pivots at the next iteration boundary without abandoning in-flight work; `between-turns` queues them as follow-up tasks that fire after the current task's gate closes; `always` lets the agent react even when idle, useful when the user is actively editing and wants continuous cleanup. Regardless of mode, fixes route through the Shadow Workspace pipeline — the agent stages a patch in a shadow, the gate runs (including the diagnostic that triggered the fix, which must be resolved without introducing new ones), and only then does the *Pending Changes* view open with the diagnostic metadata pinned alongside the diff: source file, line, rule code, exact message, and a "why this change fixes it" one-liner from the agent. Your example — a Python type-mismatch three files away from what you're actively editing — becomes: VS Code surfaces the `pyright` diagnostic → Router debounces and accepts (severity >= warning, source allowlisted, file in scope) → during-turn nudge injects it → agent reads the offending file, identifies the missing `Union[int, float]` return type, writes the fix in the shadow, gate green, patch waiting in *Pending Changes* before you've switched tabs. **Guards against ping-pong loops:** a per-diagnostic max-attempts counter (default 2), a regression detector that aborts if the post-fix state reintroduces the same `(source, code, file)` triple anywhere in the workspace, and a per-session auto-fix budget capped by `sidecar.diagnostics.reactiveFix.sessionBudget` so a broken build that spawns a hundred errors can't melt the user's API spend. The feature composes with Typed Sub-Agent Facets — if a `tsc-fixer` or `pyright-fixer` facet is registered in the workspace it handles the diagnostic directly at a fraction of the token cost of dispatching to the general-coder; otherwise the main agent takes it. A *Diagnostics* panel in the SideCar sidebar shows live subscription state (N files watched, M diagnostics queued, K ignored this session by filter) with a one-click *Snooze auto-fix* button for when the user is deliberately in the middle of a refactor and doesn't want help. Configured via `sidecar.diagnostics.reactiveFix.mode` (`off` | `during-turn` | `between-turns` | `always`, default `during-turn`), `sidecar.diagnostics.reactiveFix.debounceMs` (default `1500`), `sidecar.diagnostics.reactiveFix.scopeIncludeGlobs` (default `['**/*']`), `sidecar.diagnostics.reactiveFix.scopeExcludeGlobs` (default `['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.generated.*']`), `sidecar.diagnostics.reactiveFix.sourcesAllowlist` (empty = all, or pin e.g. `['ts', 'tsc', 'eslint', 'pyright', 'ruff']`), `sidecar.diagnostics.reactiveFix.severityFloor` (`error` | `warning` | `info`, default `warning`), `sidecar.diagnostics.reactiveFix.maxAttemptsPerDiagnostic` (default `2`), and `sidecar.diagnostics.reactiveFix.sessionBudget` (default `20`).

  ```mermaid
  flowchart LR
      V[VS Code<br/>onDidChangeDiagnostics] --> R[Diagnostic Router]
      R --> SC{Scope<br/>glob match?}
      SC -->|no| DROP1[drop + count]
      SC -->|yes| SR{Source<br/>allowlisted?}
      SR -->|no| DROP2[drop + count]
      SR -->|yes| SV{Severity<br/>>= floor?}
      SV -->|no| DROP3[drop + count]
      SV -->|yes| DB[Dedupe 1.5s window]
      DB --> BG{Budget /<br/>attempt cap?}
      BG -->|exhausted| DROP4[surface in panel]
      BG -->|ok| MD{Mode}
      MD -->|during-turn| NQ[Inject as Steer<br/>Queue nudge]
      MD -->|between-turns| Q[Queue follow-up task]
      MD -->|always| IM[Immediate dispatch]
      NQ --> F[Fixer<br/>general or facet]
      Q --> F
      IM --> F
      F --> SH[Shadow Workspace]
      SH --> G{Gate green +<br/>no regression?}
      G -->|yes| PC[Pending Changes panel<br/>with diagnostic metadata]
      G -->|no| AB[Abort + log + count against budget]
  ```

- **Regression Guard Hooks — Declarative Post-Edit Verification** — elevates the existing `completionGate` (built-in `tsc` + `eslint` + `vitest` pass) and the shipped `HookBus` / `PolicyHook` system (v0.54.0, currently TS-only) into a **user-facing declarative config** where arbitrary shell commands become hard gates the agent physically cannot finish a task without passing. The use case is domain-specific correctness checks the general-purpose linters can't touch: a physics simulation's conservation-of-energy invariant (`python verify_physics.py`), a proof assistant's re-check (`coq_check proofs/`), a numerical-stability assertion after a filter refactor (`pytest tests/stability -m critical`), an API-contract diff (`npx oasdiff breaking spec.yaml HEAD`), a bundle-size budget (`size-limit`). Each guard is defined in `settings.json`:
  ```jsonc
  "sidecar.regressionGuards": [
    {
      "name": "physics-invariants",
      "command": "python verify_physics.py",
      "trigger": "pre-completion",   // or "post-write" | "post-turn"
      "blocking": true,               // exit != 0 blocks the task from finishing
      "timeoutMs": 30000,
      "workingDir": "${workspaceFolder}",
      "scope": ["src/physics/**", "src/simulation/**"],  // only fire when these match the edit set
      "maxAttempts": 5                // escalate to the user after N consecutive failures
    }
  ]
  ```
  The runtime wraps each entry in an internal `RegressionGuardHook implements PolicyHook`, registering it on the `HookBus` at the declared phase — so the same bus that already carries `CompletionGateHook` and `CriticHook` handles user guards without a parallel code path. Three trigger phases are supported, each with a different budget expectation: **`post-write`** runs after every `write_file` / `edit_file` / `delete_file` (kept cheap — a syntax linter, a fast unit test slice, a formatter-check); **`post-turn`** runs at the end of each LLM turn before the user sees the streamed output (medium cost — a focused test file); **`pre-completion`** runs before the agent is allowed to emit its "task done" signal (heavy checks like your `verify_physics.py`, benchmark regressions, integration suites). Guards are scoped by glob against the files the turn touched — a physics guard doesn't fire when the agent only edits CSS, so the cost is paid only when it matters. On failure, the guard's stderr + stdout + exit code are fed back to the agent as a synthetic tool-result (`regression guard 'physics-invariants' failed with exit 1:\n<captured output>`) so the agent can read the error and revise rather than just hitting a wall. The loop continues until the guard passes or `maxAttempts` is exhausted; hitting the cap escalates to the user with the full failure history so they can decide whether the guard is wrong or the code is wrong. **`blocking: false`** mode exists for advisory guards that should surface output but not block completion — useful for performance budgets where exceeding is a yellow flag, not a red one. Integrates with Shadow Workspaces: guards always run inside the shadow, never against the main tree, so a failing guard during iteration never affects the user's real files or running processes. Integrates with Facets: a facet can declare per-facet guards in its frontmatter (the `signal-processing` facet bundles a phase-linearity check, the `security-reviewer` facet bundles a secret-scan). UI: a *Regression Guards* status-bar item shows `✓ 3 passing` / `✗ 1 failing` with a click-to-expand panel listing each guard's last run, exit code, duration, and a *Run now* button for ad-hoc invocation. First-time load of a new guard config surfaces a trust prompt (same gate as MCP server stdio commands) since guards execute arbitrary shell. Configured via the `sidecar.regressionGuards` array plus `sidecar.regressionGuards.maxParallel` (default `2` — guards at the same trigger phase can run concurrently up to this cap), `sidecar.regressionGuards.failFast` (default `true` — on any blocking guard failure at a given phase, skip remaining guards at that phase to save time), and `sidecar.regressionGuards.mode` (`strict` | `warn` | `off`, default `strict` — `warn` flips all `blocking: true` guards to advisory without editing each entry, useful for short-term opt-outs during a known-broken refactor).

  ```mermaid
  flowchart TD
      A[Agent finishes a turn<br/>or hits pre-completion] --> T{Trigger phase<br/>matches?}
      T -->|no| DONE[Proceed]
      T -->|yes| SC{Scope glob<br/>matches touched files?}
      SC -->|no| DONE
      SC -->|yes| RUN[Run guards in parallel<br/>up to maxParallel]
      RUN --> CHK{All exit 0?}
      CHK -->|yes| DONE
      CHK -->|no + blocking| FB[Feed stderr+stdout+exit<br/>back as synthetic<br/>tool_result]
      CHK -->|no + non-blocking| WARN[Surface as warning<br/>+ proceed]
      FB --> AGENT[Agent reads failure<br/>and revises]
      AGENT --> RUN
      AGENT -.maxAttempts reached.-> ESC[Escalate to user<br/>with full failure history]
  ```

- **Shell-Integrated Agent Command Execution** — replaces `child_process.exec` inside `run_shell_command` with `vscode.window.createTerminalShellExecution`, routing agent-initiated shell work through VS Code's real terminal infrastructure instead of a hidden subprocess. The v0.45.0 `TerminalErrorWatcher` already subscribes to the *read* side of the terminal API (`onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`) to catch user-run command failures; this closes the loop by making the agent's own shell calls first-class terminal executions the user can see, interact with, and interrupt. Why this matters concretely: (1) **transparency** — agent commands appear in the user's terminal panel as they run, not in a black-box subprocess, so the user isn't surprised by side effects; (2) **remote-dev correctness** — `child_process.exec` escapes SSH / Dev Containers / WSL / Codespaces sandboxes and runs on the *host* rather than the remote, silently bypassing the shell the user actually configured; `createTerminalShellExecution` inherits VS Code's remote shell integration and runs in the intended environment; (3) **structured exit capture** via `TerminalShellExecution.read()` async iterable yielding stdout chunks plus a settled `exitCode`, replacing the string-buffer of `exec` with streamed output the agent sees as it arrives; (4) **shell-integration features** — inline error annotations, command navigation, and the per-command exit-code markers VS Code 1.93+ renders in the gutter all light up for agent commands automatically. A dedicated reusable terminal named *SideCar Agent* is created lazily on first command and reused across the session to avoid terminal proliferation; the user can pin it, scroll its history, and interact directly if a command needs manual input. **Not all agent commands route through the terminal** — internal parse-only tools (`git_diff`, `git_log`, `read_file` probes, grep subprocesses, small utility calls) still use `child_process` since they need raw stdout as a string for parsing, not a streamed terminal render, and silently surfacing dozens of metadata-fetch commands in the user's terminal would be noise not signal. The dispatcher classifies: anything invoked via the agent's explicit `run_shell_command` tool → terminal execution; anything invoked internally by the built-in git / fs / search tools → child process. Streaming stdout back to the agent composes with the existing `shellMaxOutputMB` cap — if a `npm install` with 50k lines blows the budget, output is head+tail truncated with an elision marker just like now, only now the *full* output still renders in the terminal for the user to inspect. User cancel (Steer Queue `interrupt`, or the extension's existing abort pathway) sends `SIGINT` to the shell execution so a runaway process actually stops rather than orphaning while the agent's AbortSignal fires. Graceful fallback: if VS Code reports no shell integration available (e.g. the user configured a bare `sh` without the shell-init script), the dispatcher falls back to `child_process.exec` with a one-time notification explaining why the terminal path isn't being used and how to enable shell integration. Configured via `sidecar.terminalExecution.enabled` (default `true`), `sidecar.terminalExecution.reuseTerminal` (default `true` — single *SideCar Agent* terminal; set `false` to create one per command for debugging), `sidecar.terminalExecution.terminalName` (default `'SideCar Agent'`), `sidecar.terminalExecution.fallbackToChildProcess` (default `true`), and `sidecar.terminalExecution.internalToolsBypass` (default `true` — keeps metadata-fetch tools on `child_process`; set `false` in trace mode to surface every subprocess in the terminal).

  ```mermaid
  flowchart LR
      A[Agent tool call] --> D{Classifier}
      D -->|explicit run_shell_command| TI{Shell<br/>integration<br/>available?}
      D -->|internal git/read/grep| CP[child_process.exec<br/>raw stdout string]
      TI -->|yes| T[createTerminalShellExecution<br/>in 'SideCar Agent' terminal]
      TI -->|no| CP
      T --> SR[TerminalShellExecution.read<br/>async iterable]
      SR -->|stdout chunks| STREAM[Stream to agent<br/>+ capped for tool_result]
      SR -->|exitCode| EC[Report to agent]
      U[User clicks terminal<br/>or hits Ctrl+C] -.SIGINT.-> T
      STEER[Steer Queue interrupt] -.SIGINT.-> T
  ```

- **Browser-Agent Live Preview Verification (Screenshot-in-the-Loop)** — closes the feedback gap between "code compiles + tests pass" and "the output actually looks right" by giving the agent vision of what it just produced. The loop: agent writes code that renders something visible (matplotlib plot, React component, WebGL canvas, interactive Plotly dashboard, Three.js scene, SVG diagram), a Visual Verification Hook renders the output, captures a screenshot, feeds it into a vision-capable model with the user's declared success criteria, and the VLM's verdict goes back to the agent as a synthetic tool-result — pass, or a specific failure description the agent can act on. The canonical scenario: a signal-design task where the user is plotting a filter's frequency response — if the plot clips at the dB floor, the magnitude curve shows aliasing artifacts, or the polarization ellipse is the wrong aspect ratio, the agent sees the same visual failure the user would see on manual inspection and self-corrects the code *before* the user ever opens the file. **Tools added to the agent's surface** (built on the Playwright MCP track already in Providers & Integration, extending its capabilities rather than duplicating them): `screenshot_page(url, selector?, waitFor?, viewport?)` captures a PNG of a URL or a DOM subtree with a configurable readiness wait (DOM content loaded, network idle, a specific selector resolvable, or `n` ms); `run_playwright_code(script)` executes user-supplied Playwright TS for complex interaction sequences (click a button, fill a form, wait for an animation frame, then screenshot); `analyze_screenshot(imagePath, criteria)` explicitly invokes the VLM with user-declared visual criteria and returns a structured verdict (`{ pass: boolean, issues: string[], annotatedRegions?: BoundingBox[] }`) the agent can read; `open_in_browser(url)` opens the URL in VS Code's Simple Browser so the user sees exactly what the agent sees without an external window opening. **Hybrid browser strategy**: Playwright-managed headless browser does the actual capture (full API control, programmatic screenshots, reliable in CI), while VS Code's Simple Browser opens the same URL in-IDE for user transparency so nothing is happening off-screen; both point at the Shadow Workspace's dev server (never the user's real server). **Criteria declaration**, two routes: (1) per-glob static criteria in `sidecar.visualVerify.criteria` — e.g. `{ "src/plots/**.py": { "expects": "Plot has visible x and y axes, no clipping against the frame, grid lines drawn; filter response crosses -3dB near f=1kHz", "checkClipping": true, "checkAxes": true } }`; (2) dynamic criteria inferred from the current task — the agent states "I'll verify this produces a valid frequency-response plot with no clipping" as part of its own plan and that becomes the VLM prompt automatically. Built-in checks for common failure modes (clipping, missing axes, solid-color blanks, aspect-ratio distortion, empty canvas) are runnable without a VLM at all — fast, free, deterministic — and serve as a cheap pre-filter before paying for a multimodal call. **Loop semantics**: after each write_file for a file in the configured glob, the hook fires — render → screenshot → VLM (or cheap checks) → verdict → agent. On fail, the VLM's specific feedback (`"The magnitude curve appears clipped at -60 dB; the y-axis range needs to extend lower"` — not `"looks wrong"`) is fed back as a tool_result and the agent revises. Loop capped by `sidecar.visualVerify.maxAttempts` (default `3` — visual loops converge fast or they don't converge at all). **VLM selection**: `sidecar.visualVerify.vlm` points to a multimodal model; falls back to the main model when it has vision (Claude Sonnet/Opus 4.x, GPT-4o, LLaVA via Ollama for local) or requires an explicit model otherwise. Cheap mode: Haiku 4.5 for "does this plot look reasonable at all" screening before escalating to Sonnet for nuanced critique. **Integrates with every earlier feature**: runs against the Shadow Workspace's dev server (never main); can register as a Regression Guard with `trigger: post-write` so visual verification is a gate the agent physically can't bypass; feeds the same screenshot into the Visualization Dashboard panel so the user sees what the agent sees; Doc-to-Test Loop can synthesize visual assertions from paper figures (`"Figure 3 shows a brickwall response with <0.1dB ripple in the passband"` → screenshot + VLM check); in Fork & Parallel Solve each fork's rendered output is captured for side-by-side visual comparison; Steer Queue lets the user abort a verification loop (`@visual stop, I just want the code — I'll review the plot myself`) when the VLM is nitpicking. **Security**: `run_playwright_code` is a code-execution vector (same class as shell tools) governed by workspace trust and the existing approval system; screenshots land in `.sidecar/screenshots/` (add to the gitignored-subdirs carve-out alongside `cache/`, `logs/`, etc.); external URLs respect the existing `sidecar.outboundAllowlist`; localhost dev servers are always allowed. Configured via `sidecar.visualVerify.enabled` (default `false` — opt-in since it needs a multimodal model and a browser runtime), `sidecar.visualVerify.vlm` (default empty — auto-detects main model's vision capability), `sidecar.visualVerify.browser` (`simple` | `playwright` | `hybrid`, default `hybrid`), `sidecar.visualVerify.screenshotsDir` (default `.sidecar/screenshots/`), `sidecar.visualVerify.criteria` (per-glob criteria object, default `{}`), `sidecar.visualVerify.maxAttempts` (default `3`), `sidecar.visualVerify.mode` (`strict` | `warn` | `advisory`, default `warn` — the VLM can be wrong and a hard block on visual critique is annoying in practice, so warn is the safe default until the user has calibrated the criteria), and `sidecar.visualVerify.cheapChecksOnly` (default `false`; set `true` to run the deterministic built-in checks — clipping, blank canvas, axis presence — without ever calling the VLM, useful for tight local-inference budgets).

  ```mermaid
  sequenceDiagram
      participant A as Agent
      participant S as Shadow dev server
      participant P as Playwright (headless)
      participant SB as VS Code Simple Browser
      participant CK as Cheap checks<br/>(clipping/blank/axes)
      participant V as VLM
      participant U as User

      A->>S: write_file (plot script / component)
      S-->>A: server reloads at shadow URL
      A->>P: screenshot_page(url, waitFor)
      P-->>A: PNG artifact
      A->>SB: open_in_browser(url) [user transparency]
      A->>CK: fast deterministic screen
      CK-->>A: blank / clipped / axes? → early fail
      alt Cheap checks pass
          A->>V: analyze_screenshot(png, criteria)
          V-->>A: {pass, issues[]}
      end
      alt Visual pass
          A->>U: Change ready in Pending Changes
      else Visual fail
          A->>A: revise with VLM feedback<br/>(up to maxAttempts)
      end
  ```

- **Research Assistant — Structured Lab Notebook, Experiment Manifests, and Hypothesis Graph** — ties the scattered research-adjacent primitives already across this ROADMAP (Literature synthesis, Doc-to-Test Loop, Integrated LaTeX Preview, LaTeX agentic debugging, Visualization Dashboards, Browser-Agent visual verification) and the shipped domain skills (`technical-paper`, `mathematical-proofs`, `signal-processing`, `statistics`, `radar-fundamentals`, `electromagnetics`) into a **cohesive lab-notebook workflow** so SideCar stops being "a code assistant that happens to know LaTeX" and becomes "an end-to-end research collaborator that happens to also write code." The gap today: a user running a simulation, collecting results, iterating on an algorithm, and drafting a paper has to hold all the connective tissue in their head — which experiment tested which hypothesis, which figure came from which data run, which citation supports which claim, which parameter sweep produced which plot. SideCar can help with any individual step but has no persistent model of the *project* as a research artifact. This entry introduces that model. **Research Projects as first-class entities** live under `.sidecar/research/<project-slug>/` (tracked in git — this is curated state, not ephemeral cache, so it stays out of the gitignored subdirs list) with a clean directory structure: `project.yaml` (top-level metadata: title, question, hypotheses list, status), `experiments/<exp-id>/manifest.yaml` (one per experiment with reproducibility fields — see below), `literature/` (symlinks or copies into the Literature synthesis index with project-specific notes overlaid), `figures/<fig-id>/` (source data + generation script + rendered outputs + captured seed), `drafts/` (paper sections, poster, slide decks), and `observations/<timestamp>.md` (timestamped free-form notes the agent and user both contribute to). **Experiment Manifest** schema — every experiment is a reproducible, content-addressed unit:
  ```yaml
  id: exp-2026-04-16-fir-comparison
  hypothesis: "A wavelet-based decomposition outperforms FFT for detecting sub-cycle transients below -40 dB"
  parameters:
    sample_rate_hz: 48000
    snr_db: [-40, -35, -30, -25, -20]   # sweep
    filter_order: 256
    seed: 42
  environment:
    python: "3.11.7"
    requirements_hash: blake3:abc123...
    git_sha: def456...
    hardware: "M3 Max, 64GB unified"
  command: "python experiments/fir_vs_wavelet.py --config exp-config.yaml"
  artifacts:
    - results.parquet
    - figures/snr_vs_detection.png
    - logs/run.txt
  interpretation: "<agent-written or human-written summary of what the results mean>"
  supports: [hypothesis-id]        # hypothesis this experiment supports or refutes
  refutes: []
  related_work: [@smith2024, @jones2023]
  status: complete                  # planning | running | complete | abandoned
  ```
  Running `/experiment run <id>` dispatches the command inside a Shadow Workspace (so the main tree stays pristine), captures every artifact into `experiments/<id>/`, and automatically populates `environment` from git state + `pip freeze` / `npm ls` / `cargo tree` + the current hardware probe (reuses the `system_monitor` tool from v0.57+). **Reproducibility is enforced, not advisory** — re-running a stored manifest fails loudly if the git SHA has drifted or the requirements hash doesn't match, with a "reproduce exactly" path that checks out the recorded SHA into a shadow and re-runs against pinned dependencies. Catches the researcher's-nightmare scenario of "I can't reproduce my own result from three weeks ago because `numpy` silently upgraded." **Hypothesis Graph** lives alongside the experiment store: nodes are hypotheses (with their status — `open` / `supported` / `refuted` / `needs-more-evidence` / `abandoned`), edges are `supports` / `refutes` / `depends-on` / `generalizes` derived from the experiments' `supports` and `refutes` fields. Rendered in a sidebar *Research Board* as a force-directed graph (via the Visualization Dashboards MCP layer once that ships, with a Mermaid fallback in the interim), showing which hypotheses have evidence piling up, which are contested (experiments both support *and* refute), and which are dangling (stated but never tested). The agent treats this graph as first-class context — "we have three experiments supporting H1 but H2 is untested and contradicts H1 — should we run an experiment isolating them?" becomes a suggestion the agent can make, backed by the actual state of your research. **New agent tools** layered onto the existing 23+ tool catalog: `run_experiment(manifest)` dispatches a recorded manifest and captures its artifacts; `log_observation(text, relatedTo: {experiment? | hypothesis? | figure?})` appends a timestamped observation to `observations/` with structured cross-references; `test_hypothesis(id)` aggregates evidence across linked experiments and returns a verdict with confidence (Bayesian posterior if priors are declared, otherwise a simple experiment-count ratio); `find_related_work(topic, depth)` walks the Literature graph (via the Literature synthesis index) up to N hops, surfacing papers the project doesn't yet cite but probably should; `suggest_next_experiment(hypothesis)` reasons over what would most reduce uncertainty given existing evidence (uses the Thinking Visualization `self-debate` mode so the user can see the reasoning); `validate_statistics(data, test, alpha)` runs sample-size / statistical power / effect-size / multiple-comparison checks via a bundled `statistics` skill-facet and blocks claiming a finding as "supported" until the checks pass; `generate_figure(data, spec, caption)` produces matplotlib / plotly / tikz output with captured seed + code + parameters, stored as a reproducible figure bundle; `draft_section(kind: 'abstract'|'intro'|'methods'|'results'|'discussion'|'related-work', sources)` produces a paper section grounded in the actual experiment manifests + literature graph, with every claim traced back to an experiment ID or citation (no unsupported claims survive the generation — composes with the RAG-Native Eval Metrics entry's faithfulness scorer). **Reviewer simulation** — before the user shares a paper draft, `/review-as <persona>` spawns a critic agent wearing a reviewer persona (`skeptical-reviewer`, `domain-expert-reviewer`, `methods-critic-reviewer` all shipped as built-in skills) that reads the draft + underlying experiment manifests and returns structured objections: statistical concerns, missing controls, unsupported claims, related-work gaps, reproducibility red flags. Reuses the existing War Room infrastructure but with research-specific rubrics baked into the critic personas. **Statistical validity as a Regression Guard** — the `validate_statistics` check can be registered as a `pre-completion` guard on the `draft_section` tool so a paper draft literally cannot be marked done if the underlying experiments don't clear statistical validity (under-powered n, p-hacking patterns in the parameter sweep, undisclosed multiple comparisons) — composes directly with the Regression Guard Hooks entry in Agent Capabilities. **Notebook integration**: `.ipynb` files are first-class experiment artifacts. The agent can execute cells via a Jupyter kernel wrapper tool, capture outputs + figures as proper manifest artifacts, and keep the notebook and any refactored `.py` module in sync (the *Background doc sync* entry generalized to code↔notebook). **Composition with every earlier entry**: Literature synthesis feeds the literature graph and `find_related_work`; Doc-to-Test Loop verifies the *published paper's* claims against the implementation (catches the "what we wrote the paper said vs what the code actually does" drift, which is a common research-integrity hazard); Integrated LaTeX Preview renders the draft with live figures pulled from `figures/<id>/`; Visualization Dashboards renders the hypothesis graph, experiment timeline, and figure gallery inline; Browser-Agent Visual Verification sanity-checks each generated figure before it's committed to a draft; Fork & Parallel Solve lets the researcher explore two methodologies in parallel with side-by-side result comparison (the FFT vs wavelet scenario is literally an experiment-fork); Facets give per-domain personas (`statistician` for `validate_statistics`, `peer_reviewer` for `review-as`, `technical_writer` for `draft_section`); Project Knowledge Index indexes the research project so the agent retrieves across *past experiments* when suggesting new ones; Semantic Time Travel answers "three months ago we thought X about this hypothesis — what experiments changed our mind?"; Regression Guards enforce statistical validity; Shadow Workspaces host experiment runs so the main tree never ships with intermediate scratch files; Audit Mode is appropriate for write-heavy drafting sessions. **UI surfaces** a *Research* root in the SideCar sidebar with four sub-panels: *Projects* (list + active project selector), *Experiments* (timeline view, status badges, quick-reproduce button), *Hypothesis Graph* (interactive force-directed view), and *Drafts* (section-per-tab editor with citation previews on hover). A persistent status-bar item shows `Research: <project-slug> · 3 exp running · H2 needs evidence` so the user sees project state at a glance. Configured via `sidecar.research.enabled` (default `false` — opt-in), `sidecar.research.projectsPath` (default `.sidecar/research/`), `sidecar.research.activeProject` (default auto-detects from CWD or most-recently-touched), `sidecar.research.reproduceStrictMode` (default `true` — fail on git-SHA / requirements-hash drift during `/experiment reproduce`; set `false` for "best-effort reproduce" in exploratory work), `sidecar.research.statisticsGuardEnabled` (default `true` — block `draft_section` on statistical-validity failures), and `sidecar.research.reviewerPersonas` (default `['skeptical-reviewer', 'domain-expert-reviewer', 'methods-critic-reviewer']` — extendable with custom persona skill IDs).

  ```mermaid
  flowchart TD
      subgraph Project [".sidecar/research/&lt;slug&gt;/ (tracked in git)"]
          M[project.yaml<br/>title, question, hypotheses]
          E[experiments/&lt;id&gt;/manifest.yaml<br/>+ artifacts + env + seed]
          L[literature/<br/>Zotero overlays + notes]
          F[figures/&lt;id&gt;/<br/>data + script + rendered]
          D[drafts/<br/>paper, poster, slides]
          O[observations/&lt;ts&gt;.md<br/>timestamped notes]
      end
      H[Hypothesis Graph] --> E
      H --> D
      E --> F
      E --> D

      AG[Agent research tools] --> RUN[run_experiment]
      AG --> LO[log_observation]
      AG --> TH[test_hypothesis]
      AG --> FR[find_related_work]
      AG --> SU[suggest_next_experiment]
      AG --> VS[validate_statistics]
      AG --> GF[generate_figure]
      AG --> DS[draft_section]
      AG --> RV[review-as persona]

      RUN --> E
      VS -.Regression Guard.-> DS
      DS --> D
      GF --> F
      FR --> L
      RV --> D

      U[User] --> UI[Research sidebar:<br/>Projects · Experiments ·<br/>Hypothesis Graph · Drafts]
      UI --> AG
  ```

- **First-Class Jupyter Notebook Support** — closes a gap that's currently zero: SideCar has no notebook awareness at all. `read_file` on an `.ipynb` returns raw JSON (unreadable to the model, useless for reasoning); `edit_file` risks corrupting the JSON schema because the agent can't see cell boundaries; VS Code's native `vscode.NotebookEdit` / `NotebookData` / `NotebookController` APIs are unused; there's no way to run a cell and read its output — which is the whole point of notebooks for the scientific, data, and research workflows the Research Assistant entry above depends on. This entry adds a complete, cell-aware notebook surface built on the native VS Code APIs. **Eight new agent tools** replace naive text handling of `.ipynb` files, each dispatching through the native notebook APIs so the underlying JSON schema stays intact and the user's notebook editor reflects agent edits in real time just like human edits do: (1) `read_notebook(path, { includeOutputs?, maxOutputChars? })` returns structured `{ cells: [{ index, kind: 'code' | 'markdown' | 'raw', language, source, outputs?: NotebookOutput[], metadata }] }` — outputs are optional because they balloon context (a single matplotlib plot is ~50k base64 chars), and when included they're truncated to `maxOutputChars` per cell with a `truncated: true` flag; (2) `edit_notebook_cell(path, cellIndex, newSource)` surgically replaces one cell's source without touching surrounding cells, outputs, or metadata — routed through `vscode.NotebookEdit.updateCellText`; (3) `insert_notebook_cell(path, atIndex, source, kind, language?)` creates a new cell at a specific position via `NotebookEdit.insertCells`; (4) `delete_notebook_cell(path, cellIndex)` removes a cell cleanly via `NotebookEdit.deleteCells`; (5) `reorder_notebook_cells(path, [newOrder])` shuffles cells (useful when refactoring exploration notebooks into linear presentation order); (6) `run_notebook_cell(path, cellIndex, { timeoutMs? })` executes a cell via the notebook's attached `NotebookController` and returns structured outputs — text, tables, base64 images (auto-piped to Visual Verification when that feature is enabled and the cell produces a plot), stderr, execution count, elapsed time, and a `kernelError?` field with stack trace when execution fails; (7) `run_notebook_all(path, { stopOnError?, maxCellMs? })` executes every code cell in order, streaming progress back to the agent as each completes so long-running notebooks don't block on a single response; (8) `generate_notebook(path, { outline, template?, kernel? })` creates a new `.ipynb` from scratch with scaffolded cells — built-in templates ship for common shapes (`data-exploration`, `signal-processing-analysis`, `paper-figure-reproduction`, `experiment-sweep`, `tutorial-walkthrough`), and the outline can be a free-form list of cell descriptions the model fills in. **Roundtrip fidelity is a hard invariant**: reading a notebook → making an edit → writing it back preserves cell IDs, execution counts, cell metadata, kernel specs, language info, and (when the user didn't ask for output changes) every existing output byte-for-byte. Enforced with a unit-level property test — a fuzzing harness that reads → no-op edits → writes 500 realistic notebooks and asserts byte equality. Catches the classic AI-assistant-corrupts-my-notebook failure mode before it ships. **Cell-aware streaming diff previews** extend the existing `streamingDiffPreviewFn` so a multi-cell edit shows each cell's diff in its own collapsible tile in the Pending Changes panel, not a single monolithic JSON-level diff (which is what the current raw-file path produces and which is useless for reviewing). Inserts / deletes / reorders get their own visual treatment so the user sees structural changes distinctly from content changes. **Kernel handling**: the agent respects the notebook's attached kernel — if the user already selected "Python 3.11 (venv)", agent tool calls execute there; no kernel attached triggers a one-time prompt via the existing approval system ("no kernel attached, select one or install the recommended `ipykernel` in `.venv`?"). Multi-language notebooks (Jupyter supports them) work — each cell's declared language drives which kernel subprocess handles it. Execution outputs cap at `sidecar.notebooks.maxOutputChars` (default `2000`) per cell for the *returned-to-agent* view; the full output always persists in the notebook file regardless — truncation is for the agent's working context, not for durable state. **Output-to-Visual-Verification bridge**: when `run_notebook_cell` produces a base64 image output and `sidecar.visualVerify.enabled` is true, the image auto-flows into the Visual Verification pipeline (cheap checks for blank/clipped/axes-missing, optional VLM for criterion-matching) without the agent having to manually invoke `analyze_screenshot` — so a matplotlib plot in a research notebook gets the same vision-guided correctness loop that the Browser-Agent entry describes for web preview. **Merge-conflict handling**: `.ipynb` merges are notoriously bad in git because the JSON format serializes outputs, execution counts, and cell IDs into the diff. This entry doesn't solve git-level merging (out of scope) but does make SideCar's *own* conflict view cell-aware: when the Audit Mode treeview or Pending Changes panel detects a buffered notebook write colliding with an on-disk change, the three-way merge editor opens at the *cell* granularity rather than the JSON-line granularity. **Integration with every earlier entry**: Research Assistant treats `.ipynb` as a first-class experiment artifact — `run_notebook_all` on an experiment manifest's notebook is the canonical reproduce path; Browser-Agent Visual Verification auto-hooks cell plot outputs; Regression Guards can register `trigger: post-write` with `command: jupyter nbconvert --execute --to notebook --inplace` to enforce that every notebook edit keeps the notebook runnable; Doc-to-Test Loop can synthesize `.ipynb` tests from paper figures (generated cells that reproduce each figure get faithfulness-checked); Fork & Parallel Solve lets each fork contain its own notebook variant for side-by-side methodology comparison; Merkle Index chunks notebooks at the cell level (each cell is its own Merkle leaf, so a one-cell edit re-hashes one leaf not the whole notebook); Project Knowledge Index's symbol extractor recognizes notebook cells as first-class chunks alongside TS/Python functions; Shadow Workspaces run notebooks in the shadow kernel so the main tree's cached outputs aren't perturbed during iteration; Audit Mode's treeview shows per-cell diffs for buffered notebook writes. **Built-in code↔notebook sync** (the feature mentioned in Research Assistant): when a `.py` module and a sibling `.ipynb` both declare a symbol (function, class), the agent keeps them in step — edits to the `.py` module prompt the agent to update the corresponding `.ipynb` cell and vice versa, with conflicts surfaced as a three-way merge. Configured via `sidecar.codeNotebookSync.pairs` (array of `{ module, notebook }` path pairs); absent = no-op. Configured via `sidecar.notebooks.enabled` (default `true` once a notebook is opened or created in the workspace), `sidecar.notebooks.includeOutputsInRead` (default `false` — outputs bloat context; agent asks explicitly when needed), `sidecar.notebooks.maxOutputChars` (default `2000`), `sidecar.notebooks.autoExecuteOnEdit` (default `false` — agent edits don't auto-run cells; explicit `/run` or `run_notebook_cell` is required), `sidecar.notebooks.visualizeOutputsInVLM` (default `true` when Visual Verification is enabled), `sidecar.notebooks.cellGranularDiff` (default `true` — cell-tile view; `false` falls back to raw JSON diff for debugging), and `sidecar.notebooks.templates` (array of template paths for `generate_notebook` beyond the built-ins).

  ```mermaid
  flowchart TD
      A[Agent] --> T{Notebook tool}
      T --> RN[read_notebook<br/>structured cells +<br/>optional outputs]
      T --> EN[edit_notebook_cell<br/>via NotebookEdit.updateCellText]
      T --> IN[insert_notebook_cell<br/>via NotebookEdit.insertCells]
      T --> DN[delete_notebook_cell<br/>via NotebookEdit.deleteCells]
      T --> RC[run_notebook_cell<br/>via NotebookController.executeHandler]
      T --> RA[run_notebook_all<br/>streaming per-cell progress]
      T --> GN[generate_notebook<br/>templates + outline]

      EN & IN & DN --> WE[workspace.applyEdit<br/>WorkspaceEdit with<br/>NotebookEdit entries]
      WE --> IPY[.ipynb on disk]
      WE --> CELL_DIFF[Cell-granular diff<br/>in Pending Changes]

      RC --> OUT{Output kind}
      OUT -->|text / table| TXT[Back to agent,<br/>truncated to maxOutputChars]
      OUT -->|image base64| VV{visualVerify<br/>enabled?}
      VV -->|yes| VVP[auto-flow into<br/>Visual Verification pipeline]
      VV -->|no| TXT
      OUT -->|kernelError| ERR[Structured error +<br/>stack trace to agent]

      GN --> TPL[Built-in templates:<br/>data-exploration /<br/>signal-processing /<br/>paper-figure-repro /<br/>experiment-sweep]

      subgraph Invariants
          FID[Roundtrip fidelity:<br/>read → no-op edit → write<br/>= byte-equal<br/>property-tested]
      end
  ```

### Multi-Agent

- **Literature synthesis & PDF/Zotero bridge** — turns a local folder of research PDFs, Zotero exports, or `.bib` files into a first-class SideCar knowledge source. On activation, a background indexer extracts text from PDFs (via a bundled `pdf-parse` worker), chunks by section heading, embeds with the same local ONNX model used for workspace RAG, and stores vectors in `.sidecar/literature/`. Zotero integration reads the local SQLite database directly (no API key, no cloud sync required) so the full library — notes, tags, collections, and attachments — is available without any export step. BibTeX / CSL-JSON files are also accepted as a lightweight alternative. Once indexed, the agent can answer questions like *"what do the papers in my `/papers/transformers` folder say about positional encoding?"*, auto-generate a related-work section draft grounded in actual citations, detect when a claim in the current document lacks a supporting reference and suggest candidates from the library, and flag duplicate or contradictory findings across sources. Citations are inserted in the format the current document uses (BibTeX key, footnote, or inline author-year) and the corresponding `.bib` entry is added or verified automatically. Configured via `sidecar.literature.paths` (array of folder paths or Zotero DB path), `sidecar.literature.enabled` (default `false`, opt-in), and `sidecar.literature.citationStyle` (`bibtex` | `csl` | `auto`). Surfaced as a *Literature* panel in the sidebar showing indexed sources, a per-paper summary on hover, and a *Cite* command palette entry that fuzzy-searches the library and inserts the reference at the cursor.

- **NotebookLM-Style Source-Grounded Research Mode** — closes the remaining NotebookLM-parity gaps on top of Literature synthesis (the source backend) and the Research Assistant (the project workflow). Four shipped NotebookLM capabilities are absent from SideCar even after those entries ship: (1) **per-answer inline citations in output** — SideCar's retrieval system feeds context to the LLM but doesn't produce NotebookLM's signature `answer [1][2]` rendering where every claim links to the exact source passage that supports it; (2) **multi-modal source ingestion** — YouTube transcripts, web URLs, audio, slides (Literature synthesis covers PDF + Zotero but not the non-paper modalities); (3) **study-aid generators** — NotebookLM auto-produces briefing docs, study guides, FAQs, timelines, and outlines from a source set, all formats SideCar doesn't emit today; (4) **audio podcast overview** — two-voice AI-generated dialogue discussing the sources, NotebookLM's most-talked-about differentiator. This entry adds all four as a coherent *Notebook Mode* layered on the existing substrate. **Citation-rendered output as a first-class format**: a new output contract where the LLM returns a structured response (`{ markdown: string, claims: [{ span: [start, end], sources: [{ sourceId, quote, pageOrTimestamp, confidence }] }] }`) and the chat webview renders clickable inline footnotes over the prose — hovering a `[3]` tooltip previews the exact quoted passage with its provenance (paper + page, YouTube timestamp, web URL + paragraph anchor), clicking opens the source at that location. The model is prompted with a schema-constrained instruction to attach per-claim sources; when it fails to, a fallback pass runs RAGAs-style faithfulness decomposition (from the eval-metrics roadmap entry) to retroactively attach sources to atomic claims, so the citation layer is robust to imperfect model compliance rather than off-or-on. Every answer in Notebook Mode *must* have citations — uncited claims are either flagged (`⚠ unsupported`) or regenerated, configurable via `sidecar.notebookMode.requireCitations` (default `strict`). **Multi-modal source ingestion** extends Literature synthesis's source pipeline with four new source types beyond PDF/Zotero/bib: (a) **YouTube** — URL pasted into the Sources panel triggers transcript fetch via the public captions API (no API key for caption-available videos); missing captions fall back to local Whisper transcription (bundled small-model for the SideCar-native path, configurable to `openai/whisper-large-v3` via cloud or a local Ollama whisper container); timestamps preserved per chunk so citations render as `[Video · 12:34]`. (b) **Web URL** — readability.js (the one Firefox Reader Mode uses) extracts main-article content from HTML, stripping nav/footer/ads/comments, capturing author + date + title metadata; chunked by heading, citations render as `[Article · §Section]`. (c) **Audio** — `.mp3`, `.wav`, `.m4a`, `.ogg` files in the workspace or paste-dropped into Sources; local Whisper transcription with timestamp chunks; citations render as `[Audio · 07:42]`. (d) **Slides** — `.pptx` via a bundled slide extractor, `.pdf` slides via the existing Literature pipeline; chunked by slide, citations render as `[Slides · Slide 14]`. Each source type plugs into the same LanceDB index Literature synthesis uses (once the Project Knowledge Index entry lands; flat file backend as a fallback), so retrieval fuses across modalities transparently — a question answered from a paper + a YouTube talk + a web article returns citations from all three in the same output. **Study-aid generators** — five new agent tools producing structured documents from a source set: `generate_briefing(sourceIds)` emits a multi-section briefing doc (*Executive summary · Key findings · Methodology · Limitations · Open questions*) with every claim cited; `generate_study_guide(sourceIds, { depth? })` produces Q&A pairs at progressive depths (recall → comprehension → application → synthesis) with source-linked answers; `generate_faq(sourceIds)` surfaces the top-N most-likely-asked questions with cited answers; `generate_timeline(sourceIds)` extracts dated events, entities, milestones into a chronological structure rendered as a Gantt-adjacent timeline via the Visualization Dashboards `mcp-viz-*` layer; `generate_outline(sourceIds, depth)` produces a hierarchical topic tree with per-node source attribution. Outputs write to `.sidecar/research/<project>/generated/` as tracked markdown so the user can edit them post-hoc and the team sees them in git. **Topic mind-map** via the existing Visualization Dashboards `d3-force` VizSpec: `generate_mindmap(sourceIds)` runs topic clustering over the source embeddings (k-means or HDBSCAN, default k auto-picked by silhouette score) and renders an interactive force-directed graph where nodes are topics sized by corpus coverage, edges are semantic similarity, and clicking a node reveals the source passages that populate it. The mind map is saved as a reproducible artifact alongside the other generated outputs. **Audio podcast overview** (opt-in, cost-aware): `generate_podcast(sourceIds, { durationMinutes?, style? })` synthesizes a two-voice dialogue between a Host persona and a Co-Host persona discussing the source material; generated as an `.mp3` in `.sidecar/research/<project>/audio/`. The pipeline is two-stage — a scripter pass (main model) produces the turn-taking dialogue with embedded citation markers; a TTS pass voices the two characters via configurable provider (`sidecar.notebookMode.ttsProvider`: `piper` for local free, `openai-tts` / `elevenlabs` for cloud, `off` to disable the feature entirely so users don't trip on TTS infrastructure by accident). Styles (`casual`, `academic`, `debate`, `interview`) adjust the scripter prompt. Cost visibility: the podcast generation shows estimated token + TTS-second cost before dispatch and tracks it in the existing spend-tracker surface. **Sources panel UX** matches the NotebookLM mental model: sidebar panel with a flat list of every source (mixed modality is fine — PDF, YouTube link, web article, audio file all appear together), a checkbox per source to toggle "active" status (inactive sources are visible but excluded from retrieval for this session — useful when you want to focus a question on just two of ten sources without removing the others), per-source last-indexed timestamp, a source-preview pane that renders a cleaned view of the source content with scroll-to-citation navigation. **Notes panel with source-linked snippets** extends the agent memory system with a `notes` namespace: each note anchors to one or more source passages; notes are embedded and searchable alongside other context; when a note's anchor source is cited in an answer, the note auto-surfaces as a margin annotation. Notes persist under `.sidecar/research/<project>/notes/` as tracked markdown files so they're shareable and diffable in git. **Notebook Mode is a top-level activation** — similar to how `agentMode` switches the agent's behavioral posture, `sidecar.notebookMode.enabled` (or `/notebook` slash command) enters source-grounded mode where: retrieval is strictly scoped to active Sources (workspace code is excluded unless explicitly added as a source), citation rendering is mandatory, and the system prompt is replaced with a source-grounded QA persona. Exiting (`/code`) returns to coding-agent mode. **Integration with every earlier entry**: Literature synthesis is the source-backend-for-PDFs branch; Research Assistant's `draft_section` gains a `citations: 'inline'` option that produces citation-rendered output using this entry's renderer; RAG-Native Eval Metrics' **faithfulness** and **context precision** scorers become the regression tests for Notebook Mode output — a measurable "did the citations actually support the claims?" metric; Project Knowledge Index chunks sources at passage-level like it does symbols; Visualization Dashboards render mindmaps and timelines; Model Routing can route TTS to a cheap/local provider via a new `tts` role; Audit Mode isn't relevant (Notebook Mode is read-only by design); Skills 2.0 can ship a `researcher.agent.md` that activates Notebook Mode + pins a specific source set + locks `allowed-tools` to the read-only retrieval surface. **Privacy posture**: cloud TTS (OpenAI, ElevenLabs) sends the generated dialogue to a third party — the source content itself isn't sent, just the model's script. Users preferring full local-first keep `ttsProvider: 'piper'` which runs fully on-device. Audio source transcription defaults to local Whisper for the same reason. Configured via `sidecar.notebookMode.enabled` (default `false` — opt-in), `sidecar.notebookMode.requireCitations` (`strict` | `advisory` | `off`, default `strict`), `sidecar.notebookMode.sources.youtube` / `.webUrl` / `.audio` / `.slides` (default `true` for web+slides, `false` for YouTube/audio until the user has calibrated quotas), `sidecar.notebookMode.transcriptionModel` (default `local-whisper-small`; override to cloud for better accuracy), `sidecar.notebookMode.ttsProvider` (default `off` — users opt in explicitly when they want the podcast feature), `sidecar.notebookMode.ttsVoices` (default `{ host: 'en-US-1', coHost: 'en-US-2' }`), and `sidecar.notebookMode.studyAids.enabled` (default `true`; set `false` to hide the generator tools in a lean setup).

  ```mermaid
  flowchart TD
      subgraph Sources ["Sources panel"]
          PDF[PDF / Zotero<br/>via Literature synthesis]
          YT[YouTube URL<br/>captions → Whisper fallback]
          WEB[Web URL<br/>readability.js]
          AUD[Audio file<br/>local Whisper]
          SLD[Slides .pptx / .pdf]
      end
      Sources --> IDX[LanceDB index<br/>passage-level chunks<br/>+ modality metadata]
      U[User question<br/>in Notebook Mode] --> Q[Query embedding]
      Q --> IDX
      IDX --> HITS[Multi-modal hits<br/>ranked by fusion]
      HITS --> GEN[LLM generation<br/>with schema-constrained<br/>claims + sources]
      GEN --> CHECK{Every claim<br/>cited?}
      CHECK -->|no, strict mode| FIX[Faithfulness fallback<br/>attach sources per claim]
      CHECK -->|yes| RENDER[Webview renders<br/>&lt;answer&gt;[1][2] with<br/>hover-preview tooltips]
      FIX --> RENDER

      subgraph Outputs ["Study aids + media"]
          BR[generate_briefing]
          SG[generate_study_guide]
          FAQ[generate_faq]
          TL[generate_timeline → Viz Dashboard]
          OU[generate_outline]
          MM[generate_mindmap → d3-force]
          PC[generate_podcast → TTS pipeline]
      end
      IDX --> BR & SG & FAQ & TL & OU & MM & PC
      BR & SG & FAQ & TL & OU --> SAVE[.sidecar/research/generated/<br/>tracked markdown]
      MM --> VIZ[Visualization Dashboard tile]
      PC --> AUDIO[.sidecar/research/audio/*.mp3]
  ```


- **Worktree-isolated agents** — each agent in its own git worktree
- **Agent dashboard** — visual panel for running/completed agents
- **Multi-agent task coordination** — parallel agents with dependency layer
- **Remote headless hand-off** — detach tasks to run on a remote server via `@sidecar/headless` CLI
- **Human-in-the-Loop Steerability** — lets you send a follow-up message while the agent loop is still running to correct its course without stopping and restarting the entire process. If you see the agent misinterpreting a task mid-execution you can type something like "focus on the formula, ignore the other part for now" — or a library veto like "wait, don't use numpy for this, use the custom math kernels instead" — and the loop pivots immediately: the new message is injected into the live message history as a synthetic user turn, the current streaming response is gracefully interrupted via the existing `AbortSignal`, and the next iteration picks up with the corrected intent. The existing checkpoint callback (`onCheckpoint`) and mid-run abort infrastructure provide the foundation; this feature extends them with a non-destructive steer path that preserves all prior tool results and context rather than wiping the conversation. Configurable urgency levels: `nudge` (injected at next iteration boundary), `interrupt` (aborts the current stream immediately), and `hard-stop` (existing full abort). Surfaced in the chat UI as a persistent input field that stays active while the progress bar is visible.

  **Steer queue & rich interrupt UI.** Because the agent may be deep in a long tool call (a large `npm test` run, a multi-file grep) when the user types, steers have to queue rather than race. A new `SteerQueue` service backs the persistent input: each submission becomes a `QueuedSteer { id, text, urgency, createdAt }` appended FIFO. At the next iteration boundary, the loop drains the queue — if multiple steers have accumulated at the same urgency level they're coalesced into one synthetic user turn prefixed with `Your running instructions (most recent last):` so intent ordering is preserved, but only a single turn is charged against message budget. `interrupt`-urgency steers jump the queue and fire the abort immediately; any `nudge` steers queued behind them still apply at the next boundary. A compact **Steer Queue** strip above the input shows pending items with badges (`🟡 nudge`, `🔴 interrupt`), each with inline *Edit* / *Cancel* buttons so the user can refine or retract a steer before it lands — particularly useful when the user realizes the agent already caught their concern on its own and the steer is no longer needed. Queue state persists through stream-failure/resume so a crash mid-turn doesn't silently drop queued instructions. Configurable via `sidecar.steerQueue.coalesceWindowMs` (default `2000` — merge steers submitted within this window into one turn) and `sidecar.steerQueue.maxPending` (default `5`, clamped to guard against runaway input that would bury the agent's context).
- **Thinking / Reasoning Mode** — a hidden reasoning chain that runs before the agent touches any code. The agent debates approaches in a private scratchpad, weighing trade-offs and checking for codebase-wide impact, before committing to an implementation. The user sees only the final code output, but can expand a collapsible **Thinking** block in the chat UI to inspect the full reasoning trace. Controlled via `sidecar.thinkingMode` (`off` / `auto` / `always`). For providers that expose native extended-thinking (Anthropic `claude-3-7-sonnet` and later), SideCar forwards the budget token parameter directly; for all other models a structured `<think>…</think>` prompt wrapper is injected and the block is stripped from the visible response before rendering.

  ```mermaid
  sequenceDiagram
      participant U as User
      participant A as Agent
      participant S as Scratchpad (hidden)
      participant C as Codebase

      U->>A: Prompt
      A->>S: Begin reasoning chain
      S->>C: Explore — read files, grep, find_references
      S->>S: Debate approaches & trade-offs
      S->>S: Check for broader codebase impact
      S-->>A: Settled implementation plan
      A->>C: Write / edit files
      A->>U: Final code output
      Note over U: Can expand ▶ Thinking block<br/>to see full reasoning trace
  ```

- **Advanced Thinking Visualization & Depth Control** — extends the basic Thinking/Reasoning Mode above from "hidden scratchpad you can expand after the fact" to a first-class, **live-streaming, user-steerable reasoning surface** with explicit depth knobs, self-debate structures, and a dedicated panel separate from the main chat. Today SideCar's reasoning is tied directly to the model's standard output — a single stream that either appears in the final message or (for providers with native `thinking` blocks) gets quietly elided. That flattens several distinct things the user actually wants to see: "is the agent considering the right alternatives?", "did it notice the edge case I'm worried about?", "how much of this reasoning should I bother reading?", and the blunt "think harder on this one — I'll pay for it." This entry gives each its own surface. **Explicit depth control** replaces the current off/auto/always tri-state with a budget ladder the user drives per prompt: `/think` (default budget), `/think harder` (~2× budget), `/think longer` (~4× budget and time-tolerant), `/think <tokens>` (explicit cap, e.g. `/think 8000`), and inline sentinels `@deep` / `@pro` (re-using the Model Routing sentinels so `@opus @deep` escalates both the model *and* the thinking budget together in one token). Budget is enforced by forwarding the `budget_tokens` parameter on Anthropic Extended Thinking for supported models, and for other providers by a soft cap in the injected `<think>…</think>` wrapper with a stop sequence honoring the budget. **Live Thinking Panel**: a dedicated sidebar panel (not an inline collapsed block in the chat transcript — that one stays as the low-ceremony default) that streams the reasoning token-by-token as it's produced, rendered in a distinct visual treatment (dimmed foreground, serif, narrower column) so it doesn't compete with the main answer for attention. Each structural section — `Considering…`, `Counterpoint…`, `Checking against…`, `Concluding…` — gets a collapsible header so the user can fold sections they don't care about as they stream. Clicking a file path or symbol in the thinking trace jumps the editor to that location. **Four thinking modes** selectable per-prompt or via `sidecar.thinking.mode`: `single` (current behavior — one linear chain); `self-debate` (model is prompted to hold a two-voice internal dialogue — *Proposer* puts forward an approach, *Skeptic* stress-tests it, convergence required before final output; the panel renders this as two columns so the user sees the argument, not just the conclusion); `tree-of-thought` (branching exploration with explicit pruning — at each branch point the model emits 2-4 candidates, scores them, and commits to one; the panel renders this as a collapsible tree with cost/score annotations); `red-team` (the model first drafts a candidate solution, then adversarially tries to break it for a second pass, then revises — useful when correctness matters more than speed). Mode choice is suggested automatically based on the task: `self-debate` for design decisions and API-shape questions, `tree-of-thought` for algorithmic exploration, `red-team` for security-sensitive or math-heavy changes, `single` for everything else — overridable per-prompt. **Live steering of the thinking phase**: because thinking visibly streams, the user can intercept it with the existing Steer Queue (`@think consider also the Z-transform case`, `@think stop, just ship the simpler one`) instead of waiting for the thinking to end and then re-asking. An *Interrupt thinking* button next to the panel aborts just the reasoning phase and jumps to output based on whatever was converged so far. **Citation-backed thinking**: when thinking references a file / symbol / doc, the reference is emitted as a structured `[[path/file.ts:42]]` token the panel renders as a clickable link with a hover-preview of the cited span — so "I'm checking the existing validation in `authMiddleware`" is verifiable in one click rather than a dead string. This composes directly with the Project Knowledge Index: the thinking panel can show inline "retrieval hits" used to form the reasoning, making it explicit what context the model was working from. **Thinking traces are saved as artifacts** at `.sidecar/thinking/<task-id>.md` (another gitignored subdir) so the user can re-open, annotate, share with a teammate, or paste into a PR description; a `/replay <task-id>` command re-ingests a saved trace as seed context for a follow-up task, so you don't pay tokens to reason through the same design decision twice. **Cost and time visibility**: the panel header shows live token count / cost / elapsed time, with a pulsing "⏱ thinking…" indicator; when a budget cap is about to trip, the user gets a one-click *Extend by 4k tokens* nudge rather than having the thinking silently truncate. **Composes with every earlier entry**: War Room is the multi-*agent* version of this (separate critic agent with its own model); this entry is the single-agent version so they're complementary not redundant; Fork & Parallel Solve shows each fork's thinking trace in its own column for side-by-side comparison of how each approach reasoned; Model Routing can point thinking to a cheaper model while output goes to the expensive one (`rule: when="thinking" model="claude-haiku-4-5"; when="agent-loop" model="claude-opus-4-6"` — a "cheap thinker + expensive writer" pattern that often outperforms a single-model run because thinking is often pattern-matching-ish where raw intelligence matters less than volume); Visualization Dashboards can render the `tree-of-thought` branching as a live D3 tree in the panel itself; Shadow Workspaces can be pre-populated with the thinking's proposed file list so the agent's writes and the user's review start already scoped to the right surface. Configured via `sidecar.thinking.visualization` (`hidden` | `collapsed-inline` | `panel` | `both`, default `collapsed-inline` so nothing visually changes until the user opts in), `sidecar.thinking.mode` (`single` | `self-debate` | `tree-of-thought` | `red-team` | `auto`, default `auto`), `sidecar.thinking.defaultBudget` (default `2000` tokens), `sidecar.thinking.maxBudget` (hard ceiling, default `20000`), `sidecar.thinking.persistTraces` (default `true` — saves to `.sidecar/thinking/`), `sidecar.thinking.showInlineCitations` (default `true`), and `sidecar.thinking.autoModeHeuristic` (default `true` — auto-picks `self-debate` / `tree-of-thought` / `red-team` based on task classification; set `false` to always use `single` unless explicitly requested).

  ```mermaid
  flowchart TD
      U[User prompt<br/>+ optional depth cue<br/>/think harder @deep] --> B[Budget resolution<br/>defaultBudget × multiplier]
      B --> MODE{Mode selector}
      MODE -->|auto + task cues| AUTO[auto → self-debate /<br/>tree-of-thought / red-team]
      MODE -->|explicit| EX[user-chosen mode]
      AUTO & EX --> T[Begin thinking phase]
      T --> PANEL[Live Thinking Panel<br/>streams token-by-token]
      T --> STEER{Steer Queue<br/>nudge during thinking?}
      STEER -->|yes| INJ[Inject into scratchpad<br/>redirect reasoning]
      STEER -->|no| CONT[Continue]
      INJ --> PANEL
      PANEL --> CITE[Inline citations<br/>[[file:line]] → clickable]
      T --> C[Convergence / budget hit]
      C --> SAVE[Persist to<br/>.sidecar/thinking/<task-id>.md]
      C --> OUT[Final output generation]
      OUT --> U
      SAVE --> REPLAY[/replay task-id<br/>reuses trace as seed]
  ```

- **Multi-agent War Room** — a red-team review layer that runs before output ever reaches the user. A lead *Critic Agent* adversarially challenges the coding agent's solution (logic, security, edge cases, architecture), the coding agent rebuts and revises, and the exchange continues for a configurable number of rounds until the critic is satisfied or escalates to the user. The full debate is streamed live in a dedicated *War Room* sidebar panel so you can watch the agents argue in real time. Builds on the existing `runCriticChecks` / `HookBus` infrastructure — the critic becomes a first-class peer agent rather than a post-turn annotation pass. Configurable via `sidecar.warRoom.enabled`, `sidecar.warRoom.rounds` (default: 2), and `sidecar.warRoom.model` (can point to a different, cheaper model for the critic role).

- **Typed Sub-Agent Facets & Expert Panel** — upgrades the existing untyped `spawn_agent` tool into a first-class specialization system. Instead of one generic coder, SideCar gains a registry of *facets* — typed specialist definitions declared in `.sidecar/facets/<facet>.md` with frontmatter `{ id, displayName, systemPrompt, toolAllowlist, preferredModel, skillBundle, rpcSchema }`. Built-in facets ship for common roles: `general-coder`, `latex-writer`, `signal-processing`, `frontend`, `test-author`, `technical-writer`, `security-reviewer`, `data-engineer` — each pre-wired to the matching Claude skill bundles already in the available-skills list (signal-processing, technical-paper, react, cybersecurity-architecture, etc.) and to a sensible tool allowlist (a `latex-writer` doesn't need `run_shell_command`; a `security-reviewer` gets `grep` + `find_references` but no `write_file`). A new **Expert Panel** in the sidebar lists available facets with multi-select checkboxes and a single shared task input; hitting *Dispatch* spawns each selected facet concurrently, each in its own Shadow Workspace (see previous entry) off the current `HEAD`, so parallel specialists don't clobber each other's files or the main tree. **Typed RPC across facets** is how they coordinate: each facet declares a schema in its frontmatter (`rpcSchema: { publishMathBlock(symbol: string, latex: string): void; requestSymbolDefinition(symbol: string): { definition: string, sourceFile: string } }`) and the runtime generates a typed `rpc.<facet>.<method>` tool per peer at dispatch time — no free-form message passing, no stringly-typed coordination, only the declared surface. The signal-processing facet writing a new FFT implementation calls `rpc.latex_writer.publishMathBlock("fft", "X_k = \\sum_{n=0}^{N-1} x_n e^{-i2\\pi kn/N}")`; the latex-writer facet receives the RPC and updates `paper.tex` at the matching cite-key in the same beat. Code and documentation stay locked together by construction. RPC calls are logged to a *Facet Comms* tab showing the full wire trace for post-hoc review, and cycles are prevented at dispatch by requiring facets to declare an acyclic dependency graph (`dependsOn: ['signal-processing']`). On completion each facet's shadow emits its own diff; the Expert Panel shows a unified multi-facet review where the user can accept per-facet or per-hunk, and a single bulk merge commits them in topological order with co-authored-by attribution per facet. Configured via `sidecar.facets.registry` (array of facet file paths, merged with built-ins), `sidecar.facets.maxConcurrent` (default `3` — guards GPU/context pressure when several specialists share the same local model), `sidecar.facets.rpcTimeoutMs` (default `30000`), and `sidecar.facets.enabled` (default `true`).

  ```mermaid
  sequenceDiagram
      participant U as User
      participant E as Expert Panel
      participant SP as signal-processing facet
      participant LX as latex-writer facet
      participant R as RPC Bus

      U->>E: Select [signal-processing, latex-writer] + task
      E->>SP: Dispatch in shadow-sp/
      E->>LX: Dispatch in shadow-lx/
      par Parallel specialist work
          SP->>SP: Implement fft.py in shadow-sp/
      and
          LX->>R: rpc.signal_processing.getEquationForm("fft")
          SP-->>R: LatexExpr { tex: "X_k = ..." }
          R-->>LX: LatexExpr
          LX->>LX: Update paper.tex in shadow-lx/
      end
      SP->>R: rpc.latex_writer.publishMathBlock("fft", "...")
      R-->>LX: notify
      LX->>LX: Verify equation matches inserted \label
      SP-->>E: Gate green, shadow-sp diff ready
      LX-->>E: Gate green, shadow-lx diff ready
      E->>U: Unified multi-facet review (code + docs locked)
      U->>E: Accept all
      E->>U: Bulk merge in topological order
  ```

- **Fork & Parallel Solve (Multi-Path Reasoning)** — forks a single task into N parallel agent sessions, each constrained to a distinct implementation approach, so the user can compare concrete solutions head-to-head instead of relying on the agent (or themselves) to pick the right strategy up front. This is a different multi-agent pattern from Facets (different specialists, different tasks) and the War Room (adversarial critic + coder, same approach): here it's **one task, N approaches, side-by-side diffs**, and the user picks the winner empirically after seeing real code and real test results. The canonical scenario: a signal-processing task where the user wants to know whether a Fourier-transform or wavelet decomposition is the right call — instead of debating in prose, SideCar implements both in parallel and the user sees the actual LOC delta, test pass rate, benchmark numbers, and frequency-response plots side by side before committing to either. **Invocation**: `/fork <task>` with either user-specified approaches (`/fork "implement the low-pass filter" using fourier, wavelet, iir`) or a planning pass where the agent proposes N distinct approaches with one-line rationale each; the user ticks which ones to run. **Execution**: each approach gets its own Shadow Workspace off the same `HEAD` (built on the Shadow Workspaces feature — the shared git ODB keeps N shadows cheap), a dedicated agent session, and a system-prompt constraint (`You must implement this task using {approach}. Do not pivot to another approach mid-iteration — if you hit a wall, report it and stop.`). Agents run concurrently up to `sidecar.fork.maxParallel` — parallel on API backends where tokens are the only constraint, serialized on local models where VRAM contention would kneecap throughput (auto-detected via the GPU-Aware Load Balancing signal once that ships; until then via an explicit `sidecar.fork.serializeOnLocal` knob, default `true`). **Comparison dimensions**: each finished fork surfaces (1) the full diff, (2) LOC added/removed/changed, (3) test pass/fail from the existing completion gate, (4) Regression Guard results (any fork failing a `blocking: true` guard is marked ⚠ but still shown for informational comparison), (5) benchmark deltas where `pytest-benchmark` / `criterion` / `vitest bench` data is available, (6) cyclomatic complexity via tree-sitter, (7) dependency additions (each new import counted), and (8) the agent's own stated trade-offs for its approach. Composes with the Visualization Dashboards: if the fork touches code a registered visualizer understands, each approach's viz is rendered in its own column (Fourier gets a frequency-response plot, wavelet gets a scalogram, side by side). Composes with the Doc-to-Test Loop: if the task was synthesized from a spec document, the same generated test suite runs against every fork, so adherence to the paper becomes a quantitative tiebreaker. **UI**: a *Fork Review* panel with one column per approach — name, status badges (gate/guards/tests), metrics table at the top, tabbed or split diff view, per-column *Accept* button, a *Hybrid* mode that opens a cherry-pick view where the user can pull hunks from multiple approaches into a new unified change set (useful when Approach A got the algorithm right but Approach B got the API surface right), and a *Re-fork with feedback* action that spawns a new round with the user's notes fed back as constraint additions. Optional *Judge* mode: `sidecar.fork.judgeModel` (default empty) can point to a small local model that scores each approach on user-declared criteria (`sidecar.fork.judgeCriteria`, array of free-form strings like `"prefer fewer dependencies"`, `"favor readability over micro-performance"`, `"match existing code style"`) — the judge's reasoning is shown but non-binding; the user always picks. **Steer Queue integration**: the user can steer individual forks mid-run rather than all of them (`@fourier try a sharper rolloff` delivers a nudge to only that fork's queue). **Cost controls**: a visible token/cost estimator per fork before dispatch, `sidecar.fork.maxParallel` (default `3`) to prevent accidental 10-way spawns, and `sidecar.fork.haltOnGuardFail` (default `true` — a fork that hits a `blocking` guard failure mid-iteration stops early rather than burning tokens to completion, since a failed guard means the user won't pick it anyway). **Leverages VS Code's native chat-session infrastructure** where available (the session-fork surface introduced in VS Code 1.110+) — when the user is in the native Chat panel via the `@sidecar` participant, `/fork` opens each branch as a proper VS Code chat session fork so the conversation history tree persists in VS Code's own UI; in the SideCar webview the same state is mirrored in the existing session store. Configured via `sidecar.fork.enabled` (default `true`), `sidecar.fork.maxParallel` (default `3`), `sidecar.fork.autoProposeApproaches` (default `false` — when `true`, `/fork <task>` without an explicit approach list triggers the planning pass automatically), `sidecar.fork.judgeModel` (default empty), `sidecar.fork.judgeCriteria` (default `[]`), `sidecar.fork.haltOnGuardFail` (default `true`), and `sidecar.fork.serializeOnLocal` (default `true`).

  ```mermaid
  sequenceDiagram
      participant U as User
      participant P as Planner (optional)
      participant FM as Fork Manager
      participant A1 as Agent [Fourier]
      participant A2 as Agent [Wavelet]
      participant R as Fork Review panel

      U->>FM: /fork "low-pass filter" fourier, wavelet
      opt user omitted approaches
          FM->>P: propose N approaches
          P-->>U: [fourier, wavelet, iir] — confirm?
          U-->>FM: pick [fourier, wavelet]
      end
      par Parallel shadows
          FM->>A1: shadow-fourier + constrained prompt
          A1->>A1: implement + test + bench
      and
          FM->>A2: shadow-wavelet + constrained prompt
          A2->>A2: implement + test + bench
      end
      A1-->>R: diff, LOC, tests, guards, bench, viz
      A2-->>R: diff, LOC, tests, guards, bench, viz
      R-->>U: Side-by-side columns with metrics
      alt Pick one
          U->>R: Accept Fourier
      else Hybrid
          U->>R: Cherry-pick hunks across columns
      else Re-fork
          U->>FM: feedback → new round with refined constraints
      end
  ```

### User Experience

- **Integrated LaTeX Preview & Compilation** — a first-class technical writing workflow built on top of the agent tool system. The agent gains a `write_latex` tool that creates and edits `.tex` files with full awareness of document structure (preamble, environments, bibliography). A background compilation watcher runs `latexmk` (or `tectonic` as a zero-config fallback) on every save, parses the log for errors and undefined citations, and surfaces them as inline diagnostics in the editor. A *Ghost Preview* panel opens beside the source and renders the compiled PDF (or a KaTeX/MathJax live render of the current math block when a full compile is pending), giving a true side-by-side experience without leaving VS Code. Bibliography integrity is checked separately — missing `\cite{}` keys and malformed `.bib` entries are flagged before the compile even runs. Configurable via `sidecar.latex.compiler` (`latexmk` | `tectonic`), `sidecar.latex.ghostPreview.enabled`, and `sidecar.latex.bibCheck.enabled`.
- **Background doc sync** — silently update README/JSDoc/Swagger when function signatures change *(2/3 shipped: [JSDoc staleness diagnostics](src/docs/jsDocSync.ts) flag orphan/missing `@param` tags with quick fixes; [README sync](src/docs/readmeSync.ts) flags stale call arity in fenced code blocks with rewrite quick fixes. Swagger deferred — framework-specific, no in-repo OpenAPI spec to dogfood against; will revisit when a real use case lands.)*
- **Zen mode context filtering** — `/focus <module>` to restrict context to one directory
- **Semantic Time Travel** — a local-first capability unique to self-hosted tooling: SideCar walks the full `git log` and builds a per-commit semantic index (tree-sitter AST + embeddings) stored in `.sidecar/cache/history/`. This lets you ask natural-language questions against *any point in your project's past* — e.g. *"How did I handle auth token refresh back in December?"* or *"Show me the version of `parseConfig` before the v2 refactor"*. The retriever resolves temporal references (`"last December"`, `"before the v2 refactor"`, `"two months ago"`) to a commit range via `git log --after / --before`, runs the semantic search over that slice of the index, and returns annotated snippets with their commit hash, date, and author — none of which need to exist in the current working tree. A `time_travel_search` agent tool exposes this to the agent loop so it can autonomously pull historical context when debugging regressions. Configurable via `sidecar.timeTravelIndex.enabled`, `sidecar.timeTravelIndex.maxCommits` (default: `500`), and `sidecar.timeTravelIndex.embeddingModel`.
- **Dependency drift alerts** — real-time feedback on bundle size, vulnerabilities, and duplicates when deps change

- **Inline Code Visualization Dashboards (MCP-backed)** — upgrades the existing one-shot `display_diagram` tool (Mermaid-only, static) into a first-class live visualization layer driven by pluggable MCP servers. When the agent generates or modifies code, a *Visualization* pane renders **inline in the chat panel directly beneath the diff**, showing the architectural or behavioral impact of the proposed change so the user can visually verify correctness before hitting Accept — instead of staring at a raw diff and mentally simulating what it does. A new MCP contract defines a single tool `render_visualization(spec: VizSpec, artifacts: ArtifactRef[])` where `VizSpec` is a typed discriminated union (`mermaid` | `vega-lite` | `plotly` | `d3-force` | `ast-tree` | `flamegraph` | `ui-component-tree` | `api-surface-diff` | `dataflow` | `state-machine` | `frequency-response` | `erd`) and `artifacts` are file references the server can load from the current Shadow Workspace (never from the main tree — visualizations must reflect the agent's proposed state, not the disk state) or from a git ref for before/after comparisons. Concrete scenarios: agent refactors `AuthProvider` → dashboard shows class-hierarchy diff (original vs proposed) with changed edges highlighted; agent implements a FIR filter → dashboard renders the magnitude/phase response plot so the user can eyeball that the cutoff is in the right place; agent rewrites a Redux reducer → dashboard shows state-machine transitions with any unreachable or dead states marked; agent modifies a React component tree → renders the tree with prop-flow arrows; agent changes a REST handler → renders an OpenAPI-style diff of the API surface; agent writes a new SQL migration → renders the ERD with added/removed/altered tables and FK edges highlighted. Visualizations are **interactive** (pan, zoom, click-to-expand, hover-for-source) rather than static images — clicking a node in a class diagram jumps the cursor to the corresponding source line in the diff. **Real-time streaming updates**: the MCP server emits `VizPatch` events as the agent iterates so the visualization evolves alongside the code rather than only materializing at turn-end — a user watching the filter plot appear can interrupt with a steer (via the Steer Queue) the moment the curve heads in the wrong direction, long before the agent finishes writing the file. Security: all rendering happens in a sandboxed iframe with a strict CSP (`script-src 'self'`, `connect-src 'none'` — viz libraries execute but can't fetch anything), spec types are validated against a JSON schema before rendering (malformed specs are dropped with a visible error, never partial-rendered), and each MCP server runs under the existing workspace-trust gate. Integration with other roadmap items: *Pending Changes* view gets a *Visualize* button per-hunk; *Shadow Workspaces* surfaces a full-screen architectural preview in the review panel before merge; *Audit Mode* shows a thumbnail viz next to each buffered write in the treeview; *Doc-to-Test Loop* renders constraint-to-test coverage as a matrix; *Facets* can expose facet-specific visualizers (the `signal-processing` facet auto-selects `frequency-response` and `phase-response` as defaults). Four visualizers ship bundled — `mcp-viz-mermaid` (interactive Mermaid with pan/zoom/click-to-source), `mcp-viz-ast` (tree-sitter-driven AST render with diff highlighting), `mcp-viz-deps` (module dependency graph as force-directed D3), `mcp-viz-plots` (Plotly-backed scientific plots driven by a Python subprocess for numeric code) — and any MCP server that implements the contract becomes a drop-in visualizer. Configured via `sidecar.dashboard.enabled` (default `true`), `sidecar.dashboard.mcpServers` (merge with built-ins — same shape as `sidecar.mcpServers`), `sidecar.dashboard.autoVisualize` (`off` | `on-review` | `on-every-turn`, default `on-review` — auto-renders only while a pending change is open for review, keeps token/compute budget predictable), `sidecar.dashboard.allowedVizTypes` (allowlist; empty = all bundled types), and `sidecar.dashboard.maxRenderTimeMs` (default `5000` — guards against pathological specs that would spin the webview).

  ```mermaid
  sequenceDiagram
      participant A as Agent
      participant S as Shadow Workspace
      participant M as Dashboard MCP server
      participant C as Chat panel webview
      participant U as User

      A->>S: write_file / edit_file
      S->>M: artifact refs + change notification
      M->>M: render_visualization(spec, artifacts)
      loop streaming updates
          M-->>C: VizPatch (CSP-sandboxed iframe)
          C-->>U: Inline render under diff
      end
      U->>U: Inspect, pan/zoom, click-to-source
      alt Visual check fails
          U->>A: Steer (via Steer Queue nudge)
          A->>S: revise
      else Visual check passes
          U->>C: Accept change
      end
  ```

- **`@sidecar` Native Chat Participant** — registers SideCar as a first-class participant in VS Code's native Chat panel via `vscode.chat.createChatParticipant`, so users can invoke the agent from the same surface they use for Copilot Chat (`@sidecar explain this`, `@sidecar /review`, `@sidecar /commit-message`) without ever opening the SideCar webview. This is additive, not a replacement — the existing webview keeps its richer affordances (streaming diff previews, Pending Changes tree, Audit Mode treeview, Shadow Review panel, Visualization Dashboards) that don't map cleanly onto the native Chat UI. The participant is for the large class of interactions that don't need any of that: "what does this function do", "suggest a better name for `foo`", "summarize this module", "/review". The participant auto-receives the active editor's selection and `#file` / `#editor` / `#selection` chat variables via `ChatRequest.references`, slash commands register as declared `ChatParticipantSlashCommand` entries (reusing the review / commit-message / pr-summary implementations already shipped in the webview — one source of truth, two surfaces), and responses stream via `ChatResponseStream` using SideCar's backend regardless of the chat panel's top-level model picker (so your configured Kickstand / Ollama / Anthropic model answers, not whatever the panel defaults to). A second, separable piece of the feature registers SideCar's backends as `LanguageModelChat` providers via `vscode.lm.registerChatModelProvider`, which surfaces Kickstand / Ollama / OpenRouter / Groq / Fireworks / Anthropic as selectable models in *any* chat participant's model picker — not just SideCar's — turning SideCar into a local-first model gateway for the entire VS Code chat ecosystem. **Tool calls that need rich approval redirect to the webview** rather than degrading in the native panel: when `@sidecar /fix` would call `write_file`, the participant posts a `ChatResponseMarkdown` with a one-click *Open in SideCar to review* button that pre-loads the task in the webview with full diff/approval affordances; read-only tool calls (`read_file`, `grep`, `get_diagnostics`, `find_references`, `git_*`) stream their output inline since they don't need approval. Follow-up prompts are suggested via `ChatResponseFollowup` — after a `/review` the participant offers "Apply the first suggestion" / "Show me the line in context". Participant icon, display name, and a short description appear in the chat welcome ("@sidecar — your local-first coding assistant"). The native and webview chats share session history via a common store in `.sidecar/sessions/` (already an ignored subdir per the Shadows carve-out) so switching surfaces mid-conversation is seamless. Configured via `sidecar.chatParticipant.enabled` (default `true`), `sidecar.chatParticipant.slashCommands` (allowlist of enabled commands, default includes `review`, `explain`, `commit-message`, `pr-summary`, `test`, `fix`), `sidecar.chatParticipant.provideModels` (default `true` — registers SideCar backends as LanguageModelChat providers), `sidecar.chatParticipant.redirectToWebviewForWrites` (default `true` — read-only tools run inline, write tools redirect), and `sidecar.chatParticipant.sharedSessionStore` (default `true`).

  ```mermaid
  sequenceDiagram
      participant U as User
      participant C as VS Code Chat panel
      participant P as @sidecar participant
      participant B as SideCar backend<br/>(Kickstand/Ollama/Anthropic)
      participant W as SideCar webview

      U->>C: @sidecar /review
      C->>P: ChatRequest (refs: active file, selection)
      P->>B: streamChat via configured backend
      B-->>P: ChatResponseStream tokens
      P-->>C: inline rendered in native chat
      alt Tool call needs approval (write_file)
          P->>C: 'Open in SideCar to review' button
          U->>W: click → webview loads with task<br/>full diff + Pending Changes
      else Read-only tool call
          P->>C: Inline streamed tool output
      end
  ```

### Observability

- **RAG-Native Eval Metrics (RAGAs) + Qualitative LLM-as-Judge (G-Eval)** — reopens the LLM-as-judge scoring deferral from v0.50 (documented at [ROADMAP.md](ROADMAP.md) under *Eval harness gaps*: "deterministic predicates give crisper regression signal than a second-model scoring hop, so this was intentionally skipped... reopen if we start shipping features where correctness is fuzzy rather than binary"). The deferral holds up for the features that existed at v0.50 — tool-trajectory assertions, file-state substring matches, mustContain/mustNotContain predicates on final output were the right call. But the features added since and pending across this ROADMAP (Project Knowledge Index with graph-fusion retrieval, Merkle-addressed fingerprints, Fork & Parallel Solve with its Judge mode, Doc-to-Test constraint extraction, Browser-Agent Visual Verification, Thinking Visualization modes) all have correctness surfaces that *are* fuzzy — retrieval quality, answer faithfulness, reasoning coherence, visual-check calibration — and trying to keep these honest with only deterministic predicates leaves a regression blind spot. This entry extends the existing [tests/llm-eval/](tests/llm-eval/) harness with two complementary metric layers, kept additive: deterministic predicates still gate on `mustContain` and tool trajectories (cheap, reliable, first line of defense); fuzzy metrics layer on top as optional per-case expectations the CI also gates on. **Layer 1 — RAGAs metrics for retrieval-augmented features** (Project Knowledge Index, monorepo cross-repo search, Literature synthesis, Memory Guardrails): four core scorers implemented as JS-native LLM-as-judge calls, not a Python subprocess dependency on the ragas package — the metrics are simple enough to reimplement cleanly (each is a prompt + a parser), and the VS Code extension shouldn't drag Python into its deployment story. (1) **Faithfulness** — does the generated answer *only* claim things supported by retrieved context? Judge decomposes the answer into atomic claims, then for each claim asks "is this entailed by the retrieved context?"; score = entailed_claims / total_claims. Catches hallucination where the agent invents facts not in retrieved docs. (2) **Answer Relevancy** — does the answer actually address the user's question? Judge generates N alternative questions the answer *would* have correctly responded to, compares their embedding to the original question's, scores by mean cosine similarity. Catches off-topic drift. (3) **Context Precision** — did retrieval rank relevant chunks *higher* than irrelevant ones? Judge rates each returned chunk as relevant / irrelevant to the ground-truth answer, then computes mean reciprocal rank weighted by relevance. Catches "the right file was in position 8 but position 1 was a red herring" regressions that a flat "was the right file retrieved?" metric misses. (4) **Context Recall** — did retrieval find *all* the chunks needed for the ground-truth answer? Judge decomposes the ground truth into atomic claims, for each asks "is there a retrieved chunk that supports this?"; score = supported_gt_claims / total_gt_claims. Catches missing-needle failures that only Context Precision can't detect. Cases declare these via a new `rag` expectations block: `expect: { rag: { faithfulness: { min: 0.85 }, contextPrecision: { min: 0.7 }, contextRecall: { min: 0.8 } } }`. **Layer 2 — G-Eval qualitative scoring for fuzzy output aspects** (coherence, correctness on ambiguous tasks, style, custom criteria) implemented as a generic LLM-as-judge scorer with a common chain-of-thought template inspired by DeepEval's G-Eval — again re-implemented in TS rather than shelled out to the Python package. Each G-Eval scorer takes a name, a description of what's being measured, and a 1-N rating scale; the judge generates a CoT reasoning trace, then emits a numeric score with justification. Built-in criteria ship pre-tuned: **coherence** (does the response follow a logical structure?), **correctness** (given the task description, is the output free of errors?), **relevance** (does it address what was asked?), **fluency** (well-formed prose), **actionability** (can the user act on the answer without clarification?); custom criteria are user-declarable via `sidecar.eval.gEvalCriteria` with a name, description, and scale. Used by cases as `expect: { gEval: { coherence: { min: 7 }, correctness: { min: 8 } } }`. Judge's full reasoning is captured in the eval report so regressions come with *why* they're regressions, not just "score dropped 0.4 → 0.3." **Shared LLM-as-judge primitive** backs both layers at [tests/llm-eval/scorers/llmJudge.ts](tests/llm-eval/scorers/llmJudge.ts) — a single dispatch point that handles judge-model routing (via Model Routing rules' `judge` role so cheap-judge vs gold-judge is configurable), caches results aggressively to `.sidecar/cache/eval-judge/` keyed by `(judgeModel, promptHash, inputHash)` so re-running the suite against unchanged inputs is free, and supports **cheap-judge-first / gold-judge-on-borderline** for cost control: run Haiku on every case, escalate to Sonnet only when Haiku's score is near the pass threshold (within a configurable margin) so close calls get the better judge but clear passes/fails don't burn the budget. **Ground-truth curation workflow**: RAGAs recall requires ground-truth answers, which the current harness doesn't collect. A new `tests/llm-eval/ground-truth/` directory stores per-case ground truths as markdown + YAML frontmatter (`{ answer: "...", supportingFacts: [...], requiredContext: [...] }`); a `/curate-ground-truth` CLI walks uncurated cases, generates draft ground truths via the judge model, and surfaces them in a review UI where the human edits and commits. The workflow is explicit about provenance: ground truths carry a `curator: human | model | model-reviewed` tag in frontmatter so eval reports can flag metrics computed against unreviewed model-generated truths as tentative rather than authoritative. **Regression tracking surface**: eval report output extends the existing text summary with per-metric trend data (`faithfulness: 0.87 (↓ 0.03 from prev)`) and a CI-friendly `tests/llm-eval/history.jsonl` append-only log of each run's metrics keyed by git SHA, so `npm run eval:report` can render a 30-day chart showing whether retrieval precision is drifting as the Merkle index changes, faithfulness is regressing as prompts evolve, or coherence is degrading on cheaper-model runs. **Cost controls**: `sidecar.eval.judgeBudgetPerRun` (default `$1.00` USD equivalent — a full RAG+G-Eval suite with Haiku-judge costs ~$0.10–0.30 typically, so this is conservative); exceeding the budget skips the remaining fuzzy scorers with a visible warning rather than billing-surprising the user. Deterministic scorers always run — they're free. **Composes with every earlier retrieval entry**: Project Knowledge Index acceptance criteria become concrete RAGAs thresholds (context precision must not regress after symbol-chunking migration); Merkle fingerprint stability becomes a test (same root → identical retrieval output → identical RAG scores, which is a stronger regression signal than per-feature tests); Fork & Parallel Solve's built-in Judge mode reuses the same `llmJudge` primitive so its in-runtime scoring is consistent with the offline eval scoring; Doc-to-Test Loop's synthesized tests get faithfulness-checked against the source doc; Visual Verification's VLM verdicts get a coherence check via G-Eval. Configured via `sidecar.eval.ragMetrics` (array of enabled RAGAs scorers, default `['faithfulness', 'answerRelevancy', 'contextPrecision', 'contextRecall']`), `sidecar.eval.gEvalCriteria` (record of name → `{ description, scale: [1, N] }` for custom criteria beyond the built-ins), `sidecar.eval.judgeBudgetPerRun` (default `1.00`), `sidecar.eval.cheapJudgeModel` (default inherits from Model Routing `judge` role), `sidecar.eval.goldJudgeModel` (default empty — disables gold escalation if unset), `sidecar.eval.goldJudgeMargin` (default `0.1` — escalate to gold when cheap-judge score is within this margin of the threshold), and `sidecar.eval.cacheDir` (default `.sidecar/cache/eval-judge/`, covered by the gitignored-subdirs carve-out).

  ```mermaid
  flowchart TD
      CASE[Eval case with<br/>expect: mustContain +<br/>rag + gEval blocks] --> RUN[Run SideCar<br/>agent on input]
      RUN --> OUT[Final output +<br/>retrieved context +<br/>tool trajectory]
      OUT --> DET[Deterministic scorers<br/>mustContain, trajectory,<br/>file-state]
      OUT --> RAG{RAGAs scorers}
      OUT --> GEV{G-Eval scorers}
      RAG --> FA[Faithfulness:<br/>atomic claims vs context]
      RAG --> AR[Answer relevancy:<br/>generated questions ≈ input]
      RAG --> CP[Context precision:<br/>weighted MRR]
      RAG --> CR[Context recall vs<br/>ground truth]
      GEV --> COH[Coherence 1-10]
      GEV --> COR[Correctness 1-10]
      GEV --> CUSTOM[User criteria]
      FA & AR & CP & CR & COH & COR & CUSTOM --> JUDGE[LLM-as-judge<br/>cheap first → gold on borderline]
      JUDGE --> CACHE[(.sidecar/cache/eval-judge/<br/>judgeModel + promptHash)]
      DET & JUDGE --> AGG[Aggregate result]
      AGG --> HIST[Append to<br/>history.jsonl by SHA]
      HIST --> REPORT[Trend report<br/>per-metric deltas +<br/>judge reasoning traces]
  ```

- **Model comparison / Arena mode** — side-by-side prompt comparison with voting
- **Role-Based Model Routing & Hot-Swap** — replaces SideCar's current scatter of per-role model settings (`sidecar.model`, `sidecar.completionModel`, `sidecar.critic.model`, `sidecar.delegateTask.workerModel`, `sidecar.fallbackModel`, and the `plannerModel` / `judgeModel` / `vlm` knobs added in other roadmap entries) with a unified, declarative rule set that routes each dispatch to the right model for its actual job — so you can run Llama 3 for free local chat, promote to Claude Sonnet/Opus for the high-reasoning agent loop, and drop to Haiku for cheap summarization, all in one coherent config. The target experience: ultra-pro intelligence *exactly* where it earns its keep (the multi-turn agent loop, the War Room critic, the planner pass before a wide refactor) with the rest of the session staying free and local. **Rule shape**:
  ```jsonc
  "sidecar.modelRouting.rules": [
    // First match wins — list most specific first.
    { "when": "agent-loop.complexity=high", "model": "claude-opus-4-6" },
    { "when": "agent-loop",                 "model": "claude-sonnet-4-6" },
    { "when": "chat",                       "model": "ollama/llama3:70b" },
    { "when": "completion",                 "model": "ollama/qwen2.5-coder:7b" },
    { "when": "summarize",                  "model": "claude-haiku-4-5" },
    { "when": "critic",                     "model": "claude-haiku-4-5" },
    { "when": "worker",                     "model": "ollama/qwen3-coder:30b" },
    { "when": "planner",                    "model": "claude-haiku-4-5" },
    { "when": "judge",                      "model": "ollama/qwen2.5-coder:7b" },
    { "when": "visual",                     "model": "claude-sonnet-4-6" },
    { "when": "embed",                      "model": "local/all-MiniLM-L6-v2" }
  ]
  ```
  **Role taxonomy** (every dispatch point in SideCar is tagged with one): `chat` (one-off Q&A without tools), `agent-loop` (multi-turn tool-using work), `completion` (FIM autocomplete), `summarize` (ConversationSummarizer, prompt pruner, tool-result compressor), `critic` (War Room critic, completion-gate critic), `worker` (`delegate_task` local research worker), `planner` (edit-plan pass, fork approach planner), `judge` (fork judge, constraint-approval scoring), `visual` (screenshot VLM for browser-agent verification), `embed` (Project Knowledge Index vectors — this one is provider-specific and rarely overridden, but exposed for completeness). **Compound match expressions** — rules can include signal filters after the role: `agent-loop.complexity=high` (turn count × tool fan-out × file span exceeds threshold), `agent-loop.files~=src/physics/**` (glob match on files the turn is touching), `chat.prompt~=/pro\b|think hard/` (explicit user cue in the prompt), `agent-loop.retryCount>=3` (escalate on recurring failure). Signals are computed cheaply before each dispatch and passed to the router along with the role. **Hot-swap is literal**: within a single conversation, the active model changes at role boundaries — `SideCarClient.updateModel()` already exists, so the `ModelRouter` service just calls it with the rule-resolved choice before each dispatch. Message history is preserved across swaps (all backends speak compatible message shapes for the roles we swap into); tool definitions are unchanged; Anthropic prompt-cache breakpoints survive within a same-model run so the 90% cached-read discount doesn't get reset by a cross-role swap to a different provider. **Cost visibility**: a status-bar item shows the current active model with a tooltip breaking down *this session's spend by role* (`agent-loop: $0.42 (sonnet) · chat: $0.00 (local llama) · summarize: $0.03 (haiku)`) so users see exactly where their money is going. **Budget-aware downgrade**: each rule can declare a `dailyBudget` / `sessionBudget` / `hourlyBudget` and an optional `fallbackModel`; when the cap trips, the router silently downgrades (`claude-opus-4-6` → `claude-sonnet-4-6` → `claude-haiku-4-5` → `ollama/qwen3-coder:30b`) and surfaces a single non-blocking toast. **One-off override** via the `/model <name>` slash command for the rest of the session regardless of rules, plus `@opus`, `@sonnet`, `@haiku`, `@local` inline sentinels in the user message that bypass routing for just that turn. **Migration from existing per-role settings is automatic**: on first activation with `modelRouting.rules` set, SideCar translates any non-default `sidecar.completionModel` / `sidecar.critic.model` / etc. into synthesized rules and writes them into the new config, keeping the old fields as no-ops for backward compat. Users without `modelRouting.rules` keep the current per-field behavior — zero migration cost for the simple case. **Composes with every earlier entry**: Skills 2.0's `preferred-model` frontmatter becomes a per-skill rule injected for the skill's lifetime; Facets' `preferredModel` becomes a per-facet rule; Fork & Parallel Solve can declare per-fork model rules (`fourier` on Sonnet, `wavelet` on Haiku for cost comparison); the GPU-Aware Load Balancing feature's auto-downgrade on VRAM pressure becomes one of the router's triggers rather than a parallel code path; Audit Mode can require confirmation when the router would escalate to a paid model without user awareness. **Ad-hoc complexity heuristic** for `agent-loop.complexity=high` (tunable, good defaults): turn count >= 5 OR distinct-files-touched >= 3 OR consecutive-tool-use-blocks >= 8 OR user prompt contains explicit reasoning cues (`prove`, `verify`, `reason through`, `think step by step`). The heuristic is boring on purpose — anything smarter invites surprises about why a cheap session suddenly escalated. Configured via `sidecar.modelRouting.enabled` (default `false` — opt-in until users have calibrated rules), `sidecar.modelRouting.rules` (ordered rule list, first match wins), `sidecar.modelRouting.defaultModel` (fallback when no rule matches, defaults to `sidecar.model`), `sidecar.modelRouting.visibleSwaps` (default `true` — show a brief toast on model swap so the user knows what happened; `false` for silent operation once calibrated), and `sidecar.modelRouting.dryRun` (default `false`; when `true`, the router logs what it *would* have selected but sticks with `sidecar.model`, for safely calibrating rules before enabling them).

  ```mermaid
  flowchart TD
      D[Dispatch point] --> ROLE[Tag role:<br/>chat / agent-loop /<br/>completion / summarize / ...]
      ROLE --> SIG[Compute signals:<br/>complexity, files, retries,<br/>prompt cues]
      SIG --> RULES{Match rules<br/>top-down}
      RULES -->|first match| BUDG{Budget ok?}
      BUDG -->|yes| SWAP[updateModel to rule's choice]
      BUDG -->|exhausted| FALL[Fallback model<br/>or chain to next rule]
      FALL --> BUDG
      SWAP --> DISP[Dispatch to backend]
      DISP --> TRACK[Track spend<br/>per role]
      TRACK --> STATUS[Status bar:<br/>active model + tooltip<br/>spend breakdown]
      RULES -->|no match| DEF[defaultModel]
      DEF --> DISP
  ```
- **GPU-Aware Load Balancing** — SideCar monitors VRAM pressure in real time (via `nvidia-smi`, `rocm-smi`, or the Metal Performance HUD on Apple Silicon) and automatically backs off when a competing workload — such as a PyTorch/JAX training run — is detected consuming significant VRAM. Three escalating responses: (1) **silent downgrade** — swap to a smaller quantised variant of the current model (e.g. `q8_0` → `q4_K_M`) if one is available locally; (2) **user prompt** — if no smaller local model is available, surface a non-blocking toast offering to switch to a cloud provider (Anthropic / OpenAI) for the duration of the heavy workload; (3) **pause & queue** — if the user dismisses the toast, queue pending agent turns and retry once VRAM headroom recovers. Restores the original model automatically when pressure drops below the threshold. Configurable via `sidecar.gpuLoadBalancing.enabled`, `sidecar.gpuLoadBalancing.vramThresholdPercent` (default: `80`), `sidecar.gpuLoadBalancing.fallbackModel`, and `sidecar.gpuLoadBalancing.cloudFallbackProvider`.
- **Real-time code profiling** — MCP server wrapping language profilers

### Security & Permissions

- **Granular permission controls** — per-category tool permissions, upfront scope requests
- **Enhanced sandboxing** — constrained environments for dangerous tools
- **Customizable code analysis rules** — `sidecar.analysisRules` with regex patterns and severity
- **Audit Mode — Virtual-FS Write Buffer with Treeview Approval** — introduces a new `agentMode` tier that sits between `autonomous`/yolo (runs everything without prompting) and `cautious` (prompts per tool call). In audit mode the agent runs uninterrupted — no modal dialogs, no per-call approvals — but every `write_file`, `edit_file`, and `delete_file` is intercepted at the executor layer and diverted to an in-memory **Audit Buffer** instead of touching disk. The agent sees a normal success response and keeps working against its own virtual view: subsequent reads to buffered paths return the buffered content so the agent's edits stack correctly without ever desynchronizing from the real disk state. Shell commands run normally — audit mode's scope is the agent's explicit file-authoring surface, not every possible side effect, because `write_file` is the primary path hallucinations become persistent damage and `run_shell_command` is already gated by the existing `toolPermissions` system if the user wants it there. Buffered changes surface in a new **Audit Changes** tree view in the SideCar sidebar, streaming in as the agent produces them: each entry is a row with path + status (new / modified / deleted), a VS Code native checkbox (`TreeItemCheckboxState`), and an expandable inline diff against the real on-disk state. Batch actions at the top of the view — *Accept Selected*, *Accept All*, *Reject All*, *Open in Diff Editor* — let the user process the buffer at whatever granularity fits the task. On accept, the selected entries flush to disk in a single atomic transaction (rollback on any write failure, so a half-accepted state is impossible); on reject, the buffer entry is cleared and the agent receives a synthetic tool-result (`write_file to <path> was rejected by the user during audit review`) so it doesn't silently keep building on rejected state. If the user edits a buffered file manually on disk *between* the agent's write and the user's approval, the treeview entry gets a ⚠ *conflict* badge and opens a three-way merge editor (base = pre-agent disk / ours = user's edit / theirs = agent's buffered write) rather than silently clobbering either side — the user resolves and then approves. `git_commit` operations are buffered by default too, since committing is semi-destructive and harder to undo than a file write; toggle with `sidecar.audit.bufferGitCommits`. The buffer persists across VS Code reloads via `.sidecar/audit-buffers/<session-id>.json` (covered by the existing gitignored-subdirs carve-out) so a crash or restart never loses pending work. Composes with Shadow Workspaces for the "belt and suspenders" case: audit mode *inside* a shadow gives per-file approval for the agent's work-in-shadow, then the final shadow merge is itself another review step — useful for high-stakes refactors. Configured by setting `sidecar.agentMode` to the new `audit` value (joining `cautious`, `autonomous`, `plan`), plus `sidecar.audit.autoApproveReads` (default `true` — reads don't mutate state so they bypass the buffer), `sidecar.audit.bufferGitCommits` (default `true`), `sidecar.audit.defaultSelection` (`none` | `all`, default `none` so the user always actively opts in rather than remembering to uncheck), and `sidecar.audit.autoOpenDiffOnWrite` (default `false`; set `true` to pop the diff editor open the instant a new write lands, for tight interactive review). Status bar shows `Audit: M pending (N selected)` so buffer state stays visible even when the tree view is collapsed.

  ```mermaid
  flowchart LR
      A[Agent turn] --> WF[write_file / edit_file /<br/>delete_file / git_commit]
      WF --> I[Executor interceptor<br/>agentMode === 'audit']
      I --> B[(Audit Buffer<br/>in-memory + JSON persist)]
      B --> TV[Audit Changes tree view<br/>streaming entries]
      TV --> U{User action}
      U -->|Accept selected| D{Conflict?<br/>user edited on disk}
      D -->|no| FD[Atomic flush to disk]
      D -->|yes| M3[3-way merge editor]
      M3 --> FD
      U -->|Reject| SR[Drop entry +<br/>synthetic rejection<br/>tool-result to agent]
      U -->|Ignore| B
      I -.read-through.-> B
      A -.subsequent reads<br/>see buffered content.-> I
  ```

### Providers & Integration

- **Bitbucket / Atlassian** — Bitbucket REST API, `GitProvider` interface, auto-detect from remote URL
- ~~**OpenRouter** — dedicated integration with model browsing, cost display, rate limit awareness~~ → **shipped 2026-04-15 in v0.53.0**. Dedicated [`OpenRouterBackend`](src/ollama/openrouterBackend.ts) subclass with referrer + title headers, rich catalog fetch via `listOpenRouterModels()`, first-class entry in `BUILT_IN_BACKEND_PROFILES`, and a runtime `MODEL_COSTS` overlay populated from OpenRouter's per-model pricing (no more hand-maintaining prices for hundreds of proxied models). Per-generation real cost tracking via `/generation/{id}` still deferred.
- **Browser automation** — Playwright MCP for testing web apps
- **Extension / plugin API** — `@sidecar/sdk` for custom commands, renderers, tools, hooks
- **MCP marketplace** — discoverable directory with one-click install
- **Agentic Task Delegation via MCP** — elevates MCP from a static tool registry into a dynamic sub-agent orchestration layer. Instead of treating every MCP server as a dumb function call, SideCar can spawn specialised servers on-demand (e.g. a `math-engine` for symbolic computation, a `web-searcher` for live retrieval, a `code-executor` sandbox) and route sub-tasks to them as first-class agents with their own reasoning loop. The lead agent decomposes the user's request, dispatches sub-tasks to the most capable server via a new `delegate_to_mcp` tool call, collects structured results, and synthesises a final response — mirroring the hierarchical multi-agent pattern but using the MCP protocol as the inter-agent transport. Server lifecycle (spawn, health-check, teardown) is managed automatically, and each delegation is recorded in the audit log with the server name, input, output, and latency. Configurable via `sidecar.mcpDelegation.enabled` and `sidecar.mcpDelegation.allowedServers`.

- **First-Class Database Integration (SQL + NoSQL)** — closes a gap that's currently zero beyond defensive secret-detection. Today SideCar can't ask a database anything: the agent has to generate `sqlite3 db.db "SELECT ..."` via `run_shell_command` and parse string output, which is fragile, unsafe (SQL injection if the agent templates user input into the shell), and completely invisible to every downstream feature that could benefit (Audit Mode, Visualization Dashboards, Regression Guards, Research Assistant). For a user running simulations whose results land in SQLite or Postgres, "query my results DB for all runs where SNR < -30 dB" is exactly the integration that turns SideCar from a code assistant into a research assistant. Built in **three tiers** so the common case ships fast and advanced tiers layer on cleanly: **Tier 1 — Read-only query & introspection (safe core)**: a new `DatabaseProvider` abstraction mirroring the `ApiBackend` pattern (anticorruption layer across SQL dialects), with first-class drivers for **SQLite** (via `better-sqlite3`, single `.node` binary, zero ambient deps — same rationale that drove LanceDB selection for Project Knowledge), **PostgreSQL** (via `pg`, connection-pooled), **MySQL/MariaDB** (via `mysql2`), and **DuckDB** (via `@duckdb/node-api` — scientific-workflow-friendly, handles Parquet / Arrow natively, useful for experiment-results query). New agent tools: `db_list_connections()` returns every configured DB with its dialect + status; `db_list_tables(connection, { schema? })` returns `{ tables: [{ name, schema, rowCount, comment }] }` with one cheap metadata query per dialect; `db_describe_table(connection, table, { schema? })` returns `{ columns: [{ name, type, nullable, default, isPK, isFK, references? }], indexes, constraints, approxRowCount }`; `db_query(connection, sql, { params?, limit?, timeoutMs? })` runs a **parameterized** read-only query — the driver enforces a syntactic check (reject statements containing `INSERT`/`UPDATE`/`DELETE`/`DROP`/`ALTER`/`CREATE`/`TRUNCATE`/`GRANT`/`REVOKE` at the top-level parse tree, not regex, so a `SELECT` with `DELETE` in a column alias or string literal still passes) and a hard `timeoutMs` cap (default `30000`) so a runaway query can't lock the session, returning `{ columns: string[], rows: object[], rowCount: number, truncated: boolean }`. Structured rows, not string tables — the agent reasons over actual data, the webview renders a real table, and downstream consumers like the Visualization Dashboard get proper typed columns. **Tier 2 — Writes, migrations, and ORM coordination** (opt-in, Audit-gated): `db_execute(connection, sql, { params? })` runs mutating statements but **always** routes through Audit Mode when enabled — a buffered DB change appears in the Audit Changes tree alongside file writes with a preview ("this would insert 42 rows into `users`", "this would alter `products` dropping column `legacy_sku`"), and executes only on user approval. ORM awareness auto-detects from workspace files: `prisma/schema.prisma` (Prisma), `alembic.ini` (SQLAlchemy / Alembic), `typeorm` config (TypeORM), `sequelize` config (Sequelize), `knexfile.{js,ts}` (Knex), `migrations/` with `flyway.conf` (Flyway), `db/migrate/` (Rails). When detected, migration tools become first-class: `db_migrate_status(connection)` returns `{ applied: [], pending: [] }`; `db_migrate_up(connection, { to? })` runs pending migrations via the detected ORM's native command wrapped in the existing terminal shell execution path (so the user sees migration output in the *SideCar Agent* terminal); `db_migrate_new(connection, name, { up, down })` scaffolds a migration file in the ORM's expected location. Migrations always run inside a Shadow Workspace's shadow DB first — a DuckDB-backed ephemeral replica cloned from the user's schema — so a destructive migration never lands on main until the user accepts. **Tier 3 — NoSQL via dedicated MCP servers**: MongoDB, Redis, DynamoDB, Cassandra, Elasticsearch each get an official `mcp-sidecar-<engine>` server shipped separately, exposing `<engine>_find` / `<engine>_get` / `<engine>_insert` / etc. through the existing MCP tool surface. This keeps the core extension focused on the SQL surface where the anti-corruption abstraction is tightest, while NoSQL (where query surfaces diverge sharply per engine) gets engine-specific tooling without bloating the main bundle. The MCP marketplace entry (already in this section) is the distribution channel. **Connection management** reuses the existing SecretStorage + backend-profile pattern: `sidecar.databases.profiles` is an array of `{ id, name, dialect, host, port, database, user, secretKey }` entries matching the shape of `BUILT_IN_BACKEND_PROFILES` for LLM backends; passwords live in VS Code SecretStorage keyed by `secretKey`, never in `settings.json`; a *Databases* backend-picker surface lets users switch active DB the same way they switch LLM backends today. A `.sidecar/databases/profiles.json` manifest at the project level can commit non-secret connection metadata (host, port, db name, user) so teammates share the shape without leaking creds — each developer fills in passwords locally via SecretStorage. **Deep integration with every earlier entry**: *Audit Mode* — Tier 2 writes always route through the Audit Buffer treeview when enabled; *Regression Guards* — DB-integrity guards ship built-in (`schema-drift` checks that `db_describe_table` output matches a committed schema snapshot, `migration-idempotent` re-runs `db_migrate_up` to verify no changes on re-apply, `rowcount-sanity` catches accidental full-table deletes); *Visualization Dashboards* — query results auto-render as sortable tables; ERDs render via the `erd` VizSpec type from the Dashboards entry; query result sets with numeric columns auto-suggest a Vega-Lite chart; *Research Assistant* — experiment results DBs are a first-class `.sidecar/research/` artifact, `test_hypothesis` can run aggregate queries across experiment runs ("of 500 runs, how many passed?"), and `generate_figure` can source data directly from a DB query; *Doc-to-Test Loop* — a schema spec document synthesizes schema-conformance tests ("the `users` table must have columns X, Y, Z with these types"), verified against the live DB via `db_describe_table`; *Project Knowledge Index* — SQL files and ORM model files get indexed alongside source code, so `project_knowledge_search "user auth schema"` retrieves the relevant Prisma model + SQL migration + the actual `users` table schema in one query; *Shadow Workspaces* — migrations run against a shadow DB (DuckDB-backed clone of the real schema), not the user's real DB, until the Shadow Review passes; *Model Routing* — DB design reasoning (schema review, migration authoring) can route to Sonnet/Opus via a `db-design` role while simple query writing stays on a cheaper model; *Skills 2.0* — `db_readonly.agent.md` skill with `allowed-tools: [db_list_tables, db_describe_table, db_query]` gives an explicit read-only DB assistant persona you can stack. **Safety posture**: `db_execute` is *opt-in per connection* — every profile declares `readOnly: true` by default, and `readOnly: false` triggers a one-time confirmation ("this connection will be allowed to execute mutating statements") stored in SecretStorage alongside the password; destructive statements (`DROP`, `TRUNCATE`, `DELETE` without `WHERE`, `ALTER TABLE ... DROP COLUMN`) surface a modal with the exact statement even in autonomous mode, always; every `db_execute` call logs to `.sidecar/databases/audit.log` (append-only, gitignored) with connection id, statement, rowcount, duration, user approval status. **UI**: a *Databases* sidebar panel listing profiles, connection status, a per-DB schema explorer (expandable tables → columns → indexes), and a saved-queries drawer backed by `.sidecar/databases/queries/` — so the user can name + reuse a complex analytical query across sessions and share them with the team via git. Configured via `sidecar.databases.profiles` (array of connection configs, each with `readOnly: boolean` and `secretKey` fields), `sidecar.databases.queryTimeoutMs` (default `30000`), `sidecar.databases.queryRowLimit` (default `10000` — truncate the agent-visible result; full result persists in the query panel if needed), `sidecar.databases.autoDetectORM` (default `true`), `sidecar.databases.requireAuditForWrites` (default `true` — flip to `false` for trusted local-dev databases), and `sidecar.databases.destructiveConfirmation` (default `always`; `once-per-session` for batch work, `never` is deliberately disallowed to prevent the footgun).

  ```mermaid
  flowchart TD
      A[Agent] --> T{DB tool}
      T --> LT[db_list_tables]
      T --> DT[db_describe_table]
      T --> Q[db_query<br/>read-only, parameterized]
      T --> EX[db_execute<br/>mutating, opt-in]
      T --> M[db_migrate_up / status / new]

      LT & DT & Q --> DP[DatabaseProvider<br/>abstraction]
      DP --> SQL{Dialect}
      SQL -->|sqlite| SL[better-sqlite3]
      SQL -->|postgres| PG[pg]
      SQL -->|mysql| MY[mysql2]
      SQL -->|duckdb| DB[@duckdb/node-api]
      SQL -->|mongo, redis, etc| MCP[MCP NoSQL servers]

      EX --> AUDIT{Audit Mode<br/>enabled?}
      AUDIT -->|yes| BUF[Audit Buffer tile<br/>preview + approve]
      AUDIT -->|no + destructive| MOD[Modal confirmation<br/>always]
      AUDIT -->|no + safe| DIRECT[Execute]
      BUF -->|user accepts| DIRECT
      MOD -->|user accepts| DIRECT

      M --> SHADOW[Shadow DB<br/>DuckDB schema clone]
      SHADOW -->|passes + user accepts| REAL[Real DB migration]

      Q --> ROWS[Structured rows<br/>columns, rows, rowCount]
      ROWS --> VIZ[Visualization Dashboard<br/>table / Vega-Lite chart / ERD]
      ROWS --> RESEARCH[Research Assistant<br/>test_hypothesis, figures]

      SEC[(SecretStorage<br/>passwords per profile)] -.-> DP
      LOG[.sidecar/databases/<br/>audit.log] -.-> EX
  ```

- **Voice input** — Web Speech API or local STT model

### Enterprise & Collaboration

- **Centralized policy management** — `.sidecar-policy.json` for org-level enforcement of approval modes, blocked tools, PII redaction, provider restrictions
- **Multi-User Agent Shadows** — a shared agent knowledge base that lets every contributor's SideCar instance start with the same learned project context. A team member runs `SideCar: Export Project Shadow` to serialise the agent's accumulated knowledge — coding standards, design tokens (colours, typography), mathematical definitions, architectural decisions, naming conventions — into a versioned `.sidecar/shadow.json` file that is committed to the repo. When a new contributor opens the project, SideCar detects the shadow file and automatically imports it into their local memory store, so their instance already knows the project's conventions without a single prompt. Entries are namespaced by category (`standards`, `design`, `math`, `architecture`) and can be individually pinned or overridden locally. Shadow exports are human-readable JSON so they can be reviewed and edited in PRs like any other config file. Controlled via `sidecar.shadow.autoImport` (default: `true`) and `sidecar.shadow.autoExport` (default: `false` — export is always an explicit user action to avoid leaking sensitive context).
- **Team knowledge base** — built-in connectors for Confluence, Notion, internal docs
- **Real-time collaboration Phase 1** — VS Code Live Share integration (shared chat, presence, host/guest roles)
- **Real-time collaboration Phase 2** — shared agent control (multi-user approval, message attribution)
- **Real-time collaboration Phase 3** — concurrent editing with CRDT/OT conflict resolution
- **Real-time collaboration Phase 4** — standalone `@sidecar/collab-server` WebSocket package

### Technical Debt

- Config sub-object grouping (30+ fields → sub-objects)
- Real tokenizer integration (`js-tiktoken` for accurate counting)

---

## Deferred — Folded into release plan

During the v0.58.1 reorganization, the previous Deferred backlog was audited and folded. Every item that had a natural release home moved into the Release Plan above; closed items were marked done. The full resolution is kept here for traceability so future readers can see where each deferral ended up.

### Closed — already shipped

- ~~**Policy-hook interface for `runAgentLoop`**~~ → shipped v0.54.0 as `src/agent/loop/policyHook.ts` + `HookBus`.
- ~~**Backend anticorruption layer (`normalizeStream`)**~~ → shipped v0.53.0 as `streamOpenAiSse` helper.
- ~~**`chatHandlers.ts` split**~~ → shipped v0.57.0. File is now 770 lines (verified); decomposed into `messageUtils.ts` / `systemPrompt.ts` / `fileHandlers.ts` / orchestrator shell per the v0.57.0 CHANGELOG.
- ~~**LLM-as-judge scoring**~~ → reopened and folded into v0.62's [RAG-Native Eval Metrics + G-Eval](#rag-native-eval-metrics-ragas--qualitative-llm-as-judge-g-eval) entry.

### Folded into a specific release

| Previous Deferred item | Target release | Reason |
|---|---|---|
| Reranker stage (cycle-2 MEDIUM) | v0.62 | Pairs naturally with Merkle + RAG-Eval; the eval metrics will measure whether reranking earns its compute. |
| Per-source budget caps (v0.52.0 loose end) | v0.62 | Bundles with the reranker work — same retrieval-infra cleanup. |
| Eval cases for retriever fusion / cost warning / summarizer cap (v0.51.0) | v0.62 | Fixture plumbing lands with RAG-Eval's harness expansion. |
| Eval cases for auto-fix + critic paths (v0.50.0) | v0.70 | Live Diagnostic Subscription release is the natural moment to expand diagnostic-path eval. |
| `/resume` webview button (v0.52.0) | v0.65 | Same webview surface as Steer Queue's new interrupt UI. |
| Empirical `max_tokens` TPM fix verification (v0.48.0 manual task) | v0.59 | Attach as manual verification task to v0.59. |
| Anthropic Batch API for non-interactive workloads (cycle-2 MEDIUM) | v0.67 | Fork & Parallel Solve is the batching substrate (parallel-fork dispatch). |
| Provider `usage` → `MODEL_COSTS` auto-update (v0.51.0) | v0.64 | Role-Based Model Routing release — spend tracking becomes prominent. |

### Still deferred — no scheduled release

- **`maxCharsPerTurn` as a `SideCarConfig` setting** — the ConversationSummarizer default (220) is a working value. Exposing it through `package.json` contribution points is one more setting to document and support; skip until someone asks. *Source: v0.51.0 scope decision.*

---

## Release History

Rolling log of what shipped in each release, newest first. Each subsection preserves the context that was written at release time — file:line references, reasoning, test-count stats, stats progression. Serves as both a changelog appendix and an architectural lineage trace.

### v0.62.0 (2026-04-17)

Fourth Release-Plan entry. Theme: **retrieval quality** — the v0.61 PKI MVP becomes a measurable retrieval layer (deterministic + LLM-judged eval, CI ratchet) with a structural addressing layer (Merkle tree) that makes query-time pruning possible on large workspaces.

- ✅ **PKI Phase 2** (c.1–c.2, closing v0.61 deferrals).
  - **c.1** — `SemanticRetriever.retrieve()` now prefers symbol-level hits from [`SymbolEmbeddingIndex`](src/config/symbolEmbeddingIndex.ts) over the legacy file-level path when PKI is wired + ready + non-empty. New `workspace-sym:${path}::${name}` ID prefix distinguishes symbol-level hits from legacy `workspace:${path}` in the RRF fusion layer. Symbol body renders as the line-range slice (not the first 3000 chars of the file), a tighter evidence unit for RAG. Empty symbol-search result returns `[]` (not a file-level fallback) so the fusion layer isn't polluted when PKI searched but nothing scored. +6 tests.
  - **c.2** — Vector storage extracted into a pluggable [`VectorStore<M>`](src/config/vectorStore.ts) interface + `FlatVectorStore<M>` implementation. Bit-for-bit compatible with the v0.61 on-disk format via `extraMeta` (caller's `modelId` preserved). New `sidecar.projectKnowledge.backend: 'flat' | 'lance'` setting; `lance` reserved for a future release (falls back to flat with a warning). +23 tests.
- ✅ **RAG-eval arc** (e.1–e.3, new release feature).
  - **e.1** — Synthetic miniature service codebase with known-correct "where is X?" answers in [`src/test/retrieval-eval/fixture.ts`](src/test/retrieval-eval/fixture.ts). Harness in [`harness.ts`](src/test/retrieval-eval/harness.ts) wires a real `SymbolEmbeddingIndex` + `SymbolGraph` against the fixture using a deterministic fake embedding pipeline. `runGoldenQuery` threads through the real `enrichWithGraphWalk`. 11 golden cases covering concept search, graph walk, kind filter, path prefix. +16 tests.
  - **e.2** — Standard set-based IR metrics: `contextPrecisionAtK` / `contextRecallAtK` / `f1ScoreAtK` / `reciprocalRank` in [`metrics.ts`](src/test/retrieval-eval/metrics.ts) with per-query + macro-averaged aggregates. CI ratchet in [`baseline.test.ts`](src/test/retrieval-eval/baseline.test.ts) pinned at `0.45 / 0.95 / 0.55 / 0.90` against a current baseline of `0.49 / 1.00 / 0.59 / 0.94`. Per-case scorecards logged in verbose mode. +27 tests.
  - **e.3** — LLM-judged `Faithfulness` (per-hit RELEVANT/BORDERLINE/IRRELEVANT) + `Answer Relevancy` (per-query ANSWERED/PARTIAL/MISSED) under `npm run eval:llm`. Architecture split: pure prompt builders + verdict parsers in [`src/test/retrieval-eval/judgeParsing.ts`](src/test/retrieval-eval/judgeParsing.ts) (main suite, unit-tested); backend-aware judges in [`tests/llm-eval/retrievalJudge.ts`](tests/llm-eval/retrievalJudge.ts) (eval-only). Prompt caps bounded (2000 chars body, 10-hit cap). Skips cleanly without API key. +14 tests.
- ✅ **Merkle fingerprint arc** (d.1–d.3, new release feature).
  - **d.1** — [`MerkleTree`](src/config/merkleTree.ts) 3-level hash tree (leaves → file-nodes → root). SHA-256 content hash over canonical `filePath|qualifiedName|kind|startLine-endLine|body`. Dirty-tracking on mutation; `rebuild()` only refreshes dirty file-nodes. Order-independent aggregation (sorted child hashes). `descend(queryVec, k)` scores file-level aggregated vectors and returns top-k files' leaf IDs. Pure data structure. +27 tests.
  - **d.2** — Wired into `SymbolEmbeddingIndex`. New `setMerkleTree(tree)` replays persisted entries via new `VectorStore.getVector(id)`. `SymbolMetadata.merkleHash` field persisted alongside body MD5. Re-embed short-circuit checks BOTH hashes; vector reused from store when body unchanged but range shifted. `flushQueue` fires `tree.rebuild()` per batch. New `getMerkleRoot()` accessor. +6 tests.
  - **d.3** — `SymbolEmbeddingIndex.search` walks the tree's aggregated-vector descent to pick candidate files *before* scoring leaves. Candidate count `max(10, topK × 3)`. Empty-tree fall-through. Extension activation wires a tree when `sidecar.merkleIndex.enabled` (default `true`) + PKI are both on. New [`merkleParity.test.ts`](src/test/retrieval-eval/merkleParity.test.ts) re-runs every golden case with descent active, asserts aggregate stays at-or-above the non-Merkle ratchet floors. +14 tests.

**Explicitly deferred to v0.63** (scoped out of v0.62 MVP): PKI default-on (opt-in stays `false`) · LanceDB HNSW backend · Project Knowledge sidebar panel · cross-encoder reranker · per-source budget caps + fusion parallelization + `onToolOutput` backpressure · hook + approval pattern unification · blake3 hash algorithm · backend-coverage harmonization (fireworks/groq/openai).

### v0.61.0 (2026-04-16)

Third Release-Plan entry. Theme: **retrieval core** — queries that are actually about code concepts (not text matches) get a symbol-granularity semantic layer with graph-walk enrichment, while the v0.60 Audit Mode MVP finishes its Phase 2 with per-file acceptance, conflict detection, reload persistence, and git-commit buffering. Two distinct feature arcs land in the same release because the Audit Phase 2 deferrals were one-sprint scope each and blocking the next retrieval release on them didn't make sense.

- ✅ **Project Knowledge Index** (b.1–b.4, full MVP feature arc).
  - **b.1** — New [`SymbolEmbeddingIndex`](src/config/symbolEmbeddingIndex.ts) primitive. Symbol-granularity sibling of the file-level `EmbeddingIndex` using the same `@xenova/transformers` MiniLM model + 384-dim space so queries can cross both backends during migration. `indexSymbol` embeds each symbol body prefixed with `qualifiedName (kind)` for structural context; content-hash short-circuit skips re-embed when body unchanged. `search` supports `kindFilter` + `pathPrefix`. Persists to `.sidecar/cache/symbol-embeddings.{bin,meta.json}`. +19 tests.
  - **b.2** — Wired to [`SymbolIndexer`](src/config/symbolIndexer.ts) via `setSymbolEmbeddings(index, maxSymbolsPerFile?)`. Debounced `queueSymbol` + `flushQueue` batch drain (500 ms window, 20 per batch) so a workspace scan doesn't serialize on a single embed. Rename/delete flows drop files from the embedder. Settings `sidecar.projectKnowledge.{enabled, maxSymbolsPerFile}` (default `false`, `500`). +8 tests.
  - **b.3** — New [`project_knowledge_search`](src/agent/tools/projectKnowledge.ts) agent tool. Params `query` / `maxHits` / `kindFilter` / `pathPrefix`. Returns `filePath:startLine-endLine\tkind\tqualifiedName\t(vector: 0.NNN)` per hit — a shape `read_file` can consume directly. Graceful degradation (not-enabled / warming-up / no-matches hints). Wired through `ToolRuntime.symbolEmbeddings` + `setSymbolEmbeddings()` exporter. +9 tests.
  - **b.4** — Graph-walk retrieval enrichment via new `enrichWithGraphWalk(directHits, graph, { maxDepth, maxGraphHits })` helper. BFS per starting hit walking `SymbolGraph.getCallers` edges, caller call-sites resolved to their containing symbol (enclosing function), budget cap on added symbols across all starts, dedup across frontier starts, scores decay `directScore * 0.5^hops`. New tool params `graphWalkDepth` (default 1, clamped [0, 3]) and `maxGraphHits` (default 10, clamped [0, 50]). Response header distinguishes vector-only vs. enriched. Relationship column shows either `vector: 0.823` or `graph: called-by (1 hop from requireAuth)`. +10 tests.
- ✅ **Audit Mode Phase 2** (a.1–a.4, all four v0.60 deferrals shipped).
  - **a.1** — Per-file accept/reject in the review loop. Picker now loops after per-file actions so the user walks the buffer one file at a time; bulk actions still terminate. New `acceptFileAuditBuffer(deps, path)` + `rejectFileAuditBuffer(deps, path)` exports; shared `flushBufferPaths(deps, paths?)` helper. +7 tests.
  - **a.2** — Conflict detection on flush. Pre-flush pass reads current disk state for every entry about to flush and compares against `entry.originalContent`. Divergence surfaces a modal `showConflictDialog(message)` with conflicting paths enumerated; `Apply Anyway` proceeds, cancel preserves buffer. Subset-aware (per-file accept only prompts on conflicts in that file). +6 tests.
  - **a.3** — Buffer persistence across reloads. New `AuditBufferPersistence` interface + FS-backed shim in [`auditBufferPersistence.ts`](src/agent/audit/auditBufferPersistence.ts) serializing to `.sidecar/audit-buffer/state.json`. Schema versioning (v1 → v2 envelope with transparent migration) + 64 MB hard cap + corrupted-file rejection + per-entry shape validation on load. Extension activation prompts `Review` / `Discard` on prior-session recovery. Best-effort save — disk-full errors log but don't fail mutations. +12 tests.
  - **a.4** — Git-commit buffering end-to-end. `sidecar.audit.bufferGitCommits` flag (inert in v0.60) now gates commit execution. `git_commit` tool in audit mode routes through new `AuditBuffer.queueCommit(message, trailers?)` instead of running `GitCLI.commit`. Queued commits execute in FIFO order as the last step of a flush that empties the buffer. Subset flushes leave commits queued; full reject drops them. New `BufferedCommit` + `ExecuteCommitFn` types, `committed` field on `flush()` return, persistence envelope includes commits. Commit failure preserves file writes on disk + keeps commits queued for retry. +14 tests.

**Explicitly deferred to v0.62** (scoped out of v0.61 MVP): LanceDB HNSW backend (`sidecar.projectKnowledge.backend: 'lance' | 'flat'`) · `SemanticRetriever` migration to prefer the symbol index · Merkle-addressed fingerprint layer · Project Knowledge sidebar panel (UI work → v0.63) · hook + approval pattern unification (carried from v0.60; needs RAG-eval data + UI design to justify the refactor).

### v0.60.0 (2026-04-16)

Second Release-Plan entry. Theme: **approval gates** — the agent's file-authoring surface and side-effect surface both get hard gates the user (or a declarative script) controls, so a runaway agent can't silently damage a repo and a passing lint suite can't mask a broken invariant.

- ✅ **Audit Mode** (step d, full feature) — new `sidecar.agentMode: 'audit'` tier. Every `write_file` / `edit_file` / `delete_file` call is intercepted in [`fs.ts`](src/agent/tools/fs.ts) and routed to an in-memory [`AuditBuffer`](src/agent/audit/auditBuffer.ts) instead of disk. `read_file` sees buffered content for paths already written this session (read-through). Three user-facing commands in [`reviewCommands.ts`](src/agent/audit/reviewCommands.ts) close the loop: review (QuickPick with bulk-action + per-file rows, clicking a file opens VS Code's native diff editor with captured `originalContent` vs. buffered new content), acceptAll (atomic flush via `workspace.fs.writeFile` + `workspace.fs.delete({ useTrash: true })` with automatic parent-directory creation; any per-write failure triggers rollback of already-applied entries and surfaces `AuditFlushError` with applied/failed lists, preserving the buffer for retry), rejectAll (modal warning-dialog confirmation, clears without touching disk). Handlers sit behind `AuditReviewUi` abstraction for testability. New settings: `sidecar.audit.autoApproveReads` (default `true`), `sidecar.audit.bufferGitCommits` (default `true`; feature flag for v0.61). +32 tests total (19 for `AuditBuffer`, 13 for review commands). **Deferred to v0.61**: per-file accept/reject · persistence across extension reloads · conflict detection on disk-edit during review · git-commit side-effect buffering.
- ✅ **Regression Guard Hooks** (step c) — declarative guards in `sidecar.regressionGuards` as a `PolicyHook` registered on the existing `HookBus` after the four built-in hooks. Each entry: `name`, `command`, `trigger` (`post-write` · `post-turn` · `pre-completion`), optional `blocking`/`timeoutMs`/`scope`/`maxAttempts`/`workingDir`. Blocking guards with exit != 0 inject synthetic user messages containing stdout + exit so the agent can revise; non-blocking guards surface via `callbacks.onText`. Scope globs filter by touched files; per-guard attempt budget emits a one-time escalation message on persistent failure. Global `sidecar.regressionGuards.mode` (`strict` / `warn` / `off`) toggles all guards without editing individual entries. First-time workspace-trust gate via `checkWorkspaceConfigTrust('regressionGuards', …)` — same contract as `hooks`, `mcpServers`, `customTools`, `scheduledTasks`. +24 tests.
- ✅ **Secret redaction in hook + custom-tool env vars** (step b, audit cycle-3 MEDIUM #7) — new `redactSecrets()` in [`securityScanner.ts`](src/agent/securityScanner.ts) replaces every match of the existing `SECRET_PATTERNS` with `[REDACTED:<name>]`. Called by [`executor.ts`](src/agent/executor.ts) before setting `SIDECAR_INPUT` / `SIDECAR_OUTPUT` on hook child-process environments, and by [`tools.ts`](src/agent/tools.ts) before forwarding user input to a `custom_*` tool's subprocess. Closes the case where an API key in tool input/output would be inherited verbatim by every hook-spawned subprocess. +10 tests.
- ✅ **`src/review/` subsystem coverage lift + CI ratchet bump** (step a) — review-feature trio (`commitMessage.ts` · `prSummary.ts` · `reviewer.ts`) from ~27% to 100 / 85.7 / 100 / 100 each. Aggregate 60.99 → 61.79 stmts · 53.37 → 54.06 branches · 61.11 → 61.80 funcs · 61.76 → 62.63 lines. CI ratchet bumped to 61/53/61/62. +25 new tests.

**Explicitly deferred to v0.61** (scoped out of v0.60 MVP): per-file Audit accept/reject UI · Audit buffer persistence across extension reloads · Audit conflict detection against mid-review disk edits · `sidecar.audit.bufferGitCommits` wiring (setting exists, commit side-effect not yet buffered) · Hook + approval pattern unification (single abstract surface across Audit Buffer / Pending Changes / Regression Guard feedback).

### v0.59.0 (2026-04-16)

First release on the Release-Plan-driven v0.59+ cadence. Theme: **sandbox primitives** — the agent's shell work gets a real terminal surface, and agent tasks can optionally run in a git-worktree sandbox so writes never touch main until an explicit accept.

- ✅ **Terminal-integrated agent command execution** (step c) — new [`AgentTerminalExecutor`](src/terminal/agentExecutor.ts) routes `run_command` / `run_tests` through `terminal.shellIntegration.executeCommand` in a reusable *SideCar Agent* terminal with `ShellSession` fallback. User sees commands execute live; shell integration inherits VS Code's remote shell session on SSH / Dev Containers / WSL / Codespaces where `child_process` escapes to the host. Timeout + abort both SIGINT via `^C`. +9 tests.
- ✅ **Shadow Workspace primitive** (step d.1) — new [`ShadowWorkspace`](src/agent/shadow/shadowWorkspace.ts) manages ephemeral git worktrees at `.sidecar/shadows/<task-id>/` via new `GitCLI` primitives (`worktreeAdd`, `worktreeRemove`, `worktreeList`, `getHeadSha`, `diffAgainstHead`, `applyPatch`). Captures tracked + untracked diff and applies back to main with `git apply --index` on accept. +14 tests against real tmp-repo fixtures.
- ✅ **cwd pinning through `ToolExecutorContext`** (step d.2) — new `cwd` field + `resolveRoot` / `resolveRootUri` helpers threaded through every `fs.ts` tool executor. Lets ShadowWorkspace route file ops into the shadow transparently. +8 tests.
- ✅ **Sandbox wrapper + end-to-end integration** (step d.3) — new [`runAgentLoopInSandbox`](src/agent/shadow/sandbox.ts) is a drop-in replacement for `runAgentLoop` that wraps in a shadow per `sidecar.shadowWorkspace.mode` (`off` | `opt-in` | `always`). Prompts via `showQuickPick` at end; accept applies diff to main, reject discards. `AgentOptions.cwdOverride` plumbed through `executeToolUses.ts`. +10 tests covering six dispatch paths.
- ✅ **CI coverage ratchet + denominator hygiene** (step a) — `vitest.config.ts` now enforces `coverage.thresholds` (initial floor 60/53/60/61) and excludes `*/types.ts`, `*/constants.ts`, `src/__mocks__/**`, `src/test/**`, `*.d.ts`. PRs that drop any of the four metrics fail CI.
- ✅ **Audit #13 + #15 + latent output-stomp bug** (step b) — `ShellSession` now reassembles truncated output tail-only on non-zero exit; `fileHandlers.handleRunCommand` fallback routes through `ShellSession` so hardening applies uniformly; `checkSentinel` stomp bug (discarding accumulated output for long commands) fixed. +4 tests.
- ✅ **lint-staged polish** — excludes the real-git shadow tests from the pre-commit vitest run; full suite still runs in CI.

**Explicitly deferred to v0.60** (scoped out of MVP): `/sandbox <task>` slash command · gate-command integration · per-hunk review UI · shell-tool cwd pinning · symlinked build dirs · rebase-on-moved-main conflict handling · vitest fast/integration config split.

### v0.58.1 — Security patch (2026-04-16)

- ✅ **`scheduledTasks` workspace-trust gate (CRITICAL)** — closed the last autonomous-agent-over-workspace-config hole. `checkWorkspaceConfigTrust('scheduledTasks', …)` now gates `scheduler.start()` the same way every other workspace-config-driven execution surface is gated.
- ✅ **`customTools` workspace-trust gate (HIGH)** — cached trust decision in `_customToolsTrusted` so `getCustomToolRegistry()` stays synchronous; blocked repos have their custom tool definitions dropped before they reach the tool list. +3 tests.
- ✅ **Empty `src/chat/` directory removed** — leftover from v0.57.0 decomposition.

### v0.58.0 (2026-04-16)

✅ **Haiku as the Anthropic default** — flipped `BUILT_IN_BACKEND_PROFILES[anthropic].defaultModel` from `claude-sonnet-4-6` to `claude-haiku-4-5`, plus a new provider-aware fallback in `readConfig()` at [settings.ts:500-526](src/config/settings.ts#L500-L526) that substitutes Haiku when the user switches provider to Anthropic without updating the model field. Users with explicit Sonnet/Opus settings are unaffected; users who switch-and-forget now land on a 3×-cheaper working default instead of either `claude-sonnet-4-6` cost or an invalid `qwen3-coder:30b` model error. Exposed constants `OLLAMA_DEFAULT_MODEL` and `ANTHROPIC_DEFAULT_MODEL` so downstream code can reference them without re-declaring. +4 tests covering the provider-aware fallback and backend-profile default.

✅ **Model-attribution git trailers** — every agent-authored commit now carries `X-AI-Model: <model> (<role>, <n> calls)` trailers via a new `SideCarClient.buildModelTrailers()` at [client.ts:341-371](src/ollama/client.ts#L341-L371) that aggregates a running `_modelUsageLog` of every `streamChat` / `complete` call. Multi-model sessions add an `X-AI-Model-Count: N` summary line. Threaded through a new `client?: SideCarClient` field on `ToolExecutorContext` ([shared.ts](src/agent/tools/shared.ts), [executeToolUses.ts](src/agent/loop/executeToolUses.ts#L145)) and consumed by [git.ts:120-129](src/agent/tools/git.ts#L120-L129); `GitCLI.commit` accepts an optional `extraTrailers` string appended after the existing `Co-Authored-By` line. Direct non-agent callers (tests, scripts) get the plain block unchanged. +7 client tests covering the aggregation, per-path dedup, call-count rendering, clear-log semantics, and defensive-copy guarantees.

✅ **`system_monitor` tool** — read-only CPU / RAM / VRAM probe at [systemMonitor.ts](src/agent/tools/systemMonitor.ts) (~200 LOC) the agent can call before a heavy build, model download, or parallel sub-agent run to decide whether to throttle. Cross-platform: `os.loadavg` + `os.cpus` for CPU, `os.totalmem` + `os.freemem` for RAM, and three GPU probes run in parallel (`nvidia-smi --query-gpu=...`, `rocm-smi --showmeminfo vram`, macOS `system_profiler SPDisplaysDataType`), returning whichever succeeds. No side effects, no `requiresApproval`. 6 tests covering CPU formatting, RAM percentage, nvidia-smi CSV parsing, the no-GPU fallback path, `include_gpu: false` short-circuit, and platform info — using `vi.mock('os', …)` with a mutable state object since `vi.spyOn(os, …)` doesn't work on ESM namespaces.

✅ **`/compact` emits structured Markdown summaries** — `ConversationSummarizer` at [conversationSummarizer.ts](src/agent/conversationSummarizer.ts) swaps free-form prose for a two-section output: `## Facts established` (bulleted turn-lines from the fast path, dense LLM paraphrases from the slow path) and `## Code changes` (deterministically extracted from `tool_use` blocks — `write_file` / `edit_file` / `delete_file` / `create_file` / `rename_file` / `move_file` / `apply_edit` / `apply_patch` — dedup-per-path keeping the last-seen tool, so a `write → edit → delete` sequence on the same file renders as one entry tagged `delete_file`). Fast-path short-circuit preserved — the deterministic assembly returns directly without an LLM round-trip when it fits in `maxSummaryLength`. LLM path receives the detected code-changes verbatim (no re-invention). Schema-ignoring LLM output falls back to the deterministic assembly so shape is guaranteed regardless of model compliance. +5 tests covering the new shape, code-change extraction, per-path dedup, section omission when no mutations seen, and the schema-ignoring fallback.

✅ **Plan-mode system prompt refresh** — [systemPrompt.ts:136-145](src/webview/handlers/systemPrompt.ts#L136-L145) rewritten in Claude Code style with an explicit 6-step exploration/design workflow (thorough exploration → similar-feature identification → multi-approach trade-offs → AskUserQuestion for clarification → concrete implementation strategy → `ExitPlanMode` for approval) and a read-only guardrail note ("DO NOT write or edit any files yet"). Complements the existing `approvalMode: 'plan'` short-circuit in the loop.

✅ **Context compression preserves `thinking` + `tool_use` pairs** — [compression.ts](src/agent/loop/compression.ts) was dropping old thinking blocks wholesale, but Anthropic's Extended Thinking API requires every thinking block to immediately precede its paired tool_use (400 Bad Request: "thinking must precede tool_use"). Detection (`hasToolUse` per message) now truncates paired thinking blocks to 200 chars instead of dropping; standalone thinking blocks 8+ messages from the end are still dropped as before since nothing downstream reads them.

✅ **Pre-commit hook: `vitest run --silent`** — lint-staged pipeline now runs the full test suite alongside prettier + eslint + tsc. Adds ~3s to the commit path but catches the common case of a dev committing code that breaks a test on their own machine. Honest note in the commit: does NOT catch host-dependent tests that pass locally but fail on clean runners — that class still requires CI on a clean environment (see next item).

✅ **Three host-dependent test failures closed** — same bug class audited and closed:
- [`providerReachability.test.ts`](src/config/providerReachability.test.ts) — kickstand `Authorization` header assertion failed on hosts without `~/.config/kickstand/token`. Fixed with a module-level `vi.mock('fs', …)` that stubs `existsSync` / `readFileSync` just for paths ending `kickstand/token` (passthrough for all other fs calls). Test now deterministic regardless of host state.
- [`modelHandlers.test.ts`](src/webview/handlers/modelHandlers.test.ts) — safetensors-import test asserted `importSafetensorsModel` was called but `runSafetensorsImportFlow` runs a disk-space preflight via `fs.statfsSync` requiring 2× the repo's total bytes free in `os.tmpdir()` — ~40 GB for the 20 GB fixture. Hosts below that threshold bailed silently. Fixed with `vi.mock('fs', …)` stubbing `statfsSync` to report 500 GB free.
- [`kickstandBackend.test.ts`](src/ollama/kickstandBackend.test.ts) — bearer-token assertion was wrapped in `if (headers.Authorization)` so it silently no-op'd on hosts without the token file, making the test a false-positive pass. Fixed with the same fs-mock pattern from (1) plus dropping the guard so the assertion is unconditional (`expect(headers.Authorization).toBe('Bearer test-kickstand-token')`).

Pattern recap: each of these tests read real OS state (home-dir paths, disk free space) without mocking, silently passed on hosts meeting an unstated precondition, and failed everywhere else. The audit followed the two first-fixed instances with a search for `statfsSync` / `homedir()` / `.config/` across the test surface — only the kickstandBackend test matched closely enough to warrant a fix. Audited-and-cleared files flagged as false positives by an earlier agent sweep: `conversationAnalytics.test.ts` (local-time → ISO → `getHours()` round-trip is TZ-stable), `chatState.test.ts` (reads back files the SUT itself just wrote), `systemMonitor.test.ts` (agent claimed `os.arch()` was missing from the mock; code never calls it), `shellSession.test.ts` (platform-gated `describe.skip` is intentional), `skillLoader.test.ts` (properly mocks `workspace.fs`). Bug class now closed for the current test surface.

✅ **ROADMAP v0.58+ vision batch** — 25 new entries across every section in 701 lines, grounded in shipped primitives by file:line and composing with each other rather than standing alone. Shipped as two commits (one refactor + one docs) to keep the git history legible. The vision set is too large to list inline here — see the Planned Features section above for the full entries. Notable themes: multi-agent patterns (Shadow Workspaces, Typed Facets, Fork & Parallel Solve, War Room), agent capabilities (Doc-to-Test, Diagnostic Reactive Fixer, Regression Guards, Browser-Agent Visual Verification, Research Assistant, Jupyter Notebook Support), retrieval infrastructure (Project Knowledge Index with LanceDB, Merkle fingerprints), observability (Role-Based Model Routing, RAG-Native Eval Metrics), and research-product parity (NotebookLM-Style Source-Grounded Research Mode).

✅ **Stats** — 9 commits since v0.57.0, 1940 total tests passing (4 skipped, 0 failing), tsc + eslint clean, pre-commit hooks green including the new vitest step.

### v0.50.0 (2026-04-14)

✅ **`runAgentLoop` god-function decomposition** (cycle-2 ai-engineering HIGH) — 1,216-line god function split into a thin 255-line orchestrator plus 14 focused helper modules under [`src/agent/loop/`](src/agent/loop/). Same extraction pattern as the successful [`tools.ts` split](src/agent/tools/) and [`handleUserMessage` decomposition](src/webview/handlers/chatHandlers.ts). 79% size reduction in loop.ts.

Helpers extracted across four phases:

- **Phase 1** (commits `2cf6ead`, `997cc44`): `state.ts` (LoopState interface + `initLoopState` factory that bundles all run state into one object), `compression.ts` (`applyBudgetCompression` + `maybeCompressPostTool` + `compressMessages` moved from bottom of loop.ts), `streamTurn.ts` (`streamOneTurn` + `resolveTurnContent` handling the per-event timeout race, abort/timeout markers instead of exceptions, and post-stream cleanup), `textParsing.ts` (`parseTextToolCalls` + `stripRepeatedContent`), `cycleDetection.ts` (`exceedsBurstCap` + `detectCycleAndBail` with their constants), `messageBuild.ts` (assistant + tool-result message push helpers, token accounting).

- **Phase 3** (commits `de159c8`, `99e4248`, `ba4b17a`, `e9a4e4a`, `bf9f530`): five post-turn policy + execution helpers. `stubCheck.ts` + `criticHook.ts` (the full adversarial critic runner moved here — runCriticChecks, RunCriticOptions, buildCriticDiff, extractAgentIntent — plus a thin `applyCritic` wrapper) + `gate.ts` (`recordGateToolUses` post-tool + `maybeInjectCompletionGate` empty-response branch) + `autoFix.ts` (diagnostic-driven reprompt with per-file retry budget) + `executeToolUses.ts` (the biggest extraction — parallel tool execution with spawn_agent / delegate_task / normal dispatch, Promise.allSettled result promotion, per-call agent-memory recording).

- **Phase 4** (commit `9452333`): `finalize.ts` (post-loop teardown + `generateNextStepSuggestions` moved from loop.ts bottom), `postTurnPolicies.ts` (composer for autoFix → stubCheck → critic), `notifications.ts` (iteration-start telemetry + progress summary + checkpoint prompt). Primitive state aliases (iteration, totalChars, stubFixRetries) collapsed — every reference in runAgentLoop now reads state directly via `state.xxx`. Resulting orchestrator reads top-to-bottom as pseudo-code for one iteration: abort check → compression → notifications → checkpoint → stream turn → empty-response gate → cycle checks → assistant message → tool execution → tool-result accounting → compression → post-turn policies → plan-mode return.

Size progression: 1216 → 876 → 835 → 765 → 652 → 629 → 591 → 417 → 255 lines across 9 commits. Each phase left the tree green (typecheck + 1798 unit tests + 6 then 11 eval cases).

Re-exports preserved (`compressMessages`, `parseTextToolCalls`, `stripRepeatedContent`, `runCriticChecks`, `RunCriticOptions`) so existing import sites in `loop.test.ts` and `critic.runner.test.ts` stay unchanged.

✅ **LLM evaluation harness — agent-loop layer** (cycle-2 ai-engineering HIGH) — extends the existing prompt-only `tests/llm-eval/` harness with a second layer that runs `runAgentLoop` end-to-end against a sandboxed temp-dir workspace. Closes the "No evaluation harness for LLM behavior. When we tweak the system prompt, add a tool, or change compression, there's no signal that answer quality regressed" audit finding.

Architectural finding that unlocked the build: despite the earlier prompt-eval README claim, `runAgentLoop` does NOT need `ChatState`. All the UI plumbing (`PendingEditStore`, `SkillLoader`, `AgentMemory`, `WorkspaceIndex`) lives on ChatState and is optional for headless execution. The agent core takes `(client, messages, callbacks, signal, options)` — clean separation. This also unblocks future headless automation.

Harness files under [`tests/llm-eval/`](tests/llm-eval/):

- `workspaceSandbox.ts` — per-case temp dir + real-node-fs-backed `workspace.fs` swap + `workspace.findFiles` mock with minimatch-style glob matching (supports `**`, `*`, `?`, `.`, `{a,b}`). Reverts the mutations on teardown for test isolation.
- `agentTypes.ts` — `TrajectoryEvent`, `AgentEvalCase`, `AgentExpectations` with `toolsCalled` / `toolsNotCalled` / `toolCallMatches` (partial-input substring matching) / `files.{exist,notExist,contain,notContain,equal}` / `finalTextContains` / `trajectoryHasToolError` predicates.
- `agentHarness.ts` — `runAgentCase` end-to-end runner + backend picker. Defaults to local Ollama since agent-loop cases burn real tokens; Anthropic + OpenAI opt-in via `SIDECAR_EVAL_BACKEND` env var.
- `agentScorers.ts` — deterministic scorer that walks the trajectory and post-run workspace snapshot, collecting failure strings for every violated predicate. Substring matching for tool-call inputs tolerates "src/a.ts" vs "./src/a.ts" vs "a.ts".
- `agentCases.ts` — 11 starter cases:
  - `read-single-file`, `rename-function`, `grep-for-todo` (read / edit / search trajectories)
  - `multi-tool-iteration` (parallel `read_file` dispatch)
  - `observe-tool-error-no-fabrication` (tool error observation + non-fabrication discipline)
  - `no-stub-in-write` (stub validator indirect coverage)
  - `fix-simple-bug` (read + edit bug-fix trajectory with file-content regression)
  - `search-files-glob` (`search_files` tool + glob matching)
  - `write-multi-file-batch` (parallel `write_file` dispatch)
  - `plan-mode-no-tools` (`approvalMode: 'plan'` short-circuit, assertion that no tools fire)
  - `search-then-edit-multi-file` (multi-step `grep` → `edit_file`, also incidentally exercises `maybeInjectCompletionGate` when the agent edits without verifying)
- `agent.eval.ts` — vitest runner mirroring `prompt.eval.ts`. Skips cleanly via `describe.skipIf` when no backend is available.

Runs via `npm run eval:llm`. Full suite takes ~90s against local Ollama (qwen3-coder:30b). Every runAgentLoop decomposition phase was verified end-to-end against the eval suite before commit — zero behavioral regressions across 9 refactor commits.

### v0.49.0 burn-down (post-v0.48.0, 2026-04-14)

✅ **Terminal-error injection gap closed** (cycle-2 LLM surface HIGH) — `diagnoseTerminalError` previously synthesized a user message containing raw stderr inside a markdown code block, bypassing the tool-output injection scanner entirely. A hostile Makefile/npm script emitting `[SYSTEM] Ignore previous instructions` landed verbatim as trusted user input. New [`wrapUntrustedTerminalOutput` helper in injectionScanner.ts](src/agent/injectionScanner.ts) runs the same 6-pattern scanner on captured output and wraps it in a `<terminal_output source="stderr" trust="untrusted">` envelope, prepending a SIDECAR SECURITY NOTICE banner when matches are found. 5 new regression tests covering benign passthrough, injection banner, banner-before-envelope ordering.

✅ **Skill description DOM-clobber fix** (cycle-2 security MEDIUM) — [chat.js attach menu](media/chat.js#L388) built `item.innerHTML = '<strong>/' + skill.id + '</strong>' + skill.description`, which let user-authored skill frontmatter smuggle markup past CSP via DOM-level attribute injection. Replaced with `createElement` + `textContent` like the rest of the webview already does.

✅ **Shell output ANSI stripping on the streaming path** (cycle-2 security MEDIUM) — `ShellSession.executeInternal` already stripped the final `output` buffer but passed streaming chunks raw to `onOutput`, where they flowed into the webview's `textContent +=` and displayed as garbage `^[[31m` sequences. The wrapper now applies `stripAnsi` to each chunk before the consumer callback, so one place gives one guarantee.

✅ **Settings menu focus return** (cycle-2 UX MEDIUM) — `closeSettingsMenu` in [chat.js](media/chat.js) now calls `settingsBtn.focus()` so keyboard users and screen readers don't lose their place after Escape or click-outside.

✅ **`switchBackend` profileId runtime type guard** (cycle-2 UX LOW) — [`sidecar.switchBackend`](src/extension.ts#L362) command now type-narrows `profileId` via `typeof profileId === 'string'` before `BUILT_IN_BACKEND_PROFILES.find(...)`. A stray non-string from a markdown-hover link or foreign postMessage no longer silently drops through to the picker without warning.

✅ **`aria-current="true"` on active profile button** (cycle-2 UX LOW) — the visible checkmark on the active backend profile is now also announced to assistive tech.

✅ **`isContinuationRequest` privatized** (cycle-2 arch LOW) — was exported from chatHandlers.ts for no reason; only consumed within the same file. `classifyError` and `keywordOverlap` stay exported because they have their own test file coverage.

✅ **Stale audit items struck** — four cycle-2 findings were actually already fixed and never marked:
  - HIGH "no rate-limit awareness" — `maybeWaitForRateLimit` has been in every backend's streamChat path since v0.47.0.
  - MEDIUM "`BackgroundAgentManager` shared shellSession" — closed by commit `e32ab49` (per-run ToolRuntime).
  - MEDIUM "MCP header `${VAR}` expansion pulls from unfiltered `process.env`" — `resolveEnvVars` has been scoped to the per-server `env` block only since cycle-1.
  - MEDIUM "chatView.ts direct `getConfiguration('sidecar')` reads" — only `.update()` writes remain, which have to use raw getConfiguration by design.

### Post-v0.47.0 (2026-04-14)

✅ **Adversarial critic verification pass** — [critic.ts](src/agent/critic.ts) was already fully built (355 lines, 35 unit tests) but had no loop-side integration tests. Exported `runCriticChecks` + `RunCriticOptions` as a test seam and added 13 integration tests covering trigger selection (edit vs test_failure), severity dispatch (high blocks, low annotates, blockOnHighSeverity toggle), per-file injection cap enforcement across multiple turns, malformed-response handling, network-error swallowing, and early abort. Total suite: 1753 passing. Feature now gated on `sidecar.critic.enabled` (default off) — a cheaper `criticModel` override is recommended for paid backends. Removed from Planned Features — was never really "planned," just stale.

✅ **Per-run ToolRuntime for background agents** (cycle-2 arch MEDIUM) — fix for parallel background agents sharing a single `defaultRuntime.shellSession`. `BackgroundAgentManager.executeRun` now constructs a fresh `ToolRuntime` per run and threads it through `AgentOptions.toolRuntime` → `ToolExecutorContext.toolRuntime` → `resolveShellSession(context)` in [tools/shell.ts](src/agent/tools/shell.ts). 20 new tests across [tools/runtime.test.ts](src/agent/tools/runtime.test.ts), [tools/shell.test.ts](src/agent/tools/shell.test.ts), and [backgroundAgent.test.ts](src/agent/backgroundAgent.test.ts). Parallel-run isolation verified with deferred promises. Foreground chat sessions continue to use the default runtime with no behavior change.

✅ **OpenAI backend profile + agent setting tools** — new `openai` entry in `BUILT_IN_BACKEND_PROFILES` (gpt-4o default, `sidecar.profileKey.openai` secret slot) picks up automatically in the Switch Backend QuickPick. Three new agent tools in [tools/settings.ts](src/agent/tools/settings.ts): `switch_backend` (enum of built-in profiles), `get_setting` (read-only, blocks secrets), and `update_setting` (user-scope writes with a 17-key security denylist for secrets, backend identity, tool permissions, MCP servers, hooks, outbound allowlist, system prompt, and context paths). New `alwaysRequireApproval` field on `RegisteredTool` forces an approval modal on every call — even in autonomous mode, even when `toolPermissions: allow` is set — so the user's durable configuration never changes without an explicit click.

✅ **tools.ts god-module split** — 1340-line `src/agent/tools.ts` decomposed into `src/agent/tools/` with one file per subsystem (`fs`, `search`, `shell`, `diagnostics`, `git`, `knowledge`, `settings`) plus `shared.ts` (path validation, sensitive-file guard, shell helpers) and `runtime.ts` (ToolRuntime container). `tools.ts` is now a 260-line orchestrator composing `TOOL_REGISTRY` and re-exporting types for backward compat. Every pre-split import site resolves without edits. Closes cycle-2 architecture HIGH.

---

### v0.47.0

Large native VS Code integration pass plus cost-control and hybrid-delegation work for paid backends. 14 new native surfaces, one new agent tool, prompt pruner + caching pipeline, 171 new tests.

### Cost controls & delegation

✅ **Session spend tracker** — `SpendTracker` singleton with Claude price table (Opus 4.6/4.5, Sonnet 4.6/4.5, Haiku 4.5 + 3.x fallbacks). Credit-card status bar item with QuickPick breakdown. Commands: `SideCar: Show Session Spend`, `SideCar: Reset Session Spend` ([spendTracker.ts](src/ollama/spendTracker.ts))

✅ **Anthropic prompt caching** — `cache_control` breakpoints on tool definitions + message history so agent loops cache-read the stable prefix ([anthropicBackend.ts](src/ollama/anthropicBackend.ts))

✅ **Prompt pruner** — whitespace collapse, head+tail tool-result truncation, duplicate tool-result dedup. 90.2% reduction on realistic verbose fixtures. Settings: `sidecar.promptPruning.enabled`, `sidecar.promptPruning.maxToolResultTokens` ([promptPruner.ts](src/ollama/promptPruner.ts))

✅ **`delegate_task` tool** — hybrid-architecture tool on paid backends that offloads read-only research to a local Ollama worker. Worker runs on its own `SideCarClient` with a read-only tool subset, returns a structured summary. Token usage doesn't touch paid-budget accounting. Settings: `sidecar.delegateTask.enabled`, `.workerModel`, `.workerBaseUrl` ([localWorker.ts](src/agent/localWorker.ts))

✅ **`StreamEvent` usage event + `TokenUsage` type** — backends emit usage at `message_stop`, client forwards to spend tracker transparently ([types.ts](src/ollama/types.ts))

### Native VS Code integration

✅ **Native error toasts with one-click recovery actions** — `errorSurface.ts` promotes auth / connection / model errors to `window.showErrorMessage` with `Set API Key` / `Switch Backend` buttons that execute real VS Code commands ([errorSurface.ts](src/webview/errorSurface.ts))

✅ **Status bar health indicator** — `healthStatus.ts` drives the model status bar item's icon / background color / MarkdownString tooltip. Red on error, green on ok. Tooltip has clickable `command:` links for one-click recovery ([healthStatus.ts](src/ollama/healthStatus.ts))

✅ **Lightbulb code actions** — `SidecarCodeActionProvider` contributes `Fix with SideCar` (QuickFix on diagnostics), `Explain this error with SideCar`, and `Refactor with SideCar` (RefactorRewrite) to VS Code's native code actions menu ([sidecarCodeActionProvider.ts](src/edits/sidecarCodeActionProvider.ts))

✅ **Native modal approval for destructive tools** — `run_command`, `run_tests`, and git mutation tools now open a blocking `showWarningMessage({modal: true})` instead of the inline chat card. User can't miss the prompt while scrolled away from chat ([executor.ts](src/agent/executor.ts))

✅ **Persistent empty-state welcome card** — replaces the legacy one-shot onboarding. Renders when chat is empty, shows active model / quick-action buttons / starter prompt chips / platform-aware shortcut hints. Auto-hides on first message, reappears on Clear Chat ([chat.js](media/chat.js))

✅ **File decoration provider for pending agent edits** — `P` badge with `gitDecoration.modifiedResourceForeground` color on every file with a pending review-mode edit. Propagates to parent folders like git's M/A/D markers ([pendingEditDecorationProvider.ts](src/edits/pendingEditDecorationProvider.ts))

✅ **Problem markers in the Problems panel** — `sidecarDiagnostics.ts` publishes security scan results with source tags `sidecar-secrets`, `sidecar-vulns`, `sidecar-stubs`. Leaked keys, eval calls, TODO stubs appear natively alongside tsc/eslint findings ([sidecarDiagnostics.ts](src/agent/sidecarDiagnostics.ts))

✅ **Getting-started walkthroughs contribution** — five-step `contributes.walkthroughs` page in VS Code's Welcome editor. Auto-opens on first install, reopenable via `SideCar: Open Walkthrough` ([media/walkthroughs/](media/walkthroughs/))

✅ **Quick Pick model switcher** — `sidecar.selectModel` opens a native QuickPick with installed models (flagged with `$(check)` for active) and library models (flagged with `$(cloud-download)` for not-yet-installed). Shares the model-switch path with the webview dropdown via a new public `ChatViewProvider.setModel(name)` ([extension.ts](src/extension.ts))

✅ **Activity bar badge for pending-review count** — `treeView.badge = {value, tooltip}` on the `sidecar.reviewPanel` TreeView. VS Code aggregates the badge up to the Activity Bar icon automatically ([reviewPanel.ts](src/agent/reviewPanel.ts))

✅ **Native progress notifications for long operations** — `window.withProgress({location: ProgressLocation.Notification})` wraps `sidecar.reviewChanges`, `sidecar.summarizePR`, `sidecar.generateCommitMessage`, `sidecar.scanStaged` ([extension.ts](src/extension.ts))

### Command palette audit & polish

✅ **Consistent `SideCar:` category across every palette command** — added `"category": "SideCar"` + icons to every command, fixed three inconsistent titles, gated tree-item-only commands from the palette via `menus.commandPalette` with `when` clauses

✅ **Settings polish** — `enumDescriptions` on `sidecar.provider` / `sidecar.chatDensity`, upgraded ~30 `description` → `markdownDescription` with code formatting and cross-setting links, `order` fields for logical clustering (backend → context → agent → cost → UI), `tags` for filter chips, `minimum`/`maximum` guardrails

✅ **Right-click context menu on chat messages** — delegated `contextmenu` handler with dynamic items (Copy message / Delete message / Copy code / Save code as... / Why? / Copy output). Each item supports an optional `detail` suffix so "Why?" entries are labeled with the tool name ([chat.js](media/chat.js))

✅ **Custom 150ms tooltips on chat view buttons** — `[data-tooltip]` + `aria-label` pattern replaces HTML `title` (500-1000ms delay), styled with `--vscode-editorHoverWidget-*` tokens ([chat.css](media/chat.css))

✅ **Killed duplicate slash commands** — `/reset`, `/export`, `/compact`, `/undo` removed; they duplicated header buttons or palette commands. `/help` autocomplete updated

✅ **Anthropic `listInstalledModels` fix** — now hits `/v1/models` with `x-api-key` + `anthropic-version` headers. Before: fell through to Ollama `/api/tags` and threw "Cannot connect to API" even with a valid key

✅ **`SideCar: Set / Refresh API Key` command** — renamed, icon added, surfaced in chat view title bar, trims whitespace on save, reloads models after save so the UI recovers without a window reload

---

---

## Audit Archive

Historical audit cycles in reverse-chronological order. Cycle-3 findings (v0.58.1, 2026-04-16) are folded into the Release Plan above — closed items from cycle-1 and cycle-2 are preserved here for lineage.

### Cycle-2 audit — architecture + AI-engineering pass (post-v0.47.0, 2026-04-14)

Closed the small-to-medium HIGH items from cycle-2 Architecture and
AI Engineering in a five-commit pass:

✅ **ChatState.dispose() + hoist SIDECAR.md cache off module globals**
(commit `fab3a50`) — two related Architecture HIGH findings. `sidecarMdCache`
and `sidecarMdWatcher` moved from free-floating module globals in
chatHandlers.ts onto private fields of `ChatState` with a new
`loadSidecarMd()` method. `ChatState.dispose()` is idempotent and
tears down the abort controller, pending confirmations, the owned
`PendingEditStore`, and the watcher. `ChatViewProvider.dispose()`
cascades through.

✅ **Review-mode overlay for grep / search_files / list_directory**
(commit `6baef11`) — cycle-2 AI-engineering HIGH. New
`computePendingOverlay` helper runs after the normal executor path
and appends a `⚠ Pending edits (review mode)` section listing
shadow-store matches the disk scan misses. grep re-runs the pattern
against pending content; search_files and list_directory overlay
pending new files with explicit tags.

✅ **Thinking + tool_use atomic compression**
(commit `291ba02`) — cycle-2 AI-engineering HIGH. `compressMessage`
detects the atomic thinking→tool_use chain and downgrades thinking
compression from `heavy` to `medium` for that message so Anthropic
Extended Thinking's signed-thinking verification doesn't fail on
replay. Standalone thinking still gets dropped at heavy level.

✅ **Doc "RAG" → "Doc Index" rename**
(commit `f503627`) — cycle-2 AI-engineering HIGH. Class-level docs,
README, and docs/rag-and-memory.md all updated to accurately describe
the keyword-tokenized paragraph index instead of misleadingly calling
it RAG. Setting keys kept for backward compatibility. The audit's
"either rename or build real RAG" offer is answered with the rename;
a future retriever-fusion layer (separate HIGH item) will build on
the existing embedding index.

✅ **Audit reconciliation** — the cycle-2 "MCP tool result content is
not counted toward `totalChars`" finding is stale. MCP tools use the
same `executor` interface as native tools, and `getContentLength`
already counts them via the `tool_result` block branch. No code change
needed. Marked in the backlog for closure.

Tests: 1694 passing (+15 new regression tests across the four code
changes), 0 regressions.

**Deferred for a dedicated session** (each is weeks of work):
- `chatHandlers.ts` split into directory (1708 lines)
- ~~`tools.ts` god-module decomposition (~950 lines)~~ → **completed 2026-04-14**. Split into [`src/agent/tools/`](src/agent/tools/) with one file per subsystem (`fs`, `search`, `shell`, `diagnostics`, `git`, `knowledge`) plus `shared.ts` (path validation, sensitive-file blocklist, shell helpers) and `runtime.ts` (ToolRuntime container). `tools.ts` is now a 249-line orchestrator that composes `TOOL_REGISTRY` and re-exports types for backward compatibility. 1694 tests still pass.
- ~~`runAgentLoop` god-function decomposition (~700 lines)~~ → **completed 2026-04-14 in v0.50.0**. 1216-line god function → 255-line orchestrator + 14 helpers under [`src/agent/loop/`](src/agent/loop/) across 9 commits. 79% reduction.
- ~~`PolicyHook` interface for loop mechanics~~ → **completed 2026-04-15 in v0.54.0**. See the audit-backlog strike at [src/agent/loop/policyHook.ts](src/agent/loop/policyHook.ts). User-config-driven hook loading remains deferred.
- ~~Backend anticorruption layer (`normalizeStream`)~~ → **completed 2026-04-15 in v0.53.0**. New [`src/ollama/openAiSseStream.ts`](src/ollama/openAiSseStream.ts) factors OpenAI-compatible SSE parsing into a reusable helper; OpenAIBackend + Kickstand + OpenRouter all delegate to it. Unblocks OpenRouter (shipped in the same release) + future LM Studio / vLLM / Groq / Fireworks integrations as tiny subclass wrappers.
- ~~Real retriever-fusion layer (`Retriever` interface + reciprocal-rank)~~ → **completed 2026-04-14 across v0.51.0 + v0.52.0**. v0.51 shipped the `Retriever` interface, RRF fusion, and adapters for documentation index + agent memory in [`src/agent/retrieval/`](src/agent/retrieval/). v0.52 wrapped workspace semantic search as the third retriever by splitting `WorkspaceIndex.getRelevantContext()` into `rankFiles` / `loadFileContent` / render-helper phases, so all three sources now compete under a single shared budget inside `injectSystemContext`.

---

### Cycle-2 audit — prompt-engineering pass (post-v0.47.0, 2026-04-14)

Closed **all 11** cycle-2 prompt-engineer findings across two commits:
`e23f641` (system prompt rewrite) and `ec772f7` (tool description
standardization).

✅ **Positive framing** — all historic "don't" / "never" directives
rewritten as positive directives with trailing "(Avoid X.)" contrast
clauses. Transformer attention to negation is unreliable; the
contrastive clause preserves the warning without leading with it.

✅ **Cache-stability fix** — project root removed from the base prompt
and injected as a late `## Session` block that lands after the
`## Workspace Structure` cache marker. Stable cacheable prefix is now
~1177 tokens, past Anthropic's 1024-token floor, so cross-project
cache hits work for the first time.

✅ **Tool-selection decision tree** — new `## Choosing a tool` section
with 10 common query → tool pairings so the model has an explicit
heuristic instead of inferring from each tool description in isolation.

✅ **Plan-mode filled-in example** — plan mode now ships with a
concrete GitHub OAuth callback example the model can pattern-match,
not just a format skeleton.

✅ **Tool description standardization** (commit `ec772f7`) — every
registry tool now follows the "description + when to use + when NOT
to use + example" shape. The "when NOT to use" clause redirects the
model to the right peer tool. Two new tests pin the minimum
specificity so future edits can't silently drop it.

✅ **Already-shipped items reconciled** — tool-output-as-data rule,
"I don't know" permission, local/cloud consolidation, Rule 0 promoted
to Facts preamble, rule 3 conciseness clarifier, and rule 11 ask_user
counterbalance were all already in place from earlier passes; marked
struck-through in the cycle-2 backlog.

Tests: 1677 passing (+3 new assertions for cache stability, decision
tree, positive framing, and plan-mode example).

---

### Cycle-2 audit — security pass (post-v0.47.0, 2026-04-14)

Closed every CRITICAL and every Security/Safety HIGH finding from the
cycle-2 audit backlog in a focused 4-commit pass. 44 new tests, zero
regressions, total suite at 1674 passing.

✅ **C1: Indirect prompt injection** (commit `c561e1a`) — three-layer defense. Structural `<tool_output>` wrapping + base-prompt "data not instructions" rule + new [injectionScanner.ts](src/agent/injectionScanner.ts) with six narrow regex categories. On match, a `⚠ SIDECAR SECURITY NOTICE` banner is prepended inside the wrapper and logged via AgentLogger. 27 tests.

✅ **C2: Image token counting** — already fixed (stale audit entry). `getContentLength` now uses `Math.ceil((data.length * 3) / 4)` for image blocks at [types.ts:138](src/ollama/types.ts#L138).

✅ **H1: `run_tests` shell injection** — already fixed (stale audit entry). `validateFilePath` + `hasShellMetachar` + `shellQuote` at [tools.ts:587-600](src/agent/tools.ts#L587-L600).

✅ **H2: Untrusted workspaces auto-load prompt context** — closed the last gap. `.sidecarrules` now gated on `workspace.isTrusted` (commit `9344a21`), matching the existing gates on SIDECAR.md, skills, doc RAG, agent memory, and MCP stdio spawn.

✅ **H3: Audit log + agent memory writable** — already fixed (stale audit entry). `PROTECTED_WRITE_PREFIXES` at [tools.ts:277-282](src/agent/tools.ts#L277) blocks writes under `.sidecar/logs/`, `.sidecar/memory/`, `.sidecar/sessions/`, `.sidecar/cache/`.

✅ **H4: Shell state-pollution timebomb** (commit `a61f848`) — per-command hardening prefix in [shellSession.ts:31-70](src/terminal/shellSession.ts#L31) wipes user-defined shell functions and disables alias expansion before every command. Dispatches on bash vs zsh. Preserves cwd + env vars. 2 regression tests.

✅ **H5: Per-iteration tool-call rate limit** — already fixed (stale audit entry). `MAX_TOOL_CALLS_PER_ITERATION = 12` at [loop.ts:158](src/agent/loop.ts#L158) with explicit bail on overflow.

✅ **H6: Excessive agency in cascade tool sequences** (commit `d276b8d`) — two defenses. [webSearch.ts](src/agent/webSearch.ts) refuses queries containing credential-shaped tokens (AWS/GitHub/Anthropic/OpenAI/Slack/JWT/private-key) to prevent query-string exfiltration. New `sidecar.outboundAllowlist` setting gates `resolveUrlReferences` URL fetching to configured hosts. 14 tests. `run_command curl` bypass is known future work mitigated by v0.47.0 native modal approval.

---

### v0.45.0

✅ **Streaming text tool-call interception** (v0.45.0)
- New streaming parser in `streamUtils.ts` normalizes `<function=name>...</function>` and `<tool_call>{...}</tool_call>` blocks into structured `tool_use` events at the Ollama and OpenAI backend boundaries
- qwen3-coder, Hermes, and similar models no longer leak raw XML into chat bubbles
- Handles chunk-boundary partial markers, unknown tool names, and unclosed bodies

✅ **Incremental markdown parser** (v0.45.0)
- `finishAssistantMessage` appends only the unrendered tail instead of wiping and re-parsing the entire assistant message
- Preserves code blocks, lists, and headings built during streaming
- Removes the per-finish O(N) re-parse cost on long replies

✅ **Message list virtualization** (v0.45.0)
- `IntersectionObserver`-based detach/reattach of offscreen text messages in long sessions
- Preserves pixel height via inline style; rehydrates on scroll-back from stored raw markdown
- Rich widgets (audit cards, diffs, mermaid diagrams, confirmation panels) stay fully mounted

✅ **Enhanced reasoning visualization** (v0.45.0)
- Thinking blocks close out when a tool call starts, producing discrete numbered steps
- CSS counter-based step pills (purple for reasoning, blue for tools) with per-step duration badges
- Each reasoning/tool cycle renders as its own timeline segment

✅ **Customizable chat UI themes** (v0.45.0)
- `sidecar.chatDensity` (compact/normal/comfortable), `sidecar.chatFontSize` (10–22), `sidecar.chatAccentColor`
- Applied as CSS custom properties via a new `uiSettings` message, re-pushed on settings change (no reload)
- Accent color values pass through an allowlist CSS-color validator

✅ **Terminal error interception** (v0.45.0)
- `TerminalErrorWatcher` subscribes to `onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`
- Drains output tail, strips ANSI, dedupes within a 30s cooldown window
- On non-zero exit: shows **Diagnose in chat** notification; accepting injects a synthesized prompt with command, exit code, cwd, and output tail
- Skips SideCar's own terminal; silently no-ops when shell integration is unavailable
- Toggle with `sidecar.terminalErrorInterception` (default on)

---

### v0.42.0

✅ **Semantic search** (v0.42.0)
- ONNX embedding index using all-MiniLM-L6-v2 (384-dim, ~23MB quantized)
- Cosine similarity search blended with heuristic scoring (configurable weight)
- Binary cache in `.sidecar/cache/embeddings.bin` with content-hash deduplication
- Lazy model loading — extension works immediately, embeddings build in background
- Settings: `sidecar.enableSemanticSearch`, `sidecar.semanticSearchWeight`

✅ **Stub validator** (v0.42.0)
- Post-generation scanner detects 14 placeholder pattern categories in agent-written code
- Auto-reprompts the model to finish incomplete implementations (1 retry)
- Patterns: TODO/FIXME, "real implementation" deferrals, pass-only bodies, "for now" hedging, ellipsis bodies
- False positive filtering for issue tracker references (TODO(#123))

✅ **Streaming diff preview** (v0.42.0)
- File writes in cautious mode open VS Code's diff editor immediately
- Dual accept/reject UI: VS Code notification (in editor) + chat confirmation card — first click wins
- Session-based lifecycle with `update()`/`finalize()`/`dispose()` for incremental content updates

✅ **Structured context rules** (v0.42.0)
- `.sidecarrules` JSON files with glob-pattern matching
- Rule types: `prefer` (boost score), `ban` (exclude), `require` (ensure minimum score)
- Applied during workspace context building alongside heuristic and semantic scoring

✅ **Chat log tmp files** (v0.42.0)
- Every conversation logged as JSONL to `$TMPDIR/sidecar-chatlogs/`
- Records user messages, tool calls, and assistant responses with timestamps

✅ **Message persistence fix** (v0.42.0)
- `serializeContent()` preserves tool_use, tool_result, and thinking blocks during session save
- Messages no longer drop when switching between chats

✅ **Recency bias fixes** (v0.42.0)
- Topic-change detection resets workspace file scores when keyword overlap < 15%
- Agent memory session cap at 2 per search
- Conversation summarizer keeps 2 recent turns (was 4)
- Pending question threshold tightened to 8 words

✅ **Integration test infrastructure** (v0.42.0)
- `@vscode/test-electron` + `@vscode/test-cli` running 32 integration tests inside real VS Code
- Unit test coverage: 50.9% → 62.1% (1003 → 1227 tests)

---

### v0.41.0

✅ **Observability suite** (v0.41.0)
- Agent action audit log: structured JSONL in `.sidecar/logs/audit.jsonl`, browsable via `/audit` with filters (`errors`, `tool:name`, `last:N`, `since:date`, `clear`)
- Model decision explanations: "Why?" button on tool call cards with on-demand LLM reasoning
- Conversation pattern analysis: `/insights` command with tool performance stats, sequence analysis, co-occurrence matrix, hourly activity heatmap, error clusters, and suggestions

✅ **MCP capability refinement** (v0.41.0)
- HTTP (Streamable HTTP) and SSE transport support alongside stdio
- `.mcp.json` project-scope config file (Claude Code compatible format)
- Per-tool enable/disable via `tools` config
- Output size limits (`maxResultChars`, default 50K)
- Health monitoring with automatic reconnection (exponential backoff)
- `/mcp` status command showing server status, transport, and tool counts
- `mcp-builder` built-in skill for creating high-quality MCP servers
- Environment variable expansion in HTTP headers (`${VAR}`)

---

### v0.40.0

✅ **Deep codebase indexing: call sites & type hierarchies** (v0.40.0)
- Symbol graph extended with `CallEdge` and `TypeEdge` data structures
- Regex parser extracts call sites and extends/implements from JS/TS/JVM files
- New query methods: `getCallers()`, `getSubtypes()`, `getSupertypes()`
- `getSymbolContext()` enriched with caller, supertype, and subtype information
- Graph persistence bumped to version 2

✅ **Conversation steering** (v0.40.0)
- Next-step suggestions after agent loop (clickable buttons in webview)
- Progress summaries every 5 iterations with token/time stats
- Checkpoint prompt at 60% of max iterations — user can stop or continue

✅ **Enhanced agent memory** (v0.40.0)
- Tool chain tracking: records sequences, stores chains of 3+, deduplicates
- Failure learning: tool failures recorded as `failure` type memories
- `recordUse()` auto-called on search retrieval — use counts reflect real usage
- Co-occurrence scoring: `getToolCooccurrences()` and `suggestNextTools()`

---

### v0.38.0

✅ **Large file & monorepo handling** (v0.38.0)
- Streaming file reader with configurable threshold (default 50KB)
- Files above threshold use head+tail summary instead of full content
- Lazy indexing for large directories with progress tracking
- Depth-limited traversal (configurable, default unlimited)
- Multi-root workspace support via `sidecar.workspaceRoots` setting
- Prevents context bloat while maintaining code understanding

✅ **RAG over documentation** (v0.38.0)
- Automatic discovery in README*, docs/**, wiki/** folders
- Keyword-based search with title/body scoring (title 3x higher weight)
- Per-message retrieval injected after skills, before workspace context
- Respects remaining context budget (gracefully truncates if needed)
- Configurable via `sidecar.enableDocumentationRAG`, `sidecar.ragMaxDocEntries`, `sidecar.ragUpdateIntervalMinutes`

✅ **Agent memory (persistent learning)** (v0.38.0)
- JSON-based storage in `.sidecar/memory/agent-memories.json`
- Tracks patterns (tool uses), decisions, and conventions
- Use-count tracking and relevance scoring
- Per-message search injected alongside RAG results
- Automatic recording of successful tool executions
- LRU eviction when limit reached (default 500 entries, max 500)
- Configurable via `sidecar.enableAgentMemory`, `sidecar.agentMemoryMaxEntries`
- Auto-loads on startup, persists on every change

---

### Audit Backlog (v0.34.0)

Remaining findings from seven comprehensive reviews. Fixed items removed.

### Security

- ~~SVG sanitizer is regex-based (`chat.js:112`), bypassable with `unsafe-eval` CSP~~ → replaced with DOMParser + allowlist
- ~~`@file:` references (`workspace.ts:104`) have no path traversal validation~~ → path.resolve + startsWith guard
- ~~CSP allows `unsafe-eval` (required by mermaid.js)~~ → documented why, tightened connect-src to specific ports
- ~~Event hooks pass unsanitized file paths in env vars (`eventHooks.ts:65`)~~ → control character stripping
- ~~API keys stored in plaintext `settings.json` — consider VS Code `SecretStorage`~~ → migrated to SecretStorage with auto-migration on activation and `SideCar: Set API Key` command
- ~~GitHub token requests full `repo` scope — overly broad~~ → documented why, added createIfNone:false first
- ~~Workspace settings can bypass tool permissions (`executor.ts:52`)~~ → workspace trust warning added
- ~~MCP configs in workspace settings can spawn arbitrary processes~~ → workspace trust warning added
- ~~Default `confirmFn` auto-approves — should default to deny~~ → defaults to 'Deny'
- ~~Unbounded background command spawning (`shellSession.ts:237`)~~ → 10-process limit with auto-cleanup

### Architecture

- ~~`handleUserMessage` is 500+ lines — needs decomposition~~ → 443 → 172 lines via six extracted helpers: `prepareUserMessageText`, `updateWorkspaceRelevance`, `connectWithRetry`, `checkBudgetLimits`, `buildSystemPromptForRun`, `recordRunCost`, plus a `createAgentCallbacks` factory that owns the per-run text buffer / flush timer / current iteration closure ([chatHandlers.ts](src/webview/handlers/chatHandlers.ts))
- ~~Parallel `write_file` to same path races — serialize writes~~ → per-path mutex via [`withFileLock`](src/agent/fileLock.ts) wrapping every tool that writes at [executor.ts:292](src/agent/executor.ts#L292)
- ~~Module-level singletons (`shellSession`, `symbolGraph`) create hidden coupling~~ → unified into a single `ToolRuntime` class in [tools.ts](src/agent/tools.ts) with one dispose point, one injection seam, and a `getDefaultToolRuntime()` accessor; backward-compat `disposeShellSession()` / `setSymbolGraph()` wrappers keep existing tests and extension activation unchanged
- ~~`messages` array mutated from multiple async paths~~ → previous run aborted + `chatGeneration` bumped **before** any new mutation at [chatHandlers.ts:737-741](src/webview/handlers/chatHandlers.ts#L737-L741); stale completions dropped via generation check
- ~~MCP tool errors lose server/call context~~ → wrapped callTool() in try/catch, errors include server name + tool name + input
- ~~Error classifier missing 429, 5xx, content policy, token limit~~ → 4 new error types added: rate_limit, server_error, content_policy, token_limit
- ~~Hook failures silently swallowed — policy hooks don't block~~ → runHook() returns error string; pre-hook failures block tool execution
- ~~Custom tool registry rebuilt every call — cache needed~~ → cached with JSON snapshot key, rebuilds only on config change
- ~~`executeTool` has 10 positional parameters — use options object~~ → ExecuteToolOptions interface, function signature is now (toolUse, opts)

### AI Engineering

- ~~Anthropic backend doesn't use `abortableRead` — stalls can't be cancelled~~ → streams read through [`abortableRead`](src/ollama/streamUtils.ts) at [anthropicBackend.ts:108](src/ollama/anthropicBackend.ts#L108)
- ~~Malformed Anthropic tool input silently becomes `{}`~~ → raw JSON surfaced via `_malformedInputRaw` at [anthropicBackend.ts:154-169](src/ollama/anthropicBackend.ts#L154-L169) and rejected up-front in [executor.ts:77-85](src/agent/executor.ts#L77-L85) with a descriptive error instead of calling the tool with empty args
- ~~Token estimation inconsistency: chars/3.5 in loop vs chars/4 in pruner~~ → single `CHARS_PER_TOKEN` constant at [constants.ts:8](src/config/constants.ts#L8) used everywhere (loop, metrics, contextReport, chatHandlers pruning message)
- ~~Cycle detection only catches exact 2-repetition~~ → detects cycles of length 1..4 with 8-entry window
- ~~File content cache not invalidated on change (5-min stale window)~~ → invalidate on watcher change/delete events
- ~~Query matching is path-substring only~~ → tokenize() splits camelCase/snake_case/paths and matches against query words
- ~~Tool support deny list is static — consider `ollama show` API~~ → replaced with dynamic `/api/show` capabilities probe
- ~~Ollama discards non-`'stop'` done_reason for tool calls~~ → emit `tool_use` stop reason whenever tool calls were yielded
- ~~`autoFixRetries` never resets between file writes~~ → per-file Map<path, retries> tracking
- ~~Sub-agent token usage not tracked in parent's budget~~ → onCharsConsumed callback + SubAgentResult.charsConsumed propagation
- ~~Timeout promise timers never cleared on success~~ → clearTimeout in finally after Promise.race

### Prompt Engineering

- ~~Summarization truncates at 100/150 chars, losing file paths~~ → 200/300 chars with word-boundary smartTruncate
- ~~Workspace context lacks section delimiter~~ → `## Project Documentation`, `## Agent Memory`, `## Workspace Context` headers
- ~~`spawn_agent` description too vague for local models~~ → good/bad use cases, iteration/depth limits documented
- ~~`run_command` doesn't clarify `command`/`command_id` mutual exclusivity~~ → explicit in description + required changed to []
- ~~Tool descriptions lack inline examples (grep, run_command)~~ → examples added to search_files, grep, run_command
- ~~`git_branch`/`git_stash` action params lack `enum` constraints~~ → enum arrays added
- ~~Sub-agent recursion not depth-limited~~ → MAX_AGENT_DEPTH=3 enforced in spawnSubAgent

### UX/UI

- ~~Touch targets too small: scroll-to-bottom 28px, header buttons ~24px, image remove 16px~~ → enlarged to 36px/32px min/24px
- ~~Spacing not on 8pt grid — mix of 2/4/6/8/10/12/14/16/20px values~~ → ~25 off-grid values normalized
- ~~Font size scale ad hoc (10px below minimum readable)~~ → all 10px bumped to 11px
- ~~Panel overlays hardcode `top: 42px`~~ → header-wrapper with `position: relative` + `top: 100%`
- ~~Close panel buttons have no padding (~12x18px click target)~~ → padding + hover background added
- ~~Model list lacks search/filter~~ → search input with auto-focus on open

### Code Quality

- ~~`/init` wrote SIDECAR.md via `workspace.fs.writeFile`, leaving open editor tabs showing stale in-memory content until manual revert~~ → routed through `WorkspaceEdit.replace` against the full document range + `doc.save()` so VS Code's in-memory `TextDocument` stays in sync with disk ([agentHandlers.ts:168-209](src/webview/handlers/agentHandlers.ts#L168-L209))
- ~~`loop.ts:91` — hand-rolled char counting duplicates `getContentLength()`~~ → tool-use / tool-result accounting now calls `getContentLength(pendingToolUses)` + `getContentLength(toolResults)` at [loop.ts:565-566](src/agent/loop.ts#L565-L566)
- ~~`chat.js:527` — 6 card rendering branches repeat identical DOM construction~~ → shared `ghDiv` / `ghStatePill` / `ghLink` / `ghCardTitle` / `ghAuthorMeta` helpers at [chat.js:865-900](media/chat.js#L865-L900); all 6 action branches rebuilt on them
- ~~`chatHandlers.ts:624` — bracket-notation private field access~~ → already removed in earlier refactor; no bracket-notation access remains in [chatHandlers.ts](src/webview/handlers/chatHandlers.ts)
- ~~Duplicated `isReachable`/`ensureReachable` with divergent provider coverage~~ → both wrappers deleted; call sites call `isProviderReachable(state.client.getProviderType())` directly ([chatHandlers.ts:808](src/webview/handlers/chatHandlers.ts#L808), [modelHandlers.ts:12](src/webview/handlers/modelHandlers.ts#L12))
- ~~`deleteRelease()` bypasses shared `request()` helper~~ → already routed through `this.request<void>` at [api.ts:236](src/github/api.ts#L236) with shared 204-No-Content handling at [api.ts:47-49](src/github/api.ts#L47-L49)
- ~~`api.ts` responses typed as `Record<string, unknown>` with manual casting~~ → typed raw response interfaces (`RawPR`, `RawIssue`, `RawRelease`, `RawRepoContent`) in [github/types.ts](src/github/types.ts); parsing centralized in `parsePR` / `parseIssue` / `parseRelease` — no per-field `as number` / `as string` casts
- ~~Stringly-typed GitHub actions — define `GitHubAction` union type~~ → [`GitHubAction`](src/github/types.ts) union with 16 members; `action?` and `githubAction?` fields in [chatWebview.ts:74](src/webview/chatWebview.ts#L74), [:174](src/webview/chatWebview.ts#L174) now use it
- ~~Magic number `0.7` for input/output ratio duplicated~~ → `INPUT_TOKEN_RATIO` (billing split) kept; dedicated `CONTEXT_COMPRESSION_THRESHOLD` constant added at [constants.ts:20](src/config/constants.ts#L20) and wired into [loop.ts:178](src/agent/loop.ts#L178), [:577](src/agent/loop.ts#L577)
- ~~Double workspace state deserialization in budget check~~ → replaced with single-pass `getSpendBreakdown()` at [chatHandlers.ts:839](src/webview/handlers/chatHandlers.ts#L839)
- ~~`chat.js` — 800+ lines with `@ts-nocheck`, unminified, no code splitting~~ → removed misleading `@ts-nocheck` (nothing typechecks `media/` per tsconfig scope anyway); extracted GitHub card rendering to [media/chat/githubCards.js](media/chat/githubCards.js) as a `window.SideCar.githubCards` namespace — chat.js is now 210 lines smaller and gains a pattern for further extractions. Full modularization deferred — follow the same pattern for each subsystem as they grow or need types
- ~~5.2MB mermaid.min.js — consider lighter alternative or web worker~~ → runtime loading was already lazy (script element injected on first diagram render, not at page load). Added `sidecar.enableMermaid` setting (default on); when disabled, chatWebview doesn't inject the mermaid URI and chat.js falls through to plain code-block rendering — users who never ask for diagrams can skip the load entirely. No lighter drop-in alternative exists for mermaid's feature set; CDN-fetch-and-cache deferred (requires CSP widening + offline-fallback design)

---

### Audit Backlog (cycle 2, 2026-04-13)

Fresh comprehensive pass over the post-v0.46.0 codebase. Four parallel
reviewers: Security, Architecture, AI Engineering + Prompt, UX + Code
Quality. Findings below are new issues the cycle-1 sweep didn't catch
or that appeared as the codebase grew. Already cross-validated — false
positives from the automated pass have been dropped.

### Security

- ~~**HIGH** `run_tests` tool shell injection via the `file` parameter~~ → **already fixed** at [tools.ts:587-600](src/agent/tools.ts#L587-L600). `runTests` validates the path via `validateFilePath`, rejects any value containing shell metacharacters via `hasShellMetachar`, and single-quotes the final interpolation via `shellQuote`. Three layers of defense: path validation, metachar blocklist, shell-escape. (audit: cycle-2 security)
- ~~**MEDIUM** Skill description gets `innerHTML`-injected into the attach menu~~ → **fixed 2026-04-14**. Attach menu in [chat.js:388-410](media/chat.js#L388-L410) now builds nodes with `createElement` + `textContent` so skill frontmatter (user-authored, potentially hostile in cloned repos) can't inject markup or DOM-clobber event handlers.
- ~~**MEDIUM** MCP HTTP/SSE header `${VAR}` expansion pulls from unfiltered `process.env`~~ → **already fixed** (stale audit entry). `resolveEnvVars` in [mcpManager.ts:246-253](src/agent/mcpManager.ts#L246-L253) has been scoped to the per-server `env` block since cycle-1; `envMap` is built from `env || {}` only, never `process.env`. Docs at [mcpManager.ts:230-245](src/agent/mcpManager.ts#L230-L245) explain the key-exfil path and why this scoping closes it.
- **MEDIUM** MCP stdio command spawn is warned-on but not blocked by workspace trust — [mcpManager.ts:182-187](src/agent/mcpManager.ts#L182-L187). Cycle 1 added the warning; cycle 2 should escalate untrusted workspaces to a block with an explicit opt-in, since the existing warning is ignorable.
- ~~**MEDIUM** Persistent shell session output is not ANSI-stripped before being returned to the agent or logged~~ → **fixed 2026-04-14**. The audit was half-stale (final stdout has been stripped since cycle-1) and half-real (streaming `onOutput` chunks were still raw, flowing into the webview's `textContent +=` as garbage `^[[31m` sequences). [`executeInternal`](src/terminal/shellSession.ts) now wraps the caller's `onOutput` callback in a `stripAnsi` decorator at the source, so every consumer of streamed shell output gets clean text without threading `stripAnsi` through every call site.
- **MEDIUM** Head+tail truncation of large shell output silently drops the middle — [shellSession.ts:199-208](src/terminal/shellSession.ts#L199-L208). The real error line is often exactly in the dropped window. Fix: prefer the tail over the head for error-indicative runs (non-zero exit), or keep a small sliding window of the last few lines regardless of head capture.
- ~~**LOW** `list_directory` tool accepts a raw `path` without passing it through `validateFilePath`~~ → **fixed** in the cycle-2 security pass. [`listDirectory` in tools/fs.ts](src/agent/tools/fs.ts) now runs `validateFilePath` on any non-empty, non-`.` path before touching `workspace.fs.readDirectory`.

### Architecture

- ~~**HIGH** Module-level `sidecarMdCache` and `sidecarMdWatcher` in chatHandlers.ts~~ → **fixed** in commit `fab3a50`. Both cache and watcher hoisted onto `ChatState` as private fields, `loadSidecarMd` is now a method on the state. Watcher lifetime is tied to the state instance so webview toggles tear it down cleanly. The free-function `disposeSidecarMdWatcher` export is kept as a no-op shim for backward compat with the existing extension.ts deactivate import.
- ~~**HIGH** `ChatState` has no `dispose()` method~~ → **fixed** in commit `fab3a50`. `ChatState.dispose()` is idempotent and tears down the abort controller, pending confirmations, the owned `PendingEditStore`, and the SIDECAR.md watcher. `ChatViewProvider.dispose()` cascades through to it. Deliberately does NOT dispose workspaceIndex / sidecarDir / skillLoader / agentMemory / auditLog — those are owned by the extension host and have longer lifetimes than any single ChatState. 4 regression tests cover the idempotent-double-dispose, abort-in-flight, PendingEditStore teardown, and loadSidecarMd short-circuit-after-dispose cases.
- **MEDIUM** `chatHandlers.ts` is still 1708 lines after the v0.46.0 `handleUserMessage` decomposition — the file now bundles message preparation, budget gating, prompt assembly, cost tracking, and 14 other exported handlers. Split into `chatHandlers/` directory with one file per subsystem (`systemPrompt.ts`, `budget.ts`, `messagePrep.ts`, etc.).
- ~~**MEDIUM** `BackgroundAgentManager` runs parallel agents that all share the *same* persistent `defaultRuntime.shellSession`~~ → **fixed in commit `e32ab49`** (per-run ToolRuntime for background agents). [backgroundAgent.ts:152](src/agent/backgroundAgent.ts#L152) now constructs a fresh `ToolRuntime` per run; each background agent gets its own `shellSession` so parallel `cd` / `export` calls don't trample each other.
- ~~**MEDIUM** Two sites still call `workspace.getConfiguration('sidecar')` directly instead of routing through `getConfig()`~~ → **already fixed** (stale audit entry). The three remaining `getConfiguration('sidecar')` calls in [chatView.ts](src/webview/chatView.ts) are all `.update(...)` *writes*, which can't route through `getConfig()` (which returns a cached read). Reads all use `getConfig()` now.
- **LOW** Several untyped-cast reads of `content as string` / `input.path as string` in chatHandlers.ts — harmless today but brittle if `ContentBlock` grows.
- **LOW** Review mode has only `reviewPanel.test.ts`; no integration test exercising the executor's read-through / write-capture path through an actual tool call.
- ~~**LOW** Several helpers are exported from chatHandlers.ts for no reason (`keywordOverlap`, `isContinuationRequest`, `classifyError`)~~ → **partially fixed 2026-04-14**. The audit's claim was wrong for two of the three: `classifyError` and `keywordOverlap` have their own external test coverage in [chatHandlers.test.ts](src/webview/handlers/chatHandlers.test.ts), so they legitimately need to be exported. `isContinuationRequest` had no external consumer and is now file-local.

### AI Engineering

- ~~**CRITICAL** Image content blocks are weighted at a flat 100 chars in `getContentLength()`~~ → **already fixed** at [types.ts:130-139](src/ollama/types.ts#L130-L139). Image blocks are now counted as `Math.ceil((data.length * 3) / 4)` — base64 decoded byte count minus the ~33% overhead. Regression test at [types.test.ts:61-74](src/ollama/types.test.ts#L61). (audit: cycle-2 AI engineering, skill-driven re-run)
- ~~**HIGH** Review mode intercepts file I/O tools but not `grep` / `search_files` / `list_directory`~~ → **fixed** in commit `6baef11`. New `computePendingOverlay` helper runs AFTER the normal executor path in review mode, appending a `⚠ Pending edits (review mode)` section to the tool output that lists matches from the shadow store. For grep: re-runs the pattern against pending file contents. For search_files: tests the glob against pending file paths, tagging results as "(pending new file)" or "(pending edit)". For list_directory: adds pending files that are direct children of the requested dir. 8 regression tests.
- ~~**HIGH** MCP tool result content is not counted toward `totalChars`~~ → **already correct** (stale audit entry). MCP tools use the same `executor` interface as native tools, return strings through `wrapToolOutput`, land as `ToolResultContentBlock`s, and `getContentLength(toolResults)` at [loop.ts:623](src/agent/loop.ts#L623) counts them identically via the `tool_result` branch in [types.ts:128](src/ollama/types.ts#L128).
- ~~**HIGH** Heavy-compression drops thinking blocks without dropping any paired `tool_use` in the same message~~ → **fixed** in commit `291ba02`. `compressMessage` detects the atomic thinking→tool_use chain and downgrades the thinking-block compression level for that message from `heavy` to `medium` (truncate instead of drop). Other block types in the same message still get the full level — the bulk of the savings comes from `tool_result` bodies, not thinking. Standalone thinking (no paired tool_use) still drops at heavy level. 3 regression tests.
- ~~**MEDIUM** `estimateCost()` silently returns `null` for any model not in `MODEL_COSTS`~~ → **fixed 2026-04-14 in v0.51.0**. Module-level `Set<string>` dedups, one-time `console.warn` on first unknown-model hit, pricing table moved to [`src/config/modelCosts.json`](src/config/modelCosts.json) and expanded to cover the OpenAI 4o/4.1/5/o1 lineup + older Claude 3.x models.
- ~~**MEDIUM** Anthropic prompt cache boundary isn't guaranteed to align with a stable prefix~~ → **fixed 2026-04-14 in v0.52.0**. Three regression tests in [chatHandlers.test.ts](src/webview/handlers/chatHandlers.test.ts): byte-stability for identical inputs, Session block must live after `## Workspace Structure`, and the cached prefix must not contain ISO timestamps / epoch ms / hex-id-looking strings. Catches the classic "I added `new Date().toISOString()` to a context section" regression before it hits prod.
- ~~**MEDIUM** `ConversationSummarizer` keeps "last N turns" with no per-turn size cap~~ → **fixed 2026-04-14 in v0.51.0**. New `maxCharsPerTurn` option (default 220) bounds each turn's contribution to the pre-LLM facts list. With the default, a typical 10-turn window fits inside `maxSummaryLength` directly and the LLM compression round-trip is skipped entirely. Assembled `Turn N: query → reply` line is hard-capped after smart-truncation of each half.
- **MEDIUM** `onToolOutput` is fire-and-forget with no backpressure — [loop.ts:503](src/agent/loop.ts#L503). A slow webview render queues chunks in memory unbounded. Fix: make it `async` and await it, or bound the queue and drop-oldest.
- **LOW** Stub validator misses TS/JS empty-body async stubs (`async function foo() {}`) — [stubValidator.ts](src/agent/stubValidator.ts). Patterns are Python-pass-focused.
- **LOW** Plan-mode complexity-marker list is an arbitrary hand-curated set — easily misses common architectural phrasing ("how should we architect", "propose a design"). Consider replacing with a length-weighted heuristic.
- **LOW** `retry.ts` sleep has a microsecond abort race: if `signal.abort` fires after `setTimeout` resolves but before the caller awaits, the abort is silently swallowed. Theoretical — fix is a `signal.aborted` check after resume.
- **LOW** `OllamaBackend` emits `stopReason: 'tool_use'` based on `hadToolCalls` but the done_reason check order is cosmetically wrong — [ollamaBackend.ts:380-388](src/ollama/ollamaBackend.ts#L380-L388). No-op bug.

### UX / Code Quality

- ~~**MEDIUM** Settings menu doesn't return focus to the gear button when it closes~~ → **fixed 2026-04-14**. [`closeSettingsMenu`](media/chat.js) now calls `settingsBtn.focus()` after hiding the menu so keyboard and screen-reader users don't lose their place on Escape or click-outside dismissal.
- **MEDIUM** Profile buttons are rebuilt on every menu open with fresh click closures — [chat.js:610-633](media/chat.js#L610-L633). Harmless today, but if the profile list ever gets refreshed from the extension mid-session, the stale closures keep pointing at old IDs. Move to event delegation.
- **LOW** Settings menu and model panel lack `max-height` on narrow viewports — [chat.css:166-171](media/chat.css#L166-L171) — menus can overflow below the chat input on side-panel layouts narrower than ~300px.
- **LOW** Settings menu "Backend" label doesn't tell the user it's a control group — [chatWebview.ts:280](src/webview/chatWebview.ts#L280). Screen reader reads "Backend" with no instruction. Add `aria-labelledby` on the section and make the label element `<div role="group">`.
- ~~**LOW** Profile buttons set no `aria-current="true"` on the active one~~ → **fixed 2026-04-14**. [`renderBackendProfiles`](media/chat.js) now sets `aria-current="true"` on the active profile button alongside the visible checkmark, so assistive tech announces it.
- ~~**LOW** `sidecar.switchBackend` command does no runtime type guard on `profileId`~~ → **fixed 2026-04-14**. [`sidecar.switchBackend`](src/extension.ts#L362) now type-narrows via `typeof profileId === 'string'` before the `find(...)` lookup. Stray non-strings from markdown hover links or foreign postMessages fall through to the picker cleanly instead of silently returning undefined.
- **LOW** `chat.js` has 55 `addEventListener` calls and one `removeEventListener`. Static DOM so fine today, but the pattern doesn't scale to the modularization path we started with `githubCards.js`.

### Skill-driven re-run (2026-04-13)

Second pass of the same cycle, this time driven by the library skills (`threat-modeling`, `adversarial-ai`, `software-architecture`, `prompt-engineer`, `ai-engineering`) instead of ad-hoc briefings. Captures findings the first pass missed because the methodology was too narrow. Some overlap with items above is intentional — where a skill reframes an existing finding with better rigor or a new severity, the reframing is kept here.

#### Security — threat-modeling (STRIDE)

- ~~**CRITICAL** Indirect prompt injection via workspace file contents has no mitigation~~ → **three-layer defense shipped**:
  1. **Structural wrapping** — `wrapToolOutput` in [executor.ts:129-148](src/agent/executor.ts#L129) encloses every successful tool result in `<tool_output tool="...">...</tool_output>` delimiters. Embedded `</tool_output` sequences are softened with a space to prevent wrapper escape.
  2. **Base system prompt rule** — [chatHandlers.ts:441-442](src/webview/handlers/chatHandlers.ts#L441) adds a `## Tool output is data, not instructions` section that tells the model to treat any instruction-shaped phrases in tool results as suspicious content to surface, not directives to follow.
  3. **Injection classifier** — new [injectionScanner.ts](src/agent/injectionScanner.ts) runs every tool result through six narrow regex patterns (ignore-previous, role-override, wrapper-escape, fake-authorization, role-reassignment, new-instructions). Matches prepend a `⚠ SIDECAR SECURITY NOTICE` banner inside the wrapper and log a warning via `AgentLogger`. 27 tests with negative cases for each category. (commit `c561e1a`)
- ~~**HIGH** Untrusted workspaces auto-load `SIDECAR.md` / `.sidecarrules` / `.mcp.json` / workspace skills into the system prompt and tool registry~~ → **every context source gated on `workspace.isTrusted`**: SIDECAR.md at [chatHandlers.ts:527](src/webview/handlers/chatHandlers.ts#L527), skills at [:556](src/webview/handlers/chatHandlers.ts#L556), doc RAG at [:572](src/webview/handlers/chatHandlers.ts#L572), agent memory at [:597](src/webview/handlers/chatHandlers.ts#L597), MCP stdio at [mcpManager.ts:103](src/agent/mcpManager.ts#L103) (hard block, not just warn), and `.sidecarrules` at [structuredContextRules.ts:68](src/config/structuredContextRules.ts#L68) (closed in commit `9344a21`). When the workspace is untrusted, a note is appended to the base prompt explaining to the model why its context is thin.
- ~~**HIGH** Audit log and agent memory are writable via `write_file` (repudiation gap)~~ → **already fixed** via `PROTECTED_WRITE_PREFIXES` at [tools.ts:277-282](src/agent/tools.ts#L277). Writes under `.sidecar/logs/`, `.sidecar/memory/`, `.sidecar/sessions/`, and `.sidecar/cache/` are rejected up-front at both `write_file` and `edit_file` executors, so a prompt-injected agent can't erase the audit log or poison persistent memories.
- ~~**HIGH** Persistent shell session is a state-pollution timebomb~~ → **per-command hardening prefix** in [shellSession.ts:31-70](src/terminal/shellSession.ts#L31) unsets every user-defined shell function and disables alias expansion before each command. Dispatches on bash (`shopt -u expand_aliases` + `compgen -A function` loop with `\builtin` prefixes) vs zsh (`unalias -m '*'` + `unfunction -m '*'`). Preserves cwd and env vars on purpose. Two regression tests cover the canonical `poisoned(){ ... }` attack and the "legitimate env vars still persist" case. (commit `a61f848`)
- ~~**HIGH** No per-iteration tool-call rate limit~~ → **already fixed** at [loop.ts:158](src/agent/loop.ts#L158) — `MAX_TOOL_CALLS_PER_ITERATION = 12` constant with an explicit bail at [loop.ts:439-446](src/agent/loop.ts#L439) that surfaces a clear error telling the user to narrow the task.
- **MEDIUM** Context-window exfiltration via tool inputs. The model can encode user secrets into `web_search` queries or `run_command` arguments that reach outbound endpoints. No outbound host allowlist beyond the CSP (which only governs the webview, not Node-side fetches).
- **MEDIUM** Workspace-local skills in `.sidecar/skills/` load without provenance warning. A cloned repo can ship a skill named `/review-code` that actually does something else — skills merge into the same namespace as user skills.
- **MEDIUM** Event hooks run with workspace-supplied args and their stdout/stderr are not audit-logged. [eventHooks.ts](src/agent/eventHooks.ts) — cycle 1 added env sanitization but hook output is not persisted.
- **MEDIUM** No confirmation escalation for irrecoverable operations. Cautious-mode single-click covers `git push --force`, `delete_file`, `branch -D`, `rm -rf` via `run_command`. Consider a "type DELETE to confirm" pattern for irrecoverable ops.

#### LLM surface — adversarial-ai (OWASP LLM Top 10 + MITRE ATLAS)

- ~~**HIGH** Indirect prompt injection via `web_search` results (LLM01)~~ → **already mitigated** (stale audit entry). `web_search` is a regular tool; its output flows through [`wrapToolOutput`](src/agent/executor.ts#L136) in the executor, which runs the full 6-pattern `scanToolOutput` classifier and wraps the content in `<tool_output>` delimiters before it reaches the model. There's no special-case code path that bypasses this.
- ~~**HIGH** Indirect prompt injection via captured terminal error output (LLM01)~~ → **fixed 2026-04-14**. `diagnoseTerminalError` was synthesizing a user message containing raw stderr inside a markdown code block, bypassing the executor's scanner entirely. New [`wrapUntrustedTerminalOutput`](src/agent/injectionScanner.ts) helper runs the same 6-pattern scan on captured output and wraps it in a `<terminal_output source="stderr" trust="untrusted">` envelope, with a SIDECAR SECURITY NOTICE banner prepended when patterns are detected. 5 new regression tests pin the benign-passthrough, hostile-banner, and banner-before-envelope cases.
- ~~**HIGH** Indirect prompt injection via version-control metadata (LLM01)~~ → **already mitigated** (stale audit entry). Same reason as web_search — `git_log`, `list_prs`, `get_pr`, `get_issue` are all tools that return strings through the normal executor path. Their output is `wrapToolOutput`-wrapped and `scanToolOutput`-classified before it reaches the model.
- ~~**HIGH** Excessive agency in cascade tool sequences (LLM06)~~ → **two outbound exfiltration defenses shipped** (commit `d276b8d`):
  1. **`web_search` query credential scan** — [webSearch.ts:30-80](src/agent/webSearch.ts#L30). `searchWeb()` refuses to send queries containing credential-shaped substrings (AWS access keys, GitHub / Anthropic / OpenAI API keys, Slack tokens, JWTs, private-key headers) via a new `SearchQueryBlockedError`. Prevents the canonical cascade attack `read_file .env → base64 → web_search("sk-ant-xxx look this up")` from leaking the secret into DuckDuckGo query-string logs. Heuristic is deliberately narrow — legitimate queries like "how do OAuth tokens work" pass through unharmed.
  2. **Outbound host allowlist for URL fetching** — new `sidecar.outboundAllowlist` setting (array, empty default = allow all public URLs). When non-empty, [workspace.ts:258-290](src/config/workspace.ts#L258) only fetches URLs whose hostname matches one of the configured patterns. Supports exact hostnames and `*.pattern` wildcards for subdomains. Stacks with the existing SSRF / private-IP block.
  - **Known gap (deferred):** `run_command curl/wget/fetch` calls bypass both defenses because we can't reliably parse shell commands. Mitigated by the v0.47.0 native modal approval for `run_command` — the user sees every command string before it runs. A full per-turn sensitivity-taint system remains future work.
- **MEDIUM** RAG poisoning via workspace documentation (LLM03/LLM08). The doc indexer scores and retrieves from workspace `README*` / `docs/**` / `wiki/**` with no retrieval-time sanitization. Malicious docs become prompt-injection payloads.
- **MEDIUM** Agent memory as a persistence channel (LLM08). `.sidecar/memory/agent-memories.json` is read at session start and written during a session with no signing or provenance — a prompt-injected agent in session N can leave poisoned memories that influence session N+1 ("user prefers `--force`", "user already approved `rm -rf`"). Consider session-scoped signing, or surface a "new memories from this session" diff at session start.
- **MEDIUM** No adversarial / red-team evaluation suite. 1505 unit tests focus on code correctness, zero on jailbreak resistance or tool-use abuse. Add a `tests/red-team/` corpus with known injection patterns + cross-prompt leaking cases + tool-use coercion attempts, run against each configured model in CI.
- **MEDIUM** No outbound host allowlist for `web_search` / `fetch_url` / `run_command curl`. Cycle 1 added SSRF protection (private-IP blocklist), but the broader exfiltration surface is unaddressed.
- **LOW** No supply-chain provenance for user-installed Ollama models (HuggingFace pulls). Users install custom models with no hash verification.

#### Architecture — software-architecture (bounded contexts, coupling, DDD)

- ~~**HIGH** `src/agent/tools.ts` is a god module~~ → **fixed 2026-04-14**. Split into [`src/agent/tools/`](src/agent/tools/) with one file per subsystem (`fs`, `search`, `shell`, `diagnostics`, `git`, `knowledge`) plus `shared.ts` and `runtime.ts`. `tools.ts` is now a 249-line orchestrator composing `TOOL_REGISTRY` and re-exporting types for backward compat. Same pattern as the `handleUserMessage` decomposition. 1694 tests still pass.
- ~~**HIGH** No anticorruption layer between backend clients and the agent loop~~ → **fixed 2026-04-15 in v0.53.0**. New [`src/ollama/openAiSseStream.ts`](src/ollama/openAiSseStream.ts) factors the OpenAI-compatible SSE parsing (framing, tool_call reconstruction, think-tag handling, text tool-call interception, usage event emission, finish_reason → StreamEvent.stop mapping) out of OpenAIBackend into a reusable helper. Every OpenAI-compatible backend delegates stream parsing to one place — OpenAIBackend shrinks 501 → 323 lines, Kickstand 318 → 248 lines. Unblocked OpenRouter as the first real proof-of-concept integration to use the new layer; future LM Studio / vLLM / Groq / Fireworks integrations will ship as tiny subclass wrappers.
- ~~**HIGH** `runAgentLoop` is the next god-function decomposition target~~ → **completed in v0.50.0**. 1216-line god function split into a 255-line orchestrator plus 14 focused helper modules under [`src/agent/loop/`](src/agent/loop/) across 9 commits (phases 1 → 2 → 3a-e → 4). Each helper owns one clear responsibility and takes a single `LoopState` parameter. Re-exports preserved for test compatibility. Every phase verified end-to-end against the LLM eval harness (the other half of this session's work). 79% reduction in loop.ts. **Deferred to a follow-up**: policy-hook interface (`beforeIteration` / `afterToolResult` / `onTermination` registration bus) — current decomposition gets file-level separation but policies are still called directly from the orchestrator rather than registered through a hook bus.
- ~~**HIGH** Agent policies are tangled into loop mechanics~~ → **fixed 2026-04-15 in v0.54.0**. New `PolicyHook` interface + `HookBus` in [src/agent/loop/policyHook.ts](src/agent/loop/policyHook.ts). The four post-turn policies (auto-fix, stub validator, critic, completion gate) live behind the registration bus instead of being called directly from the orchestrator. `AgentOptions.extraPolicyHooks` lets callers register additional hooks after the built-ins. **This was the last cycle-2 HIGH architectural audit item — the cycle-2 architectural audit is now fully closed.**
- **MEDIUM** `SideCarConfig` is a fat shared kernel (DDD anti-pattern). One giant config interface imported by every module; any field change fans out the rebuild everywhere. Split into scoped slices (`BackendConfig`, `ChatUIConfig`, `ToolConfig`, `ObservabilityConfig`, `BudgetConfig`).
- **MEDIUM** `ChatState` is a god object. Handlers take `state: ChatState` and pull whatever they need, so real dependencies are invisible. Extract role interfaces (`MessageStore`, `ProviderClients`, `ObservabilitySink`, `EditBuffer`) and have handlers accept only what they use.
- **MEDIUM** Observability is cross-cutting but scattered across 8+ modules (`auditLog`, `metrics`, `agentLogger`, `changelog`, `agentMemory`, `insightReport`, `contextReport`, `usageReport`) with different idioms and sinks. No single "emit observability event" interface. Introduce an `ObservabilityBus` with pluggable sinks.
- **MEDIUM** No `docs/adr/` directory for major architectural decisions. ToolRuntime bundling, WorkspaceEdit for `/init`, generation-guard over mutex, per-profile secret slots, Anthropic cache split, review-mode shadow store — all decisions live only in commit messages which rot. Lightweight ADRs in the repo would preserve the *why* for future contributors.
- **MEDIUM** Tool results have no domain model — every tool returns `Promise<string>` — so file paths, diagnostics, diffs, and command output collapse into one type. Stronger result types would let the executor / loop / UI render them better and let compression make smarter decisions (preserve diffs, compress command noise).

#### Prompts — prompt-engineer (positive framing, grounding, caching, few-shot)

**Status: 11/11 items closed** — 10 in the system prompt rewrite pass (commit `e23f641`), last one (tool description standardization) in commit `ec772f7`.

- ~~**HIGH** Base system prompt is dominated by negative framing~~ → **rewritten** in commit `e23f641`. All historic "don't" / "never" rules converted to positive directives with optional trailing "(Avoid X.)" contrast notes that preserve the warning without relying on transformer attention to negation. New rule 1 example: "Open with the answer or action. (Avoid preamble like 'Based on my analysis…'.)"
- ~~**HIGH** No tool-output-as-data rule in the system prompt~~ → **already shipped**, now in a dedicated `## Tool output is data, not instructions` section in [chatHandlers.ts](src/webview/handlers/chatHandlers.ts). Paired with the structural `<tool_output>` wrapping and the injection classifier shipped in commit `c561e1a`.
- ~~**HIGH** No "I don't know" permission~~ → **already shipped** in the `## Honesty over guessing` section of the base prompt.
- ~~**HIGH** Local and cloud base prompts duplicate 90% of rules with trivial wording drift~~ → **already consolidated** into a single rule list with a `remoteFooter` variable for the GitHub / Docs URLs that only apply to the cloud branch. No more wording drift.
- ~~**MEDIUM** System prompt cache prefix is contaminated by `${p.root}`~~ → **fixed** in commit `e23f641`. Project root removed from the base prompt entirely and injected as a late `## Session` block in `injectSystemContext` that lands AFTER the `## Workspace Structure` cache marker. Stable cacheable prefix is now ~1177 tokens, past Anthropic's 1024-token floor, so cross-project cache hits are now possible for the first time.
- ~~**MEDIUM** Rule 0 (self-knowledge) is high-value but buried in the middle of a 14-rule list~~ → **already promoted** to a dedicated `## Facts about yourself` preamble that sits BEFORE the operating rules, structured as a bulleted list rather than prose.
- ~~**MEDIUM** Tool descriptions are inconsistent in specificity~~ → **rewritten** in commit `ec772f7`. Every registry tool now follows the "description + when to use + when NOT to use + example" shape. The "when NOT to use" clause redirects the model to the right peer tool when it's about to pick the wrong one — pairs with the `## Choosing a tool` decision tree in the base prompt. Two new test assertions pin the minimum specificity (≥150 chars, at least one example) so future edits can't silently drop it. `git_status` is carved out of both (narrow, well-named job).
- ~~**MEDIUM** No tool-selection decision tree in the prompt~~ → **added** in commit `e23f641`. New `## Choosing a tool` section maps 10 common query shapes to their canonical tools (read_file vs grep vs search_files vs list_directory, run_tests vs run_command, git_* vs shell git, etc.). Doubles as cache-padding for the ~1024-token floor.
- ~~**MEDIUM** Plan-mode output format is prose-described, not shown~~ → **fixed** in commit `e23f641`. Plan mode now includes a filled-in example (GitHub OAuth callback handler) with concrete file paths and steps the model can pattern-match.
- ~~**LOW** Conflict between rule 3 (concise prose) and rules 5-7 (tool call workflows)~~ → **already fixed** — rule 3 explicitly says "Tool-call sequences can be as long as the task requires — conciseness applies to prose, not to tool chains."
- ~~**LOW** No counterbalance to rule 11 ("use `ask_user` if ambiguous")~~ → **already fixed** — rule 9 now pairs the ask_user guidance with "For clearly-stated requests, proceed directly — don't ask permission for every small action."

#### AI engineering — ai-engineering (production LLM app patterns)

- ~~**HIGH** No rate-limit awareness; `fetchWithRetry` reacts to 429s but doesn't pre-check~~ → **already fixed** (stale audit entry). Every backend's `streamChat` and `complete` path now awaits [`maybeWaitForRateLimit`](src/ollama/rateLimitState.ts) before issuing the request, using `estimateRequestTokens(systemPrompt, messages, MAX_OUTPUT_TOKENS)` to pre-check against the `RateLimitStore` snapshot populated from provider headers. Added in v0.47.0, tightened in v0.48.0 post-bump work (per-provider store isolation + `max_tokens` reservation fix + `describe()` used/limit display).
- ~~**HIGH** No evaluation harness for LLM behavior~~ → **completed in v0.50.0**. Built in two passes: first the prompt-only layer ([`prompt.eval.ts`](tests/llm-eval/prompt.eval.ts) + 4 base-prompt regression cases), then the agent-loop layer ([`agent.eval.ts`](tests/llm-eval/agent.eval.ts) + [`workspaceSandbox.ts`](tests/llm-eval/workspaceSandbox.ts) + 11 trajectory-asserted cases). The agent-loop layer runs `runAgentLoop` end-to-end against a sandboxed temp-dir workspace with real-fs-backed `workspace.fs` and a minimatch-style `workspace.findFiles` mock, captures every tool call / tool result / text event via AgentCallbacks, and scores via deterministic predicates (tool presence / absence, partial-input matching, post-run file content, final text substrings, `trajectoryHasToolError`). Runs via `npm run eval:llm` against local Ollama by default (free) or Anthropic / OpenAI via `SIDECAR_EVAL_BACKEND` env var. 11 cases pass in ~90s. **LLM-as-judge scoring deferred to a later iteration** — deterministic checks give crisper regression signal and don't need a second model hop.
- ~~**HIGH** Doc "RAG" isn't actually RAG~~ → **renamed** in commit `f503627`. The class and setting keys are kept for backward compatibility (renaming the keys would break existing user configs), but every user-facing surface now calls it the "Doc Index" and explicitly says it's keyword-tokenized, not embedding-based. `documentationIndexer.ts` class-level comment explicitly says "NOT RAG" and points at `embeddingIndex.ts` for the real semantic retriever. README section renamed from "Retrieval-Augmented Generation (RAG)" to "Documentation Index". `docs/rag-and-memory.md` restructured to name the three retrieval systems (Doc Index, Semantic Search, Agent Memory) and flag the legacy "RAG" naming as a misnomer. A future cycle will add the retriever-fusion layer (separate HIGH item below).
- ~~**HIGH** Semantic search, doc index, and agent memory are parallel retrievers concatenated sequentially with no fusion~~ → **fully fixed 2026-04-14 across v0.51.0 + v0.52.0**. v0.51 shipped the `Retriever` interface, reciprocal-rank fusion, and adapters for documentation index + agent memory in [`src/agent/retrieval/`](src/agent/retrieval/). v0.52 added the third adapter by splitting `WorkspaceIndex.getRelevantContext()` into reusable `rankFiles` / `loadFileContent` / render-helper phases, letting [`semanticRetriever.ts`](src/agent/retrieval/semanticRetriever.ts) emit truncated file snippets that compete against doc + memory hits under a single fused budget.
- **MEDIUM** No reranker stage. After retrieval, context goes straight into the system prompt. A cheap cross-encoder reranker dramatically improves precision per context-budget token. Matters most for paid API users.
- **MEDIUM** Anthropic Batch API is unused for non-interactive workloads (half the cost). Candidates: `/insight`, `/usage`, `/audit` aggregation, semantic-index embedding jobs, background sub-agents, adversarial critic.
- ~~**MEDIUM** No client-side semantic cache for repeat queries~~ → **fixed 2026-04-14 in v0.51.0** for `/usage` and `/insights`. New [`src/webview/handlers/reportCache.ts`](src/webview/handlers/reportCache.ts) with `getOrComputeReport(key, fingerprint, compute, ttlMs)` keyed on a caller-supplied fingerprint plus a 5-minute TTL. `handleUsage` fingerprints on history length + last metric timestamp; `handleInsights` fingerprints on audit + metrics + memory counts + last audit timestamp. Either a fingerprint change OR age beyond the TTL triggers a recompute. `/insights` stops re-walking 5000 audit rows on every invocation.
- ~~**MEDIUM** No graceful degradation for stream failures~~ → **fixed 2026-04-14 in v0.52.0**. New `onStreamFailure(partial, error)` callback on `AgentCallbacks`. `streamOneTurn` captures whatever text was accumulated before a non-abort throw and fires the callback before re-throwing; `chatHandlers` stashes the partial on `ChatState.pendingPartialAssistant`. A new `/resume` slash command re-dispatches the last turn with a continuation hint built from the partial. Any normal `handleUserMessage` call discards a stale partial at the top so old partials never replay. Listener errors are swallowed so they can't mask the original backend error.
- ~~**MEDIUM** `MODEL_COSTS` table is hardcoded and manual-update~~ → **fixed 2026-04-14 in v0.51.0**. Moved to [`src/config/modelCosts.json`](src/config/modelCosts.json) (loaded via `resolveJsonModule`) and expanded to cover the common OpenAI lineup (4o, 4o-mini, 4.1, 4.1-mini, 5, 5-mini, o1, o1-mini) plus older Claude 3.x models. Still manually maintained — provider `usage` integration deferred.
- ~~**MEDIUM** No circuit breaker around failing backends~~ → **fixed 2026-04-14 in v0.52.0**. New [`src/ollama/circuitBreaker.ts`](src/ollama/circuitBreaker.ts): three-state machine (closed → open after 5 consecutive failures → half-open after 60s cooldown → closed on successful probe). Per-provider isolation, exactly-one-probe in half-open, throws `BackendCircuitOpenError` with cooldown remainder. Wired into `SideCarClient.streamChat` and `.complete` so a dead provider fast-fails instead of letting users hang on a hung request.
- **LOW** No explicit token budget split (system/history/context/response). Compression is reactive rather than budget-driven.
- **LOW** No self-consistency mode for high-stakes one-shot operations (`generate_commit_message`, `generate_spec`). Best-of-N with majority vote would improve reliability where it's worth the cost.

---

- [x] **Tree-sitter AST parsing** — 6 languages (TS, TSX, JS, Python, Rust, Go) with CodeAnalyzer interface
- [x] **Built-in web search** — `web_search` tool via DuckDuckGo with offline detection
- [x] **Streaming diff preview** — live diff editor with session-based accept/reject flow
- [x] **Plan mode** — `/plan` command with structured plan output, Execute/Revise/Reject buttons
- [x] **Context compaction button** — `/compact` command and ✂ header button for manual compaction
- [x] **Message copy button** — copies raw markdown (not HTML) to clipboard
- [x] **Attach menu with skills browser** — 📎 button shows file attach + all available skills
- [x] **Skills autocomplete** — loaded skills appear in slash command autocomplete dropdown
- [x] **7 built-in skills** — create-skill, review-code, explain-code, refactor, debug, write-tests, break-this
- [x] **Persistent codebase indexing** — workspace index cached to `.sidecar/cache/` for instant startup
- [x] **`.sidecarignore` support** — custom exclude patterns merged with built-in defaults
- [x] **SSRF protection** — private IP blocklist in URL fetching
- [x] **Anthropic max_tokens** — raised from 4096 to 8192
- [x] **OpenAI tool call ID fix** — monotonic counter prevents collision
- [x] **edit_file docs** — search uniqueness and first-match behavior specified

---

## Legacy Release Notes (pre-v0.38)

Compact release notes for very early versions. Kept for historical reference; the current release-note style is the more detailed format in the Release History section above.

### v0.35.0 (2026-04-09)

- [x] 4 security fixes (readFile path validation, sensitive file blocklist, workspace hook warning, prompt injection sandbox)
- [x] 5 reliability fixes (few-shot tool examples, MCPManager disposal, summary message sequence, sub-agent isolation, concurrent message race)
- [x] 4 accessibility fixes (focus-visible styles, model button semantics, ARIA roles, theme-safe colors)

### v0.34.0 (2026-04-09)

- [x] Spending budgets & cost tracking, token compaction fixes, Kickstand discovery
- [x] HuggingFace model install, GitHub release management, mermaid rendering fix

### v0.30.0–v0.33.0 (2026-04-08–09)

- [x] Context management & tool hardening, Mermaid diagrams, Kickstand backend
- [x] Claude Code skill compatibility, backend fallback, dual-stage context compression

### v0.20.0–v0.28.1

- [x] Auto-fix, cost tracking, web page context, onboarding, multi-file change summary
- [x] Smart context, context pinning, OpenAI-compatible backend, vision support
- [x] Auto-commit, agent debugger, codebase map, multi-model routing, AI code review

### Core (v0.11.0–v0.19.0)

- [x] Agent loop, system prompts, `.sidecar/` directory, error handling, persistent shell
- [x] Context management, UI (slash commands, autocomplete, markdown, activity bar)
- [x] Security scanning, git toolset, inline chat, FIM completions, 848 tests
