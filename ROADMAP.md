# SideCar Roadmap

**Current release: v0.84.0** — Retrieval intelligence (query rewriting, chunk-level prose retrieval), active file context bar, normalized cycle detection, sync I/O elimination, and 12 bug/hardening fixes. See [CHANGELOG](CHANGELOG.md) for full notes.

**Coverage floor**: ≥80/70/80/80 (stmts/branches/funcs/lines) enforced by CI. No PR merges that drop any metric.

---

## Release Plan

### Shipped

| Version | Headline |
|---|---|
| v0.84 | Query rewriting · chunk retrieval · active file bar · normalized cycle detection · sync I/O · 12 fixes |
| v0.83 | NoSQL MCP install · `extension.ts` decomposition · perf fixes · MCP allowlist · WCAG AA |
| v0.82 | NotebookLM research mode · token estimation · image compression · compression anchor · SpendTracker persistence |
| v0.81 | Conversational shortcuts · plan-mode fixes · `sidecar.generateSidecarMd` · backend checkmark fix |
| v0.80 | Security hardening · `db_execute` / `db_migrate_up` · agent run ID · policy hook enforcement |
| v0.79 | Doc-to-Test Synthesis Loop (`extract_constraints` / `synthesize_tests` / `classify_test_failure`) |
| v0.77 | Browser-Agent Live Preview (`screenshot_page` / `analyze_screenshot` / `run_playwright_code`) |
| v0.76 | Database Integration Tier 1 (SQLite · Postgres · MySQL · DuckDB, 4 query tools) |
| v0.75 | Literature Synthesis & PDF/Zotero Bridge |
| v0.74 | `@sidecar/sdk` first-party extension API |
| v0.73 | Auto Mode |
| v0.72 | Adaptive Paste · Next Edit Suggestions · Pinned Memory |
| v0.71 | Live Diagnostic Subscription · Inline Viz Dashboards · Advanced Thinking |
| v0.70 | `@sidecar` Native Chat Participant · Merge Conflict Resolution |

---

### v0.81 — Architecture Integrity + NoSQL MCP ✅ complete

**Sprint Goal**: *Deliver NoSQL database connectivity while dismantling structural CRITICAL issues.*

**Must Have**:
- [x] **NoSQL via MCP feature** — `sidecar.noSql.install` command configures MongoDB (`@mongodb-js/mongodb-mcp-server` via npx) or Redis (`mcp-redis` via uvx); QuickPick + connection-string prompt writes to `sidecar.mcpServers`; docs in `docs/extending-sidecar.md#nosql-databases`.
- [x] **Agent run ID** (T24-CRITICAL) — `crypto.randomUUID()` at loop entry in `initLoopState`; threaded into every `HookContext` and `logToolAudit` call; `logToolAudit` emits structured `{ runId, tool, outcome, timestamp }` JSON. Verified by new `logger.test.ts` case.
- [x] **Policy hook failure halts loop** (T24-CRITICAL) — `HookBus.runPhase` re-throws any hook error as `PolicyEnforcementError`; `loop.ts` catch block emits `⛔ Agent stopped: policy enforcement failure` to `onText` and calls `finalize()` cleanly. Verified by two new `loop.test.ts` cases (halt + onDone fires).
- [x] **`getConfig()` singleton coupling** (T16-CRITICAL) — injection-first fallback (`options.config ?? getConfig()`) at 10+ call sites across `executor.ts`, `hookRunner.ts`, `sandbox.ts`, `localWorker.ts`, `autoMode/dispatcher.ts`, `tools.ts`, `usageReport.ts`, `tools/runtime.ts`, `tools/database.ts`.

**Should Have**:
- [x] **O(p × f) pinned-file scan** (T27-CRITICAL) — `getPinnedFileSet()` builds a `Set<string>` lazily and caches it; invalidated on pin changes + file watcher events.
- [x] **API call audit log** (T17-CRITICAL) — `apiAuditLog.ts` appends `{ runId, model, inputTokens, outputTokens, stopReason, timestamp }` to `.sidecar/logs/api.jsonl` from the `'usage'` event in `streamTurn.ts`. Gated behind `sidecar.verboseLogs` (default `false`).
- [x] **MCP capability allowlist** (T25-CRITICAL) — `toolAllowlist?: string[]` added to `MCPServerConfig`; `mcpManager.ts` filters out tools not on the list before registering them.
- [x] **`extension.ts` decomposition** (T3-HIGH) — 1814 → 135 lines. Logic extracted to 8 focused modules: `src/activation/baseSetup.ts`, `servicesInit.ts`, `mcpSetup.ts`, `warmup.ts`, `workspaceIndexer.ts`, `chatViewSetup.ts`, `editorFeatures.ts`; commands split across `src/commands/{autoMode,settings,agent,prAndReview}Commands.ts` and `src/ui/statusBar.ts`.
- [x] **`FlatVectorStore` O(n²) realloc** (T27-HIGH) — monotonic `vectorCount` + capacity doubling; amortised O(1) upsert.
- [x] **`workspaceIndex.rankFiles` O(q×p×t) loop** (T27-HIGH) — `tokenize` + `new Set` hoisted outside per-file map.
- [x] **`symbolGraph.getSupertypes` full scan** (T27-HIGH) — `childTypesOf` reverse index; O(1) map lookup.

