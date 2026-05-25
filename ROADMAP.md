# SideCar Roadmap

**Current release: v0.107.0** — Regression Guards: ecosystem-aware built-in guards, per-skill `guards:` frontmatter, and `/guards` slash command. See [CHANGELOG](CHANGELOG.md) for full notes.

**Coverage floor**: ≥80/70/80/80 (stmts/branches/funcs/lines) enforced by CI. No PR merges that drop any metric.

---

## Release Plan

### Planned

| Version | Headline |
|---|---|
| v0.108.0 | Speculative Decoding — zero-latency local autocomplete via draft-model pairing (2–4× FIM throughput on Ollama + Kickstand) |
| v0.109.0 | Multi-file Edit Streams — DAG-planned edits card, parallel streaming diff previews, atomic accept/reject · semantic importance-aware message compression |
| v0.110.0 | Symbol-level Project Knowledge Index — symbol-granularity chunking + graph-walk retrieval on FlatVectorStore · bundle size / tree-shake transformers.js |
| v0.111.0 | Skill Sync & Registry — git-native user + team skill registries, cross-machine sync, Skills Picker UI |

---

### Shipped

| Version | Headline |
|---|---|
| v0.107.0 | Regression Guards: `RegressionGuardHook` on `HookBus` · built-in guards (`lint-clean`, `tests-pass`, `no-new-todos`, ecosystem-aware) · `guards:` skill frontmatter · `/guards` slash command |
| v0.106.0 | Circuit breaker exponential backoff (15→30→60→120 s) · compression result cache · `/undo` slash command (was broken) · session search filter |
| v0.105.0 | Message editing (inline ✎ editor · truncation preview · ⌘↩ submit · Escape cancel) · `/compact` slash command · edit visual preview (30 % opacity fade + hint) |
| v0.104.4 | Context window fill bar (3 px colour-coded bar above input, tooltip, per-iteration update) |
| v0.104.3 | `research_export_report` tool · `ResearchStore.generateReport()` · `/research report` slash command |
| v0.104.2 | `research_set_project_status` tool · `/research status` slash command · Research sidebar `FileSystemWatcher` auto-refresh |
| v0.104.1 | `research_update_hypothesis_status` tool · `research_list_projects` tool · `/research` slash command (`observe <note>` · project QuickPick) |
| v0.104.0 | Skills 2.0 (`allowed-tools` · `preferred-model` · `max-iterations` · `disable-model-invocation` frontmatter · 🛡 badge) · Chat Threads & Branching (`/branch` · nested Sessions sidebar · `parentId`/`branchPoint`) · Research Assistant (4 tools: `research_create_project` / `_add_hypothesis` / `_log_experiment` / `_add_observation` · `sidecar.research` sidebar · `.sidecar/research/`) |
| v0.103.0 | Inline diff preview in chat confirm card · CodeLens Add-tests + Refactor (with `findSymbolEnd`) · CI Problems panel + "Ask SideCar to fix" quick-fix · Session browser F2 rename · chat strip polish (Stop button · auto-collapse · 8 K truncation · copy) |
| v0.102.0 | GitHub Copilot backend (`CopilotBackend` via `vscode.lm`) · `'gemini'` + `'copilot'` added to `sidecar.provider` enum in Settings UI · `sidecar.notebookMode.*` settings added to schema |
| v0.101.0 | VS Code Native Integrations: Test Explorer (`TestController`) · file-tree audit badges (`FileDecorationProvider`) · SCM commit message helper · CodeLensProvider (Explain/Fix on functions/TODOs) · agent-mod line decorations · streaming inline diffs · episodic memory persistence · read-only tool tier + `describe_tool` · fork/facet WebviewPanel review |
|---|---|
| v0.100.0 | Enterprise & Collaboration: repo-level policy (`.sidecar/policy.json` · restrictions-only · `$(shield)` status bar) + shared team memory (`.sidecar/team-memory/*.md` · injected as `## Team Memory`) + agent handoff (`SideCar: Export Handoff` / `SideCar: Import Handoff` · portable JSON session bundles) |
| v0.99.0 | CI Failure Analysis (`analyze_ci_failure` tool · `SideCar: Analyze CI Failure` command · GHA log parsing · failure windowing) + Branch Protection Awareness (pre-push guard in `git_push` · `sidecar.pr.branchProtection.*`) |
| v0.98.1 | Voice patch: extension-host recording (Swift/macOS · arecord/Linux · PowerShell+WinMM/Windows) — no browser window; Cancel-to-stop UX |
| v0.98.0 | Voice Input (`sidecar.voice.enabled` · mic button · local Whisper via `@huggingface/transformers` · HTTP Whisper API fallback) |
| v0.97.0 | Semantic Agentic Search for Monorepos (`monorepo_packages` tool · `detectMonorepo` auto-detects Nx / Turbo / pnpm / yarn / Lerna · `sidecar.monorepo.enabled`) |
| v0.96.0 | Zen Mode Context Filtering (`sidecar.zenMode.enabled`) · Agent Scheduling enhancements (cron, onSave triggers, `sidecar.scheduler.run` command, run history) |
| v0.95.0 | Agentic Task Delegation via MCP: `delegate_to_mcp` tool + SideCar MCP Agent Server (`sidecar.mcpServer.enabled`) |
| v0.94.0 | Persistent Executive Function (task checkpointing · VS Code restart resume) · LaTeX Agentic Debugging (`latex_compile` tool) · Bitbucket Cloud context provider |
| v0.93.0 | Inline Edit Enhancement (streaming · diff preview · Accept/Reject) · Real-time Code Profiling (`profile_code` tool, Node.js/Python/Go/Rust) |
| v0.92.0 | SIDECAR.md Retrieval Mode (`sidecar.sidecarMd.mode: 'retrieval'`) · Shell Execution Unification (`CompositeShellExecutor`) |
| v0.91.0 | Dependency Drift Alerts (Problems panel · `check_dependencies` tool · OSV vulns · npm/PyPI/cargo/Go) |
| v0.90.0 | Model Arena (chat + agent, ELO ratings) · `/arena` slash command · selective section regeneration |
| v0.89.0 | macOS Seatbelt sandbox · background task notifications + status bar spinner · external context providers (GitHub / Linear / Jira) |
| v0.88.1 | DESIGN.md injection · `AGENTS.md`/`CLAUDE.md`/`.cursorrules` fallback · OS+shell in prompt · architect/editor split (`editorModel`) · per-directory SIDECAR.md · pluggable web search (Tavily/Brave/DDG) |
| v0.88 | Copilot interop (`vscode.lm.registerTool`) · `@sidecar` full agent loop · Agents Window opt-in · Refresh Models/Restart Ollama · eval suite v0.87d (92 cases) |
| v0.87 | Sidebar panels (Background Agents · MCP Servers · Sessions · Edit Timeline) · `edit_file` guardrails · eval suite 47+31 cases |
| v0.86 | Eval harness wires system prompt · error-recovery Rule 5 · Ollama keep_alive · parallel pinned-files build |
| v0.85 | Security audit (13 fixes) · Semantic Time Travel · ADRs · nondeterministicOutput · marketplace shortcuts · 86 new tests |
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

