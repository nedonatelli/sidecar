# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

SideCar is a VS Code extension that turns local and cloud LLMs into a full agentic coding assistant. It supports Ollama, Anthropic, AWS Bedrock, OpenAI-compatible servers, Kickstand, OpenRouter, Groq, Fireworks, Gemini, and GitHub Copilot as backends. The extension provides an agent loop with 87 built-in tools (file ops, shell, git, web search, change-impact analysis, numerical-contract checking, vision, database, doc-to-test synthesis, PDF/Zotero, MCP, Notebook Mode research, dependency drift, code profiling, LaTeX compilation, CI failure analysis, research assistant, monorepo analysis), inline completions, code review, and a chat UI.

## Architecture diagrams (start here when onboarding)

Before diving into the prose architecture below, skim these four Mermaid diagrams under `docs/`. They cover the topology of the moving parts:

- [`docs/agent-loop-diagram.md`](docs/agent-loop-diagram.md) — one-iteration flowchart of `runAgentLoop`, the hook bus, termination paths.
- [`docs/tool-system-diagram.md`](docs/tool-system-diagram.md) — how `TOOL_REGISTRY` + MCP tools compose into the LLM-facing catalog, and the per-call dispatch pipeline with approval gates.
- [`docs/context-pipeline-diagram.md`](docs/context-pipeline-diagram.md) — retriever fusion (docs + memory + workspace) into the system prompt; PKI symbol-level vs. legacy file-level paths.
- [`docs/mcp-lifecycle-diagram.md`](docs/mcp-lifecycle-diagram.md) — `MCPManager` connect/reconnect/dispatch lifecycle and the three transports.

### Security-posture docs

- [`SECURITY.md`](SECURITY.md) — threat model, vulnerability disclosure path, secret-pattern catalog (`SECRET_PATTERNS_VERSION`), and explicit list of what SideCar does NOT defend against. Read this before shipping any change that touches tool dispatch, MCP, critic, or the secret scanner.
- [`docs/extending-sidecar.md`](docs/extending-sidecar.md) — the four extension surfaces (skills, custom tools, MCP servers, policy hooks). Trust semantics per surface; authoring examples; known gaps in the current plugin story.
- [`docs/adr/`](docs/adr/) — Architecture Decision Records (ADRs 001–005): local-first via Ollama, stateful agent loop, shadow workspace isolation, FlatVectorStore choice, typed facets. Use the README template when recording new significant decisions.

## Commands

```bash
npm run test              # Run all tests (vitest)
npx vitest run path/to/file.test.ts  # Run a single test file
npm run lint              # ESLint
npm run compile           # TypeScript type-check (tsc -p ./)
npm run build             # compile + esbuild bundle + copy tree-sitter wasm grammars
npm run check             # compile + compile:bench + lint + format:check + test (full CI check)
npm run package           # build + vsce package → .vsix
```