**Could Have**:
- [x] **BFS `Array.shift()` → head-pointer deque** (T27-HIGH)
- [x] **`AgentLogger.logToolResult` redaction** (T17-HIGH)
- [x] **15 identical `catch` blocks** (T3-HIGH) — `formatToolError(err)` in `tools/shared.ts`; 24 occurrences replaced.
- [x] **docs/index.html WCAG AA contrast** (T14-CRITICAL)
- [x] **docs/index.html `@media` queries** (T10-CRITICAL)
- [x] **`prefers-reduced-motion` guard** (T11/T12-CRITICAL)

---

### v0.82 — AI Quality + NotebookLM ✅ complete

**Sprint Goal**: *Fix the AI engine's three fundamental accuracy bugs — token counting, prompt cache placement, and image context growth — then ship NotebookLM research mode.*

**Must Have**:
- [x] **NotebookLM research mode** — `/notebook` mode with mandatory inline citations, multi-source indexing, five study-aid generators.
- [x] **`CHARS_PER_TOKEN = 4` heuristic** (T28-CRITICAL) — consume `usage.input_tokens` / `usage.output_tokens` for post-hoc accuracy; add per-script-type ratio (CJK ~1.5, code ~2.5, English ~4.0).
- [x] **Image `ContentBlock` compression bypass** (T22-CRITICAL) — at `heavy` tier replace image blocks with placeholder; preserve at `light` only.

**Should Have**:
- [x] **Prompt cache boundary** (T28-HIGH) — `cache_control` marker moved to last content block of second-to-last assistant message.
- [x] **System prompt budget fraction** (T28-HIGH) — actual assembled system prompt size + 15% headroom reserved.
- [x] **Embedding model coupling** (T28-HIGH) — `{modelId, dimension}` stored in cache header; auto-invalidate on change.
- [x] **Compression first-turn anchor** (T28-MEDIUM) — `messages[0]` and state-establishing tool results marked compression-immune.
- [x] **`agentMemory` file split per-turn** (T27-MEDIUM) — memoize line-split results by `(filePath, mtime)`.

**Could Have**:
- [x] **Model context window dynamic query** (T28-MEDIUM)
- [x] **`supportsTemperature` regex** (T28-MEDIUM) — inverted to explicit allowlist.
- [x] **`SpendTracker` persistence** (T21-HIGH)
- [x] **`MetricsCollector` 100-run cap** (T21-HIGH) — rolling JSONL log.
- [x] **Ollama eval backend + v0.82 eval cases**
- [x] **`buildBaseSystemPrompt` safety-rules position**

---

### v1.0 — General Availability

**Sprint Goal**: *Reach sustained 80/70/80/80 coverage, decompose the last god module, clear all remaining known CRITICALs, and ship a public skill marketplace.*

**Must Have**:
- [x] **`extension.ts` decomposition** (T3-HIGH) — 135 lines, target ≤150 reached
- [ ] **`chatView.ts` decomposition** (T3) — currently 0% coverage; decomposition unlocks testability
- [ ] **Coverage ≥80/70/80/80 sustained** — final lift via `chatView.ts` + `extension.ts` tests
- [ ] **CLAUDE.md refresh** — sync architectural notes to post-v0.82 reality
- [x] **Unused-export sweep** — removed 3 dead exports (`createPromisifyShim`, `findFixtureSymbol`, `hitsToSearchResults`); all other ts-prune hits confirmed intentional (VS Code lifecycle, SDK public API, dynamic-import targets)
- [x] **Remaining CRITICAL/HIGH audit findings** — triaged 14 items; 12 were already fixed in v0.80–v0.83; 1 SQLite `listTables` identifier bypass fixed (skip rows failing `SAFE_IDENTIFIER`); 1 `agentCallbacks.ts` timer concern confirmed non-issue (flushTimer is scope-local, `onDone` always fires via `finally`)