### v0.106.0 — Chat UX Polish II + Performance Quick-Wins

**Sprint Goal**: *Ship session search and `/undo` alongside a batch of high-ROI audit fixes that have no user-facing API surface.*

**Must Have**:
- [x] **Session search filter** — real-time name filter in the Sessions panel; resets on open; shows empty state when no results match. (`src/webview/chatWebview.ts`, `media/chat.js`, `media/chat.css`)
- [x] **`/undo` slash command** — explicit `/undo` intercept in dispatch (was broken — `isUndoRequest` rejects `/`-prefixed text); added to autocomplete + `/help`. (`src/webview/handlers/dispatchHandlers.ts`, `media/chat.js`)
- [x] **LRU eviction in `LimitedCache`** (Audit 1.1) — already correct: `Map` delete+re-set on access (verified v0.106). No code change needed.
- [x] **Compression result cache** (Audit 2.1) — `length:maxLen:head64:tail64` key; `clearCompressionCache()` in loop `finally`. (`src/agent/loop/compression.ts`, `src/agent/loop.ts`)
- [x] **Circuit-breaker exponential backoff** (Audit 3.2) — `tierCooldown(openCount)` doubles per failed probe, capped at `maxCooldownMs` (default 120 s). `openCount` resets on success. (`src/ollama/circuitBreaker.ts`)
- [x] **Lazy-load mermaid + pdf-parse** (Audit 4.1) — already correct: mermaid injected as URI only when `sidecar.enableMermaid` is true; pdf-parse uses `require()` inside function body (verified v0.106). No code change needed.