Pre-commit hooks (lint-staged via husky) run `prettier --write`, `eslint --max-warnings=0`, `tsc --noEmit`, and `vitest run --silent` (excluding `**/shadowWorkspace.test.ts` since those tests use real `git worktree` which conflicts with lint-staged's stash-and-restore context). Full suite runs in CI.

## Development & Release Process

Full process in [`CONTRIBUTING.md`](CONTRIBUTING.md). The non-negotiables:

- **Coding loop:** branch off `main` (never commit to main); complete implementations, no stubs; co-locate tests, new files ≥80%, never drop the CI coverage floor (70/63/67/71); run `npm run check` before every commit; conventional commits + `Co-Authored-By` footer. **Never push or tag without an explicit request.** Refactors preserve the public import surface via barrel re-exports.
- **Verification pyramid** (match tier to risk; run all before a release): **T0** every commit — `npm run check`. **T1** pre-release, no model — `build` + `package` + `verify:package` + `test:coverage` + Stryker on the moat modules (`npx stryker run`; add moved moat files to `stryker.conf.json`). **T2** pre-release, needs a model — `eval:smoke` on `qwen2.5-coder:7b` **plus a differential 2nd model**; the gate is **zero infra errors** (500s / `Unknown tool` / empty-final-answer / thrash-to-maxIterations), not the pass rate. **T3** campaign — `bench:bfcl`, `bench:swe:predict`.
- **Release:** verify pyramid (all green, zero infra errors) → pick version (semver from the last git tag; the bump script rejects skips) → sync CHANGELOG **and** README **and** `docs/index.html` **and** `SECURITY.md` (supported-version table auto-bumped by the script; verify the `SECRET_PATTERNS_VERSION` "unchanged through vX" line manually) (+ stat drift; see CONTRIBUTING's doc-sync matrix) → `package` + `verify:package` → commit, tag `vX.Y.Z`, push **on explicit go-ahead only**.
- **Debugging model-interaction bugs:** reproduce at the lowest layer (raw `/api/chat`) → bisect one variable → **differential across models** (fails on both = SideCar; on one = that model) → read _trajectories_ not pass/fail → instrument with temp `console.error` DIAG then `git checkout` to revert → correct the record when a hypothesis is disproven → a bug found via eval is a real product bug: fix it **and** add a regression test.
- **Eval harness** measures whether the model can address the task, played by a cooperative user: assertions tolerate synonyms (any-of groups), the harness answers `ask_user` via `clarifyFn`, thinking is off for speed, `qwen2.5-coder:7b` is the reliable baseline / `qwen3.5:latest` the stress model.

## Testing

- Framework: **Vitest** with `src/__mocks__/vscode.ts` providing a mock VS Code API
- Tests live next to source: `src/foo.ts` → `src/foo.test.ts`
- The `vscode` module alias is configured in `vitest.config.ts` so tests never import the real VS Code API
- Use `vi.stubGlobal('fetch', mockFetch)` for network tests — all backends are HTTP-based
- Integration tests are excluded from the default run (`src/test/integration/`)
- Eval harness: `npm run eval:llm` runs LLM-specific evals via `vitest.eval.config.ts`

## Architecture

### Extension Entry Point

`src/extension.ts` — thin orchestrator that activates all subsystems and registers commands. Logic is fully extracted into focused modules under `src/activation/` (baseSetup, servicesInit, mcpSetup, warmup, workspaceIndexer, chatViewSetup, editorFeatures) and `src/commands/` (autoMode, settings, agent, prAndReview). `src/ui/statusBar.ts` owns status-bar state.

### Backend Abstraction (`src/ollama/`)

All LLM communication goes through the `ApiBackend` interface (`backend.ts`):

```
ApiBackend (interface)
├── OllamaBackend      — /api/chat, /api/generate (FIM)
├── AnthropicBackend   — /v1/messages with prompt caching
├── BedrockBackend     — AWS Bedrock invoke (native Anthropic payload, SigV4 + event-stream)
├── OpenAIBackend      — /v1/chat/completions (generic OpenAI-compat)
├── KickstandBackend   — /v1/chat/completions + /api/v1/models/* management
├── OpenRouterBackend  — OpenAI-compat + catalog + referrer headers
├── GroqBackend        — OpenAI-compat
├── FireworksBackend   — OpenAI-compat
├── GeminiBackend      — OpenAI-compat (Google generativelanguage endpoint; overrides model listing)
└── CopilotBackend     — GitHub Copilot API
```

`BedrockBackend` reuses the Anthropic message/tool mapping and the shared `anthropicStreamTranslate.ts` (also used by `AnthropicBackend`); Bedrock-specific concerns are isolated in `awsSigV4.ts` (request signing, no AWS SDK), `awsEventStream.ts` (AWS event-stream frame decoding), and `awsCredentials.ts` (env / `~/.aws/credentials` resolution). Auth is the AWS credential chain, not an API key.

`SideCarClient` (`client.ts`) wraps the active backend with retry (`retry.ts`), circuit breaker (`circuitBreaker.ts`), rate limiting (`rateLimitState.ts`), fallback backend switching, and model discovery across Ollama + Kickstand.

Key types in `types.ts`: `ChatMessage`, `ContentBlock` (text/image/tool_use/tool_result/thinking), `StreamEvent`, `ToolDefinition`. `ToolDefinition.nondeterministicOutput?: boolean` marks tools whose results must never be dedup'd by the prompt pruner (e.g. `read_file`, `git_diff`); backends derive the dedup-exempt set from this field at call time rather than a hardcoded list.

SSE parsing for all OpenAI-compatible backends is shared in `openAiSseStream.ts`.

### Agent Loop (`src/agent/`)

`loop.ts` is the orchestrator. Its inner logic lives in `src/agent/loop/` submodules:

- `streamTurn.ts` — stream one LLM turn, parse tool calls; queries `EpisodicMemoryStore` before each call and appends a `<prior_context>` block to the system prompt when relevant summaries are retrieved
- `executeToolUses.ts` — parallel tool execution with approval gates
- `dispatchToolUses.ts` — lower-level tool dispatch (parallel + serial batching)
- `compression.ts` — context pruning between turns (triggered at `CONTEXT_COMPRESSION_THRESHOLD`); after `ConversationSummarizer` fires, the batch summary is embedded and stored in `EpisodicMemoryStore` so it can be retrieved in future turns
- `cycleDetection.ts` — burst cap + two-tier repeated-action bail: **exact-match** ring buffer (fires at 4) plus a **normalized-signature** ring buffer (strips secondary args to `name:primaryResource`, fires at 3) that catches "same tool, same file, different edit content" loops the exact check misses
- `criticHook.ts` — adversarial critic; fires at the COMPLETION boundary over the run's cumulative edits (not after each edit — reviewing half-finished work is what made it drive early bails)
- `../plans/externalPlan.ts` — S1 externalized plan (pure): `applyPlanUpdate` / `renderPlanState` (<plan_state> per-turn re-injection) / `parsePlanFromText` (harness-seeded from approved plan-mode output) / `advancePlanPastWrite` (evidence-driven pointer: writing a step's last-named path advances current) / `planStepWriteTargetsNotWritten` (missing-deliverable gate check) / `isPlanOnlyTurn` (update_plan-only turns are refunded to the iteration budget). Gated by `sidecar.plan.externalized`; the gate has plan-incomplete + missing-deliverable checks flagged as PRIMARY work so the keep-best ratchet never arms on them
- `../executor/paramRemap.ts` + `../executor/toolNameAlias.ts` — deterministic recovery for wrong-but-unambiguous calls: parameter-synonym remap (`file`→`path`, `old_string`→`search`; required keys first, then declared optional keys) and foreign tool-name aliases (`create_file`→`write_file`, `bash`→`run_command`); both disclose the canonical name in the result, both resolved before approval gates, both mutation-tested moat modules
- `policyHook.ts` — extensible pre/post-turn hooks (HookBus)
- `builtInHooks.ts` — built-in policy hooks (stub check, auto-fix, critic, gate)
- `gate.ts` — completion gate (refuse to finish without lint/test)
- `stubCheck.ts` — detect placeholder code in agent output
- `autoFix.ts` — post-edit auto-lint and auto-fix
- `textParsing.ts` — parse tool calls from model text output (qwen3, Hermes, bare/fused JSON; alias-aware name acceptance) + `isDegenerateText` (token-salad detector: the loop discards a degenerate would-be-final turn, retries once, then bails 'stuck')
- `routing.ts` — pre-turn role-based model routing hook
- `messageBuild.ts` — construct tool-result messages before the next turn
- `state.ts` — `LoopState` type shared across all submodules
- `finalize.ts` — post-loop teardown and notification flush
- `notifications.ts` — surface tool-result summaries and tool-budget warnings
- `toolBudget.ts` — per-tool rate limiting (burst cap per tool per session)
- `steerDrain.ts` — drain `SteerQueue` at iteration boundaries; fires abort on interrupt urgency
- `multiFileEdit.ts` — bounded-parallel multi-file edit batching

Tools are registered in `tools.ts` with definitions and executors. Each tool is a `{ definition: ToolDefinition, executor: (input, context) => Promise<string> }`. The second `context` parameter (`ToolExecutorContext`) carries per-call data: `onOutput` streaming callback, `signal` abort signal, `cwd` override (used by Shadow Workspaces), `client` reference, etc.

### SteerQueue (`src/agent/steerQueue.ts`)

Human-in-the-loop steer buffering. Users can submit follow-up instructions while the agent is deep in a tool call; submissions queue and drain at the next iteration boundary via `steerDrain.ts`. Two urgencies: `nudge` (drains at boundary) and `interrupt` (fires stream abort immediately). Multiple steers coalesce into one synthetic user turn. The `SteerQueueFullError` is thrown when the queue fills entirely with non-evictable interrupts. UI strip subscribes via `SteerQueue.onChange` for live rendering without polling.

### Agent Memory (`src/agent/memory/`)

`pinnedMemory.ts` — `PinnedMemoryStore` persists user-pinned notes and file snippets to `.sidecar/memory/`. Pinned entries are injected into the system prompt by `systemPrompt.ts` with always-include semantics. Entries are content-addressed by SHA-256 so identical content is deduplicated. The store is read at startup and written on every pin/unpin operation.

### Episodic Memory (`src/agent/episodicMemory.ts`)

Session-scoped RAG layer for conversation context. When `compression.ts` summarizes old turns, the batch summary is embedded (MiniLM-L6-v2, 384-dim, same model as PKI) and stored in an in-memory `FlatVectorStore`. Before each LLM turn, `streamTurn.ts` queries the store using the current user message as the query, filters hits below `MIN_EPISODIC_SIMILARITY = 0.4`, and appends a `<prior_context>` block to the system prompt. This lets the agent recover relevant earlier decisions even after they've been compressed out of the message window — without re-expanding the context.

`EpisodicMemoryStore` API: `add(summary, turnIndex)` (embed + store), `query(text, k)` (retrieve top-K), `buildContextBlock(queryText)` (formats the `<prior_context>` injection). The store uses `null` as `sidecarDir` so `persist()`/`restore()` are no-ops — the store is always session-only. Lazy-loads the embedding model on first `add()` call; gracefully no-ops if the model fails to load. Use `setPipelineForTests(pipeline)` to inject a deterministic fake embedder in tests (also resets `modelLoading` so model loading is skipped entirely).

### Dependency Drift (`src/deps/`)

v0.91+ passive scanner that surfaces outdated and vulnerable dependencies in the VS Code Problems panel (`source: sidecar-deps`). Gated by `sidecar.deps.enabled`.

- `types.ts` — `DepEcosystem`, `ParsedDep`, `DepVulnerability`, `DepResult`, `ManifestScanResult`
- `semver.ts` — `stripRange(version)` + `semverGt(a, b)` (no external lib; pre-release stripped)
- `parsers/packageJson.ts`, `requirements.ts`, `cargoToml.ts`, `goMod.ts` — manifest parsers returning `ParsedDep[]`
- `registries/npm.ts`, `pypi.ts`, `cargo.ts`, `go.ts` — fetch latest stable version from npm registry, PyPI, crates.io, Go proxy
- `osv.ts` — `osvBatchQuery(queries, signal?)` POSTs to `https://api.osv.dev/v1/querybatch`; maps severity from `database_specific.severity` and CVSS score fallback; never throws
- `driftScanner.ts` — `DriftScanner` class: 1-hour in-memory cache, concurrent (10 at a time) version fetches, OSV batch check; `scan(manifestPaths, opts)` → `ManifestScanResult[]`; `clearCache()`
- `driftDiagnostics.ts` — `DriftDiagnostics` class owns a separate `DiagnosticCollection('sidecar-deps')`; `report(result)` maps vuln severity to VS Code `Error`/`Warning`/`Information`; `watch()` creates `FileSystemWatcher` per manifest glob; 2 s debounce on save via `scheduleScan`
- Agent tool: `src/agent/tools/deps.ts` — `check_dependencies` tool with optional `ecosystem` and `checkVulnerabilities` params; uses `workspace.findFiles` to discover manifests; gated by `sidecar.deps.enabled`
- Activation: `src/activation/depsSetup.ts` — wires `DriftScanner` + `DriftDiagnostics`, file watchers, `sidecar.deps.scan` command, and fires initial scan at startup

### Model Arena (`src/arena/`)

v0.90+ side-by-side model comparison panel with local ELO ratings.

- `types.ts` — `EloState`, `ArenaLane`, `ArenaTurn`; `ArenaToPanel` / `PanelToArena` discriminated unions for webview messaging; constants `ELO_DEFAULT_RATING = 1200`, `ELO_K_FACTOR = 32`
- `eloStore.ts` — `EloStore` class; `load()` / `save()` to `.sidecar/arena/elo.json`; `getRating(model)` / `recordWin(winner, losers[])` — uses standard ELO formula `E_a = 1/(1 + 10^((Rb-Ra)/400))`, K=32, multi-way pairwise; saves after every update
- `arenaPanel.ts` — `ArenaPanel` singleton `WebviewPanel`; `create(context, client, eloStore, models)`; `runChatSession` fans out to `streamLane` per model via `Promise.allSettled`; `streamLane` calls `client.streamChat(..., modelOverride)` and posts `chunk`/`laneDone`/`laneError`; `handleVote` calls `eloStore.recordWin` and posts `eloUpdate`; full inline HTML/CSS/JS with flexbox lane layout, streaming text areas, vote buttons, ELO leaderboard bar
- `arenaCommands.ts` — `openArena(deps)` (chat mode, QuickPick or pre-filled); `openArenaAgent(deps, callbacks, reviewDeps)` — calls `dispatchForks` with `modelOverrides`, then `reviewForkBatch`, records ELO for winner; `pickModels(client, opts)` multi-select QuickPick
- Activation: `src/activation/arenaSetup.ts` — registers `sidecar.arena.open` and `sidecar.arena.agent`, creates shared `EloStore`, wires `ForkReviewDeps` for agent mode

Config: `sidecar.arena.{enabled, defaultModels}`.

### External Context Providers (`src/context/`)

v0.89+ live issue-tracker integration. At the start of each agent turn, configured providers are fetched and an `## Active Issues` block is injected into the system prompt. Results cached 5 minutes. Errors are non-fatal — a `⚠️` line appears but the turn continues.

- `types.ts` — `ContextProviderConfig` discriminated union (`github` | `linear` | `jira`), `FetchedContext`, `ContextProviderResult`
- Provider modules fetch and normalize issue data from each tracker
- Activated via `sidecar.contextProviders` (array of configs in workspace settings)

### Notebook Mode (`src/agent/tools/notebook.ts`)

Source-Grounded Research tool suite, gated by `sidecar.notebookModeEnabled`. Six tools: `ingest_source` (index a URL or local file), `generate_briefing` (multi-section doc), `generate_study_guide` (progressive Q&A), `generate_faq` (top-N cited FAQs), `generate_timeline` (chronological extraction), `generate_outline` (hierarchical topic tree). Sources are held in-memory per session; each artifact carries per-sentence citations back to the source. Wired into `notebookHandlers.ts` for the Notebook Mode chat panel.

Source IDs: label-derived IDs are produced via `slugify(label)`; auto-generated IDs use `src-1`, `src-2`, … skipping any already-taken slots. Duplicate label slugs are rejected with an error — `ingest_source` never silently overwrites an existing source.

### Shadow Workspaces (`src/agent/shadow/`)

v0.59+ opt-in feature: run agent tasks in an ephemeral git worktree at `.sidecar/shadows/<task-id>/` off the current `HEAD` so writes never touch the user's main tree until an explicit accept.

- `shadowWorkspace.ts` — `ShadowWorkspace` class wraps `GitCLI` worktree primitives. `create()` → `git worktree add --detach`, `diff()` → unified diff (tracked + untracked), `applyToMain()` → `git apply --index` onto main, `dispose()` → teardown.
- `sandbox.ts` — `runAgentLoopInSandbox()` drop-in replacement for `runAgentLoop` that wraps per `sidecar.shadowWorkspace.mode` (`off` | `opt-in` | `always`). Prompts via `showQuickPick` at end; accept applies diff, reject discards.

The `cwdOverride` option on `AgentOptions` threads through `executeToolUses.ts` into every per-tool `ToolExecutorContext.cwd`, and `fs.ts` tools resolve relative paths via `resolveRootUri(context)` — so fs writes land in the shadow transparently when enabled.

### Audit Mode (`src/agent/audit/`)

v0.60+ `sidecar.agentMode: 'audit'` tier. An alternative to Shadow Workspaces for the "don't let the agent silently touch disk" failure mode — lighter-weight (no git worktree) but in-memory-only.

- `auditBuffer.ts` — process-wide singleton `AuditBuffer` accessed via `getDefaultAuditBuffer()`. Every `write_file` / `edit_file` / `delete_file` in `fs.ts` diverts into a `Map<path, BufferedChange>` when audit mode is active. Read-through: `read_file` returns buffered content for paths the agent already wrote. `flush(writeDisk, deleteDisk, paths?, executeCommit?)` has two atomicity tiers: (1) **file writes are atomic** — any per-write failure rolls back every already-applied entry to its `originalContent` and throws `AuditFlushError`; (2) **commits execute after writes and are NOT rolled back on failure** — if a queued commit fails after file writes landed, the writes stay on disk (can't be safely rolled back without losing the agent's work) and the unprocessed commit stays queued for retry. The `AuditFlushError` in the commit-failure case carries `applied` paths plus a `<commit>` failed entry so the UI can explain the half-state. **Concurrent flushes serialize via a `flushChain` promise** (v0.62.3): without this, two overlapping `flush()` calls would each snapshot the entries map synchronously and both iterate it, causing every write to land on disk twice. The second flush now awaits the first, sees an empty buffer, and returns `applied=[]` cleanly.
- `reviewCommands.ts` — three `sidecar.audit.*` commands (`review` / `acceptAll` / `rejectAll`) backed by an `AuditReviewUi` abstraction so tests bypass `window.*`. Review opens a `showQuickPick`; `vscode.diff` renders per-file diff against captured `originalContent`. Accept flushes via `workspace.fs.writeFile` + `workspace.fs.delete({ useTrash: true })`.

Scope is the agent's file-authoring surface only — shell commands still run normally. Match the threat model: `write_file` is how hallucinations become persistent damage, so that's what we gate.

`src/agent/tools/auditHelper.ts` — shared helpers `isAuditModeActive(context?)` and `shouldBufferCommits(context?)` imported by both `fs.ts` and `git.ts`; avoids duplicating the mode-check logic.

### Typed Sub-Agent Facets (`src/agent/facets/`)

v0.66+ dispatchable specialist system. A facet is a named sub-agent with a preferredModel, tool allowlist, system prompt, optional `dependsOn` edges, and optional RPC schema. Built-in catalog ships 9 specialists embedded in code (not loaded from disk — avoids a broken-unpack footgun). Users layer project or user facets on top via `<workspace>/.sidecar/facets/*.md` or `sidecar.facets.registry` paths.

- `facetLoader.ts` — `parseFacetFile(path, raw, source)` YAML-frontmatter parser, `FacetValidationError` with typed reason codes (`missing-frontmatter` / `missing-id` / `duplicate-id` / `unknown-dep` / `cycle` / `io-error`), `builtInFacets()` returning the 9-facet baseline.
- `facetRegistry.ts` — `buildFacetRegistry(facets)` validates duplicate ids + unknown deps + cycles (DFS 3-coloring) and computes topological layers. `mergeWithBuiltInFacets(overrides)` — disk facets with matching ids replace built-ins.
- `facetDiskLoader.ts` — `loadFacetRegistry({ workspaceRoot, registryPaths, fsOverride? })` scans disk, merges with built-ins, returns a `LoadFacetsOutcome { registry, errors }`. Per-file parse errors never abort the load; registry-level failures fall back to built-ins only so the dispatcher is never empty.
- `facetDispatcher.ts` — `dispatchFacet` runs one facet through `runAgentLoopInSandbox` with preferredModel pin+restore, allowlist → `toolOverride` + `modeToolPermissions`, system-prompt composition on top of the orchestrator's, `approvalMode: 'autonomous'`, `deferPrompt: true` (see Shadow Workspaces below). `dispatchFacets(client, registry, ids, callbacks, { task, maxConcurrent, rpcTimeoutMs, rpcHandlers })` walks the registry's topological layers with bounded parallelism; returns `{ results, rpcWireTrace }` in input order.
- `facetRpcBus.ts` — `FacetRpcBus.call` **never rejects** — resolves to `{ ok: true, value }` or `{ ok: false, errorKind: 'no-handler' | 'timeout' | 'handler-threw', message }`. Handler wrapped in an async IIFE so sync throws are caught. Wire trace records every attempt. `generateRpcTools(callerId, peers, bus)` produces `rpc.<peerId>.<method>` tools and filters out the caller's own methods (no self-RPC).
- `facetReview.ts` — `planFacetReview(batch)` parses per-facet `pendingDiff` strings, extracts touched files, detects cross-facet overlaps. `reviewFacetBatch(batch, { ui, mainRoot, applyDiff? })` drives an injectable UI (Accept / Show diff / Reject / Skip per facet) and calls `GitCLI.applyPatch` onto main for each accepted facet.
- `facetCommands.ts` — `runFacetDispatchCommand(deps)` drives the `sidecar.facets.dispatch` command-palette flow with an injectable `FacetCommandUi` so tests don't need `window.*`. Typed `FacetCommandOutcome` covers disabled / every cancel path / dispatched-with-batch-and-review.

Batched-review integration with Shadow Workspaces: `sandbox.ts` accepts a `deferPrompt: true` sandbox option that captures the facet's diff in `SandboxResult.pendingDiff` and skips the per-run quickpick. Without this, a 5-facet batch would fire 5 overlapping prompts at the user. With it, the batch completes quietly and the review UI runs once after `dispatchFacets` resolves.

Run-scoped tools: the RPC tools generated per-batch flow through the new `extraTools: readonly RegisteredTool[]` option on `AgentOptions`. `executor.ts` resolves `extraTools.find(name)` before falling back to `TOOL_REGISTRY` or MCP, so ephemeral RPC tools don't pollute the global registry.

Config: `sidecar.facets.{enabled, maxConcurrent, rpcTimeoutMs, registry}`.

### Parallel Dispatch Primitive (`src/agent/parallelDispatch.ts`)

v0.67 chunk 2 extraction. Two near-identical pool-of-N-workers implementations lived side-by-side (`runWithCap` in `src/agent/loop/multiFileEdit.ts`, `runLayerWithCap` in `src/agent/facets/facetDispatcher.ts`). Fork & Parallel Solve needed the same primitive, so this module consolidates and adds abort-signal plumbing that neither copy had.

- `runWithCap<T>(tasks, { cap, signal })` — returns ordered `PromiseSettledResult<T>[]`. Never throws. Tasks that never started due to abort surface as `{ status: 'rejected', reason: AbortedBeforeStartError }` so callers don't need an undefined-check path.
- `runForEachWithCap<T>(items, work, { cap, signal })` — worker-pattern variant for callers that absorb errors inside the worker body (Facets dispatcher pattern). Errors swallowed; pool keeps running.
- `AbortedBeforeStartError` — typed so callers can distinguish "task failed" from "task was cancelled before it ran" via `err.name === 'AbortedBeforeStart'`.

`multiFileEdit.ts` + `facetDispatcher.ts` both import from here. Fork dispatcher (v0.67) and any future bounded-parallel subsystem should too.

### Fork & Parallel Solve (`src/agent/fork/`)

v0.67+ dispatch primitive that runs the agent loop N times in parallel against the same user task, each inside its own Shadow Workspace off the current `HEAD`. Every fork gets natural variance — same prompt, same model, same tools, but the agent's choice of which file to read first, how to refactor, etc. diverges per run. The review UI then presents each fork's diff side-by-side so the user can compare + pick the best.

- `forkDispatcher.ts` — `dispatchForks()` spawns N agent loops via `runWithCap` from `parallelDispatch.ts`. Typed `ForkResult { forkId, index, label, success, errorMessage?, output, charsConsumed, sandbox, durationMs }`. Every run uses `forceShadow: true, deferPrompt: true` (the v0.66 primitive) so the main tree is untouched and no mid-run quickpicks fire. Tool-call events tagged with `fork-<n>:` prefix (mirrors Facets pattern) so a future webview can route them to the right column.
- `forkReview.ts` — `planForkReview()` classifies reviewable vs skipped. `reviewForkBatch()` drives QuickPick → `vscode.diff` → modal confirm → `git apply`. Single-winner semantic (Fork attempts the same task N ways, so you pick one) — differs from Facets' multi-select (Facets specialists do different subtasks). Reuses `filesTouchedByDiff` from `facetReview.ts`. Returns typed `ForkReviewOutcome { winnerIndex, appliedOk, errorMessage?, skippedLabels }`.
- `forkCommands.ts` — `runForkDispatchCommand(deps)` is the end-to-end flow: gate on `sidecar.fork.enabled` → resolve task (preFilled from `/fork` or prompt via showInputBox) → dispatch → review when `reviewDeps` supplied. Wired into two user-facing entry points via `extension.ts` (command palette `sidecar.fork.dispatch`) and `chatView.ts` (slash-command `/fork <task>` → `forkStart` message).

Config: `sidecar.fork.{enabled, defaultCount, maxConcurrent}`.

### SIDECAR.md Parser (`src/agent/sidecarMdParser.ts`)

v0.67 chunk 1. Pure primitive (no VS Code imports) that replaces the pre-v0.67 whole-file dump + mid-chop truncation in `webview/handlers/systemPrompt.ts`.

- `parseSidecarMd(content)` — splits on H2/H3 boundaries, preserves the heading line in each section body, extracts comma-separated globs from a `<!-- @paths: glob, glob -->` sentinel immediately below the heading. Sections without a sentinel default to `priority: 'always'`.
- `pathMatchesAnyGlob(filePath, globs)` — simple glob→regex conversion supporting `**` (any depth), `*` (non-slash segment), `?` (single non-slash char), trailing `/` as `/**`. Normalizes Windows back-slashes.
- `selectSidecarMdSections(parsed, ctx)` — applies priority rules (always > scoped > low), routes scoped sections by `activeFilePath` + `mentionedPaths`, caps at `maxScopedSections`, drops whole sections in reverse priority on overflow — never mid-chops.

**v0.92 retrieval-mode layer** (`src/agent/sidecarMdIndex.ts` + `src/agent/retrieval/sidecarMdRetriever.ts`): `SidecarMdIndex` embeds each parsed section with MiniLM-L6-v2 into a persisted `FlatVectorStore` at `.sidecar/cache/sidecarMd/`. Incremental update: `quickHash` change-detects per section; only changed bodies are re-embedded; removed sections are pruned. `SidecarMdRetriever` implements `Retriever` and plugs into the RRF fusion pipeline. When `sidecarMdMode === 'retrieval'`: `always`-priority sections inject verbatim in `systemPrompt.ts`; all other sections are surfaced by the retriever at query time.

Config: `sidecar.sidecarMd.{mode, alwaysIncludeHeadings, lowPriorityHeadings, maxScopedSections, retrieval.topK, retrieval.minScore}`.

### Inline Edit (`src/inline/`)

`inlineChatProvider.ts` — `handleInlineChat` (`⌘I` / `Ctrl+I` command). v0.93+ streams the LLM response via `client.streamChat()` with a cancellable `ProgressLocation.Notification` indicator. After streaming completes, opens a side-by-side diff preview using `ProposedContentProvider` + `vscode.diff` (the same scheme used by the agent review panel) showing the original selection vs. the proposed replacement. A modal Accept/Dismiss dialog gates the final `WorkspaceEdit` apply — no changes land until the user accepts. `proposedContentProvider` is threaded from `initBaseServices` through `EditorFeatureDeps` into the command handler.

### Code Profiling (`src/agent/tools/profiling.ts`)

v0.93+ `profile_code` agent tool. Auto-detects ecosystem from workspace manifests (`package.json` → node, `requirements.txt`/`pyproject.toml` → python, `Cargo.toml` → rust, `go.mod` → go). Builds and runs the appropriate profiler command via `getDefaultToolRuntime().getShellSession()`. Parses structured output for each ecosystem:

- **Python**: `python -m cProfile -s cumulative` — parses `ncalls/tottime/cumtime` table.
- **Go**: `go test -bench=. -run=^$ -benchmem` — ranks by `ns/op` descending.
- **Rust**: `cargo bench` — ranks by `ns/iter` descending.
- **Node.js**: `node --prof <script>` + `node --prof-process` — extracts the bottom-up heavy-profile section.

Returns ranked hotspot markdown + raw `<details>` block. Gated by `sidecar.profiling.enabled` (default `false`). Config: `sidecar.profiling.{enabled, topN}`.

### LaTeX Agentic Debugging (`src/agent/tools/latex.ts`)

v0.94+ `latex_compile` agent tool. Compiles a `.tex` document and returns structured errors and warnings with file and line references. `parseLatexOutput(output, mainFile)` is a pure function that handles:

- Classic pdflatex `! Error message` / `l.NNN context` two-line format
- Inline `file:line: message` format (latexmk / pdflatex with `-file-line-error`)
- LaTeX/Package/Overfull/Underfull warning lines with embedded line-number extraction

`resolveCompilerCommand` probes `latexmk --version` first; falls back to `pdflatex` if unavailable. Gated by `sidecar.latex.enabled` (default `false`). Config: `sidecar.latex.{enabled, compiler}`.

### Persistent Executive Function (`src/agent/plans/`, `src/activation/executiveFunctionSetup.ts`)

v0.94+ task checkpointing. `PlanStore` (`planStore.ts`) reads/writes `PlanCheckpoint` to `.sidecar/plans/active.json` via `sidecarDir.readJson/writeJson`. `extractGoal(messages)` extracts the first user message, truncated to 80 chars. `createAgentCallbacks` accepts an optional 4th `planStore` parameter; when present + `executiveFunctionEnabled`: saves a snapshot in `onIterationStart`, clears in `onDone`. `ChatViewProvider.resumeFromCheckpoint(checkpoint)` restores `state.messages`, syncs the webview with `{ command: 'init' }`, and calls `handleUserMessage` with a resume prompt. `initExecutiveFunctionSetup` registers `sidecar.executiveFunction.resume` and `sidecar.executiveFunction.discard` commands and fires the startup check (deferred 2s). Gated by `sidecar.executiveFunction.enabled` (default `false`).

### Bitbucket Cloud Context Provider (`src/context/providers/bitbucket.ts`)

v0.94+ `type: 'bitbucket'` provider. `fetchBitbucketPRs(config, fetchFn?)` — calls `${baseUrl}/repositories/${workspace/repo}/pullrequests?state=OPEN&pagelen=N`. Auth: `buildAuthHeader(token)` sends `Basic base64(user:pass)` when token contains `:`, else `Bearer`. Maps `BitbucketPR` → `ContextIssue`: `id: '#N'`, `title`, `status`, `body` (truncated 400 chars + `'…'`), `url`, `labels` (reviewer `display_name` array), `updatedAt`. Wired via `ContextProviderType = 'bitbucket'` in `types.ts` and `case 'bitbucket':` in `contextProviderManager.ts`.

### MCP Client (`src/agent/mcpManager.ts`)

`MCPManager` owns all outbound connections to configured MCP servers. Key lifecycle behaviors:

- **Notification ordering** — `rebuildToolCache()` fires before `notifyStatusChange()` on every connect/reconnect path so status-change listeners always observe accurate tool counts.
- **Reconnect counter persistence** — cumulative attempt count is stored in `reconnectAttemptsByServer: Map<string, number>` on the manager (keyed by server name), not on `MCPConnection` objects (which are recreated on each attempt). Burst delays: `[2 s, 5 s, 15 s]` (`RECONNECT_DELAYS`), then `RECONNECT_STEADY_STATE_DELAY = 60 s` — reconnect never gives up permanently.
- **Concurrent-connect serialization** — `connect()` delegates to `_connect()` via `connectChain = connectChain.then(...)`. Overlapping calls queue rather than race.
- **Runtime health monitoring** — after a successful `client.connect()`, the manager sets `client.onclose` to detect unexpected drops and fire `scheduleReconnect()`. The hook guards on `conn.status !== 'connected'` so intentional `disconnect()` and `reconnectServer()` calls don't trigger spurious reconnects.

**v0.117 context-economy layer:**

- **Lazy tool schemas** — the prompt catalog stubs MCP tools to one line each (name + first sentence + `describe_tool` pointer, empty schema) unless the server config sets `alwaysLoad: true`. `getLazyToolNames()` feeds `getToolDefinitionsForTier` in `tools.ts`; dispatch always resolves the full definition via `getTool()`. Measured 46–60% per-server catalog cut on the reference servers. Failed calls on lazy tools get the real schema appended (both the MCP executor's thrown/`isError` paths and `executor.ts` schema-validation rejections), so a model that guessed args recovers in one step.
- **Mutation discipline** — `getToolMeta(name)` classifies each connected tool read-only vs mutation (`readOnlyHint` annotation wins; read-verb name heuristic for unannotated servers — server-github ships zero annotations). `completionGate.ts` tracks successful mutations (and `delegate_to_mcp` delegations, detected by the `<mcp_tool_output>` wrap) as unverified until a later successful read-only call to the same server; a bounded completion-gate reprompt demands the round-trip with draft-on-mismatch instructions. Reliability discipline, not a security boundary.
- **Forensic log** — `mcpAuditLog.ts` persists lifecycle events to `.sidecar/logs/mcp.jsonl` (always-on): stdio spawn commands (secret-redacted), discovered tool lists, connect/reconnect/disconnect, injection-signal hits. Wired via `setMcpAuditDir` in `servicesInit`.
- **`.mcp.json` parity** — `loadProjectMcpConfig` carries SideCar options (`tools`, `toolAllowlist`, `maxResultChars`, `alwaysLoad`) through, not just transport fields.

### Agentic Task Delegation via MCP (`src/agent/tools/mcpDelegate.ts`, `src/mcpServer/agentServer.ts`)

v0.95+ two-direction MCP delegation.

**Direction A — `delegate_to_mcp` tool** (`src/agent/tools/mcpDelegate.ts`): the SideCar agent can delegate sub-tasks to any configured MCP server. `resolveTaskTool(serverName, toolNames, explicitTool?)` auto-detects the entry-point tool from the `TASK_TOOL_CANDIDATES` list (`run_task`, `execute_task`, `task`, `run`, `execute`, `process`, `handle`). `delegateToMcp(input, context?)` enforces `mcpDelegationEnabled` gate, validates `server`/`task` params, checks the allowlist, verifies server connection, resolves the tool, and calls `mcpManager.callServerTool`. Gated by `sidecar.mcpDelegation.enabled` (default `false`). Allowlist: `sidecar.mcpDelegation.allowedServers` (empty = all). New `MCPManager` methods: `getServerToolNames(serverName)` (strips `mcp_${name}_` prefix), `callServerTool(serverName, toolName, input)` (looks up cached executor and calls it). `ToolExecutorContext.mcpManager` field threads the manager into tool executors so `delegate_to_mcp` can resolve it at call time.

**Direction B — SideCar as MCP server** (`src/mcpServer/agentServer.ts`): `McpAgentServer` class wraps `@modelcontextprotocol/sdk` `Server` + `StreamableHTTPServerTransport` on `127.0.0.1:${port}` (default 3457). Exposes one tool: `run_agent_task(task, maxIterations?, approvalMode?)`. Spawns `runAgentLoop` with `createClient()`, collects `onText` output, returns batch text. Optional bearer-token auth (`requireAuth` + `authToken`). Concurrency guard: `activeTaskCount >= maxConcurrent` returns "busy" without invoking the loop. `initMcpServer` activation module (`src/activation/mcpServerSetup.ts`) starts the server at activation if `sidecar.mcpServer.enabled` is `true` and registers a disposable for clean shutdown.

### Terminal Execution (`src/terminal/`)

- `shellSession.ts` — long-lived `child_process.spawn`-based shell with per-command alias/function namespace reset. Fallback path for agent commands when shell integration isn't available.
- `agentExecutor.ts` — v0.59+ `AgentTerminalExecutor` routes agent `run_command` / `run_tests` through VS Code's `terminal.shellIntegration.executeCommand` API in a reusable _SideCar Agent_ terminal. Listens to `onDidEndTerminalShellExecution` for exit codes. Returns `null` when shellIntegration is unavailable — caller falls back to `ShellSession`.
- `shellExecutor.ts` — v0.92 `CompositeShellExecutor` + `IShellExecutor` interface. Consolidates the terminal→ShellSession routing that `shell.ts` previously duplicated in `runCommand` and `runTests`. Foreground commands try `AgentTerminalExecutor` first; background commands always use `ShellSession`. `AgentTerminalExecutor` is only instantiated when `terminalExecution.enabled` is true.
- `manager.ts` — user-facing terminal manager for `handleRunCommand` (chat "run this command" prompts). Distinct from the agent-facing path above.
- `errorWatcher.ts` — subscribes to `onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution` to surface user-run command failures to the agent.

### Webview & Message Handlers (`src/webview/`)

`chatView.ts` — WebviewViewProvider that hosts the chat panel. Routes incoming webview messages (typed union in `chatWebview.ts`) to handler modules under `src/webview/handlers/`:

- `chatHandlers.ts` — thin orchestrator; pure logic extracted into submodules below
- `dispatchHandlers.ts` — top-level message dispatcher; routes each message type to the right handler
- `messageUtils.ts` — continuation detection, intent classification, error taxonomy, workspace relevance, numbered-list reference resolution
- `systemPrompt.ts` — base prompt assembly, context injection, message enrichment; `basePrompt.ts` (serialisable prompt builder); runs `rewriteQuery` (v0.84) before retrieval when `sidecar.retrievalQueryRewrite` is `'rule'` / `'llm'` / `'expand'`
- `fileHandlers.ts` — file attach/drop/save/create/move/undo/revert; `handleAttachActiveFile` toggles the currently open editor file in/out of the agent's context
- `agentCallbacks.ts` — agent-loop callback factory
- `messageEnricher.ts` — enriches assistant messages with inline annotations
- `modelHandlers.ts` — model install (Ollama pull, HF import, Kickstand pull/load)
- `modelLoader.ts` — `loadModels()` and `formatContextLength()` pure helper
- `hfInstallFlow.ts` — HuggingFace multi-step install QuickPick flow
- `agentHandlers.ts` — agent mode switching, background agents
- `githubHandlers.ts` — GitHub operations
- `sessionHandlers.ts` — session save/restore
- `notebookHandlers.ts` — Notebook Mode cell execution and output
- `reportCache.ts` — caches and diffs context reports to avoid redundant webview posts

The chat UI itself is vanilla HTML/JS/CSS in `media/chat.js` + `media/chat.css`.

### Configuration (`src/config/`)

`settings.ts` — reads `workspace.getConfiguration('sidecar')`, manages SecretStorage for API keys, backend profile switching, and provider auto-detection from URL patterns.

`constants.ts` — centralized tunable thresholds: `CONTEXT_COMPRESSION_THRESHOLD` (0.7 — loop triggers compression when estimated token usage exceeds 70% of budget), `LOCAL_CONTEXT_CAP` (131 072 — ceiling on the `num_ctx` window requested from Ollama; probed value is clamped to this so large-context models don't OOM on low-VRAM hardware), `LOCAL_MAX_SYSTEM_CHARS` (52 000 — hard cap on system prompt character budget for local models regardless of context window size; prevents the 40%-of-window formula from injecting 50K+ tokens of context that overwhelm small models), `MODEL_CONTEXT_LENGTHS` (static lookup for cloud models), `PLAN_MODE_THRESHOLDS`, `INPUT_TOKEN_RATIO`.

`tokenEstimation.ts` — lightweight token count estimator (`charsToTokens`, `estimateTokenCount`, `estimateConversationTokens`) that avoids shipping a full tokenizer. Used by `notifications.ts` and `compression.ts` to decide when to compress.

`workspaceIndex.ts` — persistent file index with relevance scoring, cached in `.sidecar/cache/`.

`symbolIndexer.ts` + `symbolGraph.ts` — tree-sitter-based symbol graph for cross-file reference resolution.

### Project Knowledge Index (`src/config/symbolEmbeddingIndex.ts`)

v0.61+ opt-in semantic layer. Symbol-granularity sibling of the file-level `EmbeddingIndex` — same `@huggingface/transformers` MiniLM-L6-v2 model + 384-dim space (note: package renamed from `@xenova/transformers` to `@huggingface/transformers` in v0.83). `SymbolIndexer.setSymbolEmbeddings(index, maxSymbolsPerFile?)` wires the embedder so every parsed file feeds each extracted symbol's body into a debounced `queueSymbol` batch drain (500 ms window, 20/batch). Queried via the `project_knowledge_search` agent tool in [`src/agent/tools/projectKnowledge.ts`](src/agent/tools/projectKnowledge.ts); tool runs cosine over the flat vector store, then calls `enrichWithGraphWalk(directHits, graph, { maxDepth, maxGraphHits })` to walk `SymbolGraph.getCallers` edges outward from each hit — so a query like "where is auth handled?" returns `requireAuth` plus every route that wraps it, tagged with `vector: 0.823` or `graph: called-by (1 hop from requireAuth)`. Gated behind `sidecar.projectKnowledge.enabled` (default-on since v0.63).

**v0.62 additions**:

- **Vector backend abstraction** ([`src/config/vectorStore.ts`](src/config/vectorStore.ts)) — storage extracted into a `VectorStore<M>` interface with `FlatVectorStore<M>` (default) and `LanceVectorStore` implementations, selected by `sidecar.projectKnowledge.backend: 'flat' | 'lance'`. `LanceVectorStore` `require()`s `@lancedb/lancedb` lazily and throws `UnsupportedBackendError` (→ falls back to flat) when it's absent. The ~92 MB `@lancedb` native binary is **not bundled** in the `.vsix` (see `.vscodeignore`), so `lance` is opt-in: users install the package into the extension runtime themselves. `FlatVectorStore` is also reused by `EpisodicMemoryStore` for session-scoped conversation context retrieval.
- **`SemanticRetriever` migration** (`src/agent/retrieval/semanticRetriever.ts`) — prefers symbol-level hits from `SymbolEmbeddingIndex` when PKI is wired + ready + non-empty; falls back to file-level `rankFiles` when not.
- **Merkle layer** ([`src/config/merkleTree.ts`](src/config/merkleTree.ts)) — content-addressed tree with SHA-256 leaf hashes + mean-pooled aggregated embeddings at file nodes. `SymbolEmbeddingIndex.setMerkleTree(tree)` replays persisted entries; `search` uses `descend(queryVec, k)` to pick candidate subtrees before scoring leaves. Gated by `sidecar.merkleIndex.enabled` (default `true`).
- **RAG-eval** ([`src/test/retrieval-eval/`](src/test/retrieval-eval/)) — golden-case fixture + harness + metrics (precision@K, recall@K, F1@K, MRR). CI ratchet in `baseline.test.ts` gates retrieval quality against floor thresholds. LLM-judged `Faithfulness` + `AnswerRelevancy` layer under `tests/llm-eval/retrieval.eval.ts` runs with `npm run eval:llm`.

**v0.84 additions**:

- **Query rewriting** (`src/agent/retrieval/queryRewriter.ts`) — `rewriteQuery(text, mode, completeFn)` expands the user's retrieval query before it hits the vector store. Four modes: `'off'` (passthrough), `'rule'` (keyword extraction + camelCase split), `'llm'` (LLM-generated alternative phrasings), `'expand'` (rule + LLM combined). Controlled by `sidecar.retrievalQueryRewrite`. Called in `systemPrompt.ts` before the retriever fusion step.
- **Chunk-level prose retrieval** — prose documents (README, markdown files) are now chunked and indexed at the paragraph level rather than file level, enabling the retriever to return the specific section relevant to the query rather than the whole file.

### HuggingFace Model Import (`src/ollama/huggingface.ts` + `hfSafetensorsImport.ts`)

Two install paths:

1. **GGUF repos** → `ollama pull hf.co/org/repo:file` (native Ollama)
2. **Safetensors repos** → download shards + `ollama create -q` (local conversion)

`inspectHFRepo()` classifies repos into: `gguf`, `safetensors`, `gated-auth-required`, `unsupported-arch`, `no-weights`, `not-found`, `network-error`. The HF flow only runs for local Ollama; Kickstand has its own `/api/v1/models/pull`.

### Kickstand Backend

Kickstand is a separate project at `/Users/nedonatelli/Documents/llmmanager`. It auto-generates a bearer token at `~/.config/kickstand/token`. `KickstandBackend` reads this token automatically — no user prompt, no settings plumbing. The profile's `secretKey` is `null`.

Management endpoints: `/api/v1/models/pull` (SSE), `/api/v1/models/{id}/load`, `/api/v1/models/{id}/unload`, `/api/v1/models` (registry list). OAI-compat endpoints (`/v1/models`, `/v1/chat/completions`) are also available.

## Conventions

- All imports use explicit `.js` extensions (NodeNext module resolution)
- Never write stub/placeholder code — always complete implementations
- `.sidecar/` top-level is tracked (for curated files like `SIDECAR.md`, `shadow.json` per the Multi-User Agent Shadows feature); ephemeral subdirs (`cache/`, `memory/`, `history-index/`, `sessions/`, `logs/`, `scratchpad/`, `shadows/`) are gitignored via the root `.gitignore`. When a new feature writes under `.sidecar/`, ask: is this hand-curated shared state (→ top level, tracked) or generated per-user state (→ subdir, add to ignore)?
- **Internal working docs go in `internal/` (gitignored) — never commit them.** This repo is **public**. Private drafts, strategy/architecture notes, dogfood plans, literature reading lists, and results write-ups belong under `internal/` (ignored via `/internal/` in `.gitignore`, so no per-file maintenance). Polished, public-facing docs go in `docs/` or the tracked root docs (`README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`). Before adding any new top-level `.md`, ask: is this meant for the public repo? If not, it goes in `internal/`.
- Workspace-scoped executing surfaces go through `checkWorkspaceConfigTrust` (hooks · MCP servers · toolPermissions · scheduledTasks · customTools · SIDECAR.md). Any new config that runs commands from `.vscode/settings.json` should follow the same per-session trust-prompt pattern
- Kickstand needs no API key prompt — the token file is read automatically from `~/.config/kickstand/token`
- Test files co-locate with source: `foo.ts` → `foo.test.ts`. Tests that use real OS state (fs, os.homedir, child_process, real git) must mock it — see `providerReachability.test.ts`, `modelHandlers.test.ts`, `kickstandBackend.test.ts` for the `vi.mock('fs', …)` passthrough pattern. Real-git tests (e.g. `shadowWorkspace.test.ts`) are excluded from the lint-staged vitest run but execute in CI
- Async generators (`async*`) are the standard pattern for streaming (model pull, chat, safetensors import)
- Provider-specific logic is isolated in backend classes; shared SSE parsing in `openAiSseStream.ts`
- Rate limiting, circuit breaking, and retry are per-provider and wired in `SideCarClient`
- Per-tool cwd resolution: `fs.ts` tools use `resolveRootUri(context)` instead of `getRootUri()` so ShadowWorkspace can route writes via `context.cwd`