**Should Have**:
- [ ] **`docs/adr/` directory** (T26-MEDIUM) — lightweight ADR template; 5 retroactive decision records
- [ ] **`deterministicOutput` field on `ToolDefinition`** (T28-LOW) — replace hardcoded `DEDUP_EXEMPT_TOOLS`
- [ ] **Public skill marketplace** — Skill Sync & Registry goes live

**Could Have**:
- [ ] GitHub Issues bidirectional linking to ROADMAP entries
- [ ] Vision Shelf items promoted if scope fits: Semantic Time Travel · Semantic Agentic Search for Monorepos · MCP Marketplace

**Definition of Done**:
- All Must Have items merged and CI green
- Coverage ≥80/70/80/80 on final passing run
- Zero unaddressed CRITICAL audit findings
- Public skill marketplace URL live and discoverable from the extension

---

### Unscheduled / Vision Shelf

Not promised to any specific release. Full specs in [docs/feature-specs.md](docs/feature-specs.md).

Semantic Time Travel · GPU-Native Hot-Swapping · GPU-Aware Load Balancing · Multi-repo cross-talk · Semantic Agentic Search for Monorepos · Selective Regeneration · Persistent Executive Function · LaTeX Agentic Debugging · Inline Edit Enhancement · Zen Mode Context Filtering · Dependency Drift Alerts · Enterprise & Collaboration · Voice Input · MCP Marketplace · Agentic Task Delegation via MCP · Model Comparison / Arena Mode · Real-time Code Profiling · Bitbucket/Atlassian integration

---

## Cross-Cutting Refactor Themes

### Theme 1 — God-module decomposition

| File | Status |
|---|---|
| `tools.ts` | ✅ decomposed v0.47 |
| `loop.ts` | ✅ decomposed v0.50 |
| `chatHandlers.ts` | ✅ decomposed v0.57 |
| `executor.ts` | ✅ decomposed v0.80 |
| `settings.ts` | ✅ domain split done |
| `extension.ts` | ✅ 135 lines (v0.81) |
| `chatView.ts` | 🔜 v1.0 — 0% coverage; decomposition unlocks testability |

### Theme 2 — Test-surface hardening

| Track | Status |
|---|---|
| Host-dependent bugs (kickstand token × 2, `fs.statfsSync`) | ✅ v0.58 |
| CI coverage ratchet 80/70/80/80 | ✅ v0.67, maintained through v0.82 |
| Eval harness: retriever / cost / summarizer fixtures | ✅ v0.62 |
| Eval harness: auto-fix + critic paths | ✅ v0.71 |
| Eval harness: Ollama backend + v0.82 cases | ✅ v0.82 |
| Shared test-helper module (`stubLoopState()`, `stubToolContext()`) | 🔜 v1.0 |
| Subsystem unit tests (scheduler · eventHooks · inlineChatProvider) | 🔜 v1.0 |

### Theme 3 — Boilerplate reduction

| Track | Status |
|---|---|
| `ollama/types.ts` split into domain files | ✅ v0.69 |
| Tool `catch` block consolidation (`formatToolError`) | ✅ v0.82 |
| Shell execution unification | 🔜 v1.0 |
| Backend abstraction maturity (`sidecarFetch`) | 🔜 v1.0 |
| Handler registry pattern (webview/handlers typed dispatch) | 🔜 v1.0 |

---

## Coverage Plan

**Current (v0.82.0)**: 80/70/80/80 floor maintained. RAG-eval ratchet active since v0.62: `meanPrecisionAtK ≥ 0.45`, `meanRecallAtK ≥ 0.95`, `meanF1AtK ≥ 0.55`, `meanReciprocalRank ≥ 0.90`.

**Target**: ≥80/70/80/80 (stmts/branches/funcs/lines) sustained into v1.0. Branch coverage carries a lower floor because error paths and concurrent races are legitimately harder to exercise.

| Release | Status | Focus |
|---|---|---|
| v0.80 | ✅ | Security fixes + shared test helpers |
| v0.81 | ✅ | Arch integrity + perf fixes |
| v0.82 | ✅ | NotebookLM + compression paths |
| v1.0 | 🔜 | `chatView.ts` decomposition + sustained floor |

**Enforcement**: CI `--coverage.thresholds.stmts=80 --branches=70 --funcs=80 --lines=80`. Every new file lands with ≥80%; per-PR diff check blocks merges that add uncovered code. Error-path and concurrent-race branches are the remaining gap — every new test suite deliberately targets those.

---

## Reference

- [Feature Specifications](docs/feature-specs.md) — detailed specs for every backlog item
- [Audit Archive](docs/audit-archive.md) — Cycle-4 audit findings (post-v0.79, 2026-04-21)
- [CHANGELOG](CHANGELOG.md) — per-release notes
- [SECURITY.md](SECURITY.md) — threat model and vulnerability disclosure