---

### v0.107.0 — Regression Guards

**Sprint Goal**: *Make "done" mean something. Give the agent configurable completion criteria that fire before it declares success, and make those criteria registerable per-skill.*

**Must Have**:
- [x] **`RegressionGuard` interface** — `RegressionGuardConfig` + `RegressionGuardHook` implements `PolicyHook`; registered on `HookBus` via `buildRegressionGuardHooks()`. Trust-gated. (`src/agent/guards/regressionGuardHook.ts`)
- [x] **Built-in guards** — `lint-clean`, `tests-pass`, `no-new-todos`; ecosystem-aware auto-detection (Node/Python/Rust/Go). (`src/agent/guards/builtInGuards.ts`)
- [x] **Per-skill guard registration** — `guards: [lint-clean, tests-pass]` frontmatter field (inline or block list); resolved to `RegressionGuardHook` instances passed as `extraPolicyHooks`. (`src/agent/skillLoader.ts`, `src/webview/handlers/chatHandlers.ts`)
- [x] **Guard browser UI** — `/guards` slash command shows configured guards, mode, and built-in catalog. Guard failures surface inline as synthetic user turns. (`src/webview/handlers/agentHandlers.ts`, `media/chat.js`)
- [x] **`sidecar.guards.enabled`** — implemented as `sidecar.regressionGuards.mode: 'off' | 'strict' | 'warn'`. Schema in `package.json`.

**Should Have** (deferred):
- [ ] **Custom invariant guards** — user-defined guards via `.sidecar/guards/*.guard.ts` files; evaluated in a sandboxed worker.
- [ ] **Guard result history** — last N guard outcomes stored per session, surfaced in `/guards` panel.

---

### v0.108.0 — Speculative Decoding

**Sprint Goal**: *Make local autocomplete feel instant. Pair a tiny draft model with the main FIM model for 2–4× throughput — local ghost text that competes with Copilot.*

**Must Have**:
- [ ] **`draftModel` field on `SideCarConfig`** — optional; when set, passes `draft_model` to Ollama `/api/generate` and the equivalent to Kickstand's OAI-compat endpoint.
- [ ] **`DRAFT_MODEL_MAP`** in `src/config/constants.ts` — curated pairs sharing tokenizer vocab: `qwen3-coder:30b → qwen2.5-coder:0.5b`, `deepseek-coder:33b → deepseek-coder:1.3b-base`, `codellama:34b → codellama:7b-code`. Auto-enables when draft is installed.
- [ ] **`OllamaBackend.completeFIM` + `KickstandBackend.completeFIM`** — pass `draft_model` when configured; silent no-op on backends that don't support it (Anthropic, OpenAI, remote OAI-compat).
- [ ] **"Install recommended draft" affordance** — when main model has a curated pair but draft isn't installed, show a one-click install notification. (`src/webview/handlers/modelHandlers.ts`)
- [ ] **`sidecar.speculativeDecoding.enabled`** — default `true` when a draft mapping exists; `sidecar.completionDraftModel` for explicit override; `sidecar.speculativeDecoding.lookahead` (default `5`).

**Should Have**:
- [ ] **Accept-rate tracking** — observed accept rate logged per session; auto-disable if below `sidecar.speculativeDecoding.minAcceptRateToKeepEnabled` (default `0.4`) after warmup window.
- [ ] **VRAM guardrail** — disable speculation when free VRAM drops below threshold (integrates with GPU-Aware Load Balancing when that ships).

---

### v0.109.0 — Multi-file Edit Streams

**Sprint Goal**: *Wide refactors feel coordinated, not sequential. The agent declares what it will touch before touching anything; the user sees all diffs stream in parallel and accepts or steers the whole batch.*

**Must Have**:
- [ ] **`EditPlan` manifest** — `{ edits: { path, op: 'create'|'edit'|'delete', rationale, dependsOn: path[] }[] }`. Planner agent produces this before any `write_file` fires when task spans ≥ `sidecar.multiFileEdits.minFilesForPlan` files (default `3`).
- [ ] **DAG builder** — topological sort of `dependsOn` edges; independent nodes dispatch in parallel up to `sidecar.multiFileEdits.maxParallel` (default `8`); dependents wait for prerequisites.
- [ ] **"Planned edits" card** — collapsible card in chat UI listing all planned paths + ops before execution. Steer Queue nudges (e.g. "skip `src/legacy/**`") revision the plan.
- [ ] **Parallel streaming diff previews** — N concurrent `tool-diff-patch` streams, one per in-flight file; Pending Changes panel shows each with a per-file abort button.
- [ ] **Atomic accept/reject** — default `bulk` granularity (accept-all or reject-all); `sidecar.multiFileEdits.reviewGranularity: 'per-file' | 'per-hunk'` for surgical control.
- [ ] **Semantic importance-aware compression** (Audit 5.2) — errors/warnings: never compress; successful writes: compress after 3 turns; read-only results: aggressive. Replaces distance-from-end heuristic in `compression.ts`.

**Should Have**:
- [ ] **Conflict detection at plan time** — DAG builder merges two `edit` ops targeting the same file into one; rejects circular deps with a single revision request.
- [ ] **`@no-plan` sentinel** — skip the planner pass for users who know better.
- [ ] **`sidecar.multiFileEdits.plannerModel`** — use a smaller model for the structured planning pass (default: main model).

---

### v0.110.0 — Symbol-level Project Knowledge Index

**Sprint Goal**: *"Where is auth handled?" returns the middleware AND every route that wraps it. Upgrade the flat file-level index to symbol-granularity vectors with graph-walk retrieval.*

**Must Have**:
- [ ] **Symbol-level chunking in `SymbolEmbeddingIndex`** — each `SymbolNode` from tree-sitter becomes its own indexed chunk (body + docstring), tagged `{ filePath, range, kind, name, containerSymbol }`. Replaces one-vector-per-file.
- [ ] **Graph-walk retrieval in `SemanticRetriever`** — after vector hit, walk `SymbolGraph` edges (`calls`, `used-by`, `imports`) up to `sidecar.projectKnowledge.graphWalkDepth` (default `2`); surface reached symbols tagged with relationship path (`graph: used-by, 1 hop from requireAuth`).
- [ ] **Incremental symbol-level updates** — on `onDidChangeTextDocument`, re-embed only changed symbols (content-hashed); unchanged symbols keep cached vectors. One-line edit costs one re-embed, not whole-file.
- [ ] **`project_knowledge_search` result shape** — structured `{ symbol, filePath, range, score, relationship }[]`; `relationship` distinguishes direct vector hits from graph-walked hits.
- [ ] **Migration from file-level index** — transparent on first activation; existing `.sidecar/cache/` re-chunked to symbol-level; old file kept one version as rollback.
- [ ] **Bundle size / tree-shake transformers.js** (Audit 4.1) — only bundle embedding pipeline, not full model zoo; estimated 25–35% smaller bundle.

**Should Have**:
- [ ] **`sidecar.projectKnowledge.graphWalkDepth`** (default `2`) and `sidecar.projectKnowledge.maxGraphHits` (default `10`) — guard against popular symbols drowning results.
- [ ] **PKI sidebar panel** — index health: symbols indexed, last update, vector count, disk footprint, rebuild button, interactive search box.

**Deferred**:
- LanceDB HNSW backend — deferred to avoid native binary deployment complexity; FlatVectorStore stays as the backend for this release. Symbol chunking + graph-walk delivers the quality improvement without the platform risk.

---

### v0.111.0 — Skill Sync & Registry

**Sprint Goal**: *Skills follow you across machines and teams. Git-native sync — no hosted registry required.*

**Must Have**:
- [ ] **`sidecar.skills.userRegistry`** — git URL (or local folder) the user owns; SideCar clones/pulls to `~/.sidecar/user-skills/` on activation. `SkillLoader` picks up every `.agent.md` inside as user-scope skills.
- [ ] **Publish from "Create Skill" flow** — *Publish to your registry* checkbox writes the new skill into the clone, commits, pushes. Standard git auth (SSH keys, tokens).
- [ ] **`sidecar.skills.teamRegistries`** — array of git URLs; each cloned into `~/.sidecar/team-skills/<slug>/`; Skills Picker tags hits by origin registry.
- [ ] **`sidecar.skills.autoPull`** — `on-start | hourly | daily | manual` (default `on-start`); conflicts surface as notifications pointing to the managed directory.
- [ ] **Skills Picker UI** — searchable panel replacing slash-command-from-memory; tagged by category + registry origin; *Stack* button to add without replacing; shows tool-allowlist chips from Skills 2.0 frontmatter.

**Should Have**:
- [ ] **Skill versioning + pinning** — `version: 1.2.0` in frontmatter; `sidecar.skills.versions` pin map; *Update available* badge in picker.
- [ ] **Trust prompt on first install** — non-configured registries prompt with full frontmatter + source link before installing. `sidecar.skills.trustedRegistries` skips prompt for known-safe sources.
- [ ] **`sidecar.skills.offline`** — hard-disable all network operations for air-gapped / CI environments.

---

### v1.0 — General Availability

**Sprint Goal**: *Reach sustained 80/70/80/80 coverage, decompose the last god module, clear all remaining known CRITICALs, and ship a public skill marketplace.*

**Must Have**:
- [x] **`extension.ts` decomposition** (T3-HIGH) — 135 lines, target ≤150 reached
- [x] **`chatView.ts` decomposition** (T3) — 258 lines; logic fully extracted to `src/webview/handlers/` (26 modules with tests)
- [x] **Coverage ≥80/70/80/80 sustained** — 80.0 / 70.99 / 81.4 / 81.25 on final run
- [x] **CLAUDE.md refresh** — extension.ts decomposition, full handlers list, ToolDefinition.nondeterministicOutput, auditHelper.ts, docs/adr/ directory
- [x] **Unused-export sweep** — removed 3 dead exports (`createPromisifyShim`, `findFixtureSymbol`, `hitsToSearchResults`); all other ts-prune hits confirmed intentional (VS Code lifecycle, SDK public API, dynamic-import targets)
- [x] **Remaining CRITICAL/HIGH audit findings** — triaged 14 items; 12 were already fixed in v0.80–v0.83; 1 SQLite `listTables` identifier bypass fixed (skip rows failing `SAFE_IDENTIFIER`); 1 `agentCallbacks.ts` timer concern confirmed non-issue (flushTimer is scope-local, `onDone` always fires via `finally`)

**Should Have**:
- [x] **`docs/adr/` directory** (T26-MEDIUM) — 5 retroactive ADRs: local-first, agent loop, shadow workspaces, FlatVectorStore, typed facets; README with template
- [x] **`nondeterministicOutput` field on `ToolDefinition`** (T28-LOW) — replaces hardcoded `DEDUP_EXEMPT_TOOLS`; backends derive the exempt set from the tool list passed at call time; `getDedupExemptToolNames()` exported from `tools.ts`; `PrunerOptions.dedupExemptTools` accepts override
- [x] **Public skill marketplace** — `sidecar.skills.openMarketplace` command opens `https://github.com/topics/sidecar-skill`; discoverable from the command palette

**Could Have**:
- [x] GitHub Issues bidirectional linking to ROADMAP entries — convention adopted: `(#NNN)` refs in entry text link to GitHub; issue bodies link back to the ROADMAP section. Future v1.1+ entries will carry issue refs as they are created.
- [x] Vision Shelf promotions: **MCP Marketplace** (`sidecar.mcp.openMarketplace` → `github.com/topics/mcp-server`); **Semantic Time Travel** (`git_search_history` tool — pickaxe + grep search across full git history)

**Definition of Done**:
- All Must Have items merged and CI green
- Coverage ≥80/70/80/80 on final passing run
- Zero unaddressed CRITICAL audit findings
- Public skill marketplace URL live and discoverable from the extension

---

### Unscheduled / Vision Shelf

Not promised to any specific release. Full specs in [docs/feature-specs.md](docs/feature-specs.md).

GPU-Native Hot-Swapping · GPU-Aware Load Balancing · Multi-repo cross-talk · Selective Regeneration · Zen Mode Context Filtering · Enterprise & Collaboration · Bitbucket/Atlassian integration · LanceDB HNSW backend (deferred from v0.110) · Domain Profiles (dense-repo context mode for physics/signal-processing) · Scheduled Task Concurrency Safety (Shadow routing + DocumentConcurrencyGate)

*(Promoted to planned: Speculative Decoding → v0.108; Multi-file Edit Streams → v0.109; Symbol-level PKI → v0.110; Skill Sync & Registry → v0.111; Regression Guards → v0.107)*

*(Promoted to shipped: Semantic Time Travel → `git_search_history` tool v1.0; MCP Marketplace → `sidecar.mcp.openMarketplace` command v1.0; Dependency Drift Alerts → `check_dependencies` tool + Problems panel v0.91.0; Model Arena → `sidecar.arena.*` commands v0.90.0; Semantic Agentic Search for Monorepos → `monorepo_packages` tool v0.97.0)*

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
| `chatView.ts` | ✅ decomposed v0.88 — `codeActions.ts` + `chatViewLifecycle.ts` extracted with tests |

### Theme 2 — Test-surface hardening

| Track | Status |
|---|---|
| Host-dependent bugs (kickstand token × 2, `fs.statfsSync`) | ✅ v0.58 |
| CI coverage ratchet 80/70/80/80 | ✅ v0.67, maintained through v0.82 |
| Eval harness: retriever / cost / summarizer fixtures | ✅ v0.62 |
| Eval harness: auto-fix + critic paths | ✅ v0.71 |
| Eval harness: Ollama backend + v0.82 cases | ✅ v0.82 |
| Shared test-helper module (`stubLoopState()`, `stubCallbacks()`) | ✅ v0.88 — `src/agent/loop/testHelpers.ts`; 16 loop test files migrated |
| Subsystem unit tests (scheduler · eventHooks · inlineChatProvider) | ✅ v0.97.0 |

### Theme 3 — Boilerplate reduction

| Track | Status |
|---|---|
| `ollama/types.ts` split into domain files | ✅ v0.69 |
| Tool `catch` block consolidation (`formatToolError`) | ✅ v0.82 |
| Shell execution unification | ✅ v0.92 — `CompositeShellExecutor` consolidates terminal + ShellSession routing |
| Backend abstraction maturity (`sidecarFetch`) | ✅ v0.97.0 (unified in v0.64) |
| Handler registry pattern (webview/handlers typed dispatch) | ✅ v0.97.0 (mature since v0.88) |

---

## Coverage Plan

**Current (v0.82.0)**: 80/70/80/80 floor maintained. RAG-eval ratchet active since v0.62: `meanPrecisionAtK ≥ 0.45`, `meanRecallAtK ≥ 0.95`, `meanF1AtK ≥ 0.55`, `meanReciprocalRank ≥ 0.90`.

**Target**: ≥80/70/80/80 (stmts/branches/funcs/lines) sustained into v1.0. Branch coverage carries a lower floor because error paths and concurrent races are legitimately harder to exercise.

| Release | Status | Focus |
|---|---|---|
| v0.80 | ✅ | Security fixes + shared test helpers |
| v0.81 | ✅ | Arch integrity + perf fixes |
| v0.82 | ✅ | NotebookLM + compression paths |
| v0.88 | ✅ | `chatView.ts` decomposition + sustained floor (80.32/71.32/80.89/81.66) |

**Enforcement**: CI `--coverage.thresholds.stmts=80 --branches=70 --funcs=80 --lines=80`. Every new file lands with ≥80%; per-PR diff check blocks merges that add uncovered code. Error-path and concurrent-race branches are the remaining gap — every new test suite deliberately targets those.

---

## Reference

- [Feature Specifications](docs/feature-specs.md) — detailed specs for every backlog item
- [Audit Archive](docs/audit-archive.md) — Cycle-4 audit findings (post-v0.79, 2026-04-21)
- [CHANGELOG](CHANGELOG.md) — per-release notes
- [SECURITY.md](SECURITY.md) — threat model and vulnerability disclosure
