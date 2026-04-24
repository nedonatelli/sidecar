# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

SideCar is a VS Code extension that turns local and cloud LLMs into a full agentic coding assistant. It supports Ollama, Anthropic, OpenAI-compatible servers, Kickstand, OpenRouter, Groq, and Fireworks as backends. The extension provides an agent loop with 55+ tools (file ops, shell, git, web search, vision, database, doc-to-test synthesis, PDF/Zotero, MCP), inline completions, code review, and a chat UI.

## Architecture diagrams (start here when onboarding)

Before diving into the prose architecture below, skim these four Mermaid diagrams under `docs/`. They cover the topology of the moving parts:

- [`docs/agent-loop-diagram.md`](docs/agent-loop-diagram.md) — one-iteration flowchart of `runAgentLoop`, the hook bus, termination paths.
- [`docs/tool-system-diagram.md`](docs/tool-system-diagram.md) — how `TOOL_REGISTRY` + MCP tools compose into the LLM-facing catalog, and the per-call dispatch pipeline with approval gates.
- [`docs/context-pipeline-diagram.md`](docs/context-pipeline-diagram.md) — retriever fusion (docs + memory + workspace) into the system prompt; PKI symbol-level vs. legacy file-level paths.
- [`docs/mcp-lifecycle-diagram.md`](docs/mcp-lifecycle-diagram.md) — `MCPManager` connect/reconnect/dispatch lifecycle and the three transports.

### Security-posture docs

- [`SECURITY.md`](SECURITY.md) — threat model, vulnerability disclosure path, secret-pattern catalog (`SECRET_PATTERNS_VERSION`), and explicit list of what SideCar does NOT defend against. Read this before shipping any change that touches tool dispatch, MCP, critic, or the secret scanner.
- [`docs/extending-sidecar.md`](docs/extending-sidecar.md) — the four extension surfaces (skills, custom tools, MCP servers, policy hooks). Trust semantics per surface; authoring examples; known gaps in the current plugin story.

## Commands

```bash
npm run test              # Run all tests (vitest)
npx vitest run path/to/file.test.ts  # Run a single test file
npm run lint              # ESLint
npm run compile           # TypeScript type-check (tsc -p ./)
npm run build             # compile + esbuild bundle + copy tree-sitter wasm grammars
npm run check             # compile + lint + test (full CI check)
npm run package           # build + vsce package → .vsix
```

Pre-commit hooks (lint-staged via husky) run `prettier --write`, `eslint --max-warnings=0`, `tsc --noEmit`, and `vitest run --silent` (excluding `**/shadowWorkspace.test.ts` since those tests use real `git worktree` which conflicts with lint-staged's stash-and-restore context). Full suite runs in CI.

## Testing

- Framework: **Vitest** with `src/__mocks__/vscode.ts` providing a mock VS Code API
- Tests live next to source: `src/foo.ts` → `src/foo.test.ts`
- The `vscode` module alias is configured in `vitest.config.ts` so tests never import the real VS Code API
- Use `vi.stubGlobal('fetch', mockFetch)` for network tests — all backends are HTTP-based
- Integration tests are excluded from the default run (`src/test/integration/`)
- Eval harness: `npm run eval:llm` runs LLM-specific evals via `vitest.eval.config.ts`

## Architecture

### Extension Entry Point

`src/extension.ts` — activates all subsystems: chat webview, terminal manager, MCP servers, workspace indexer, symbol graph, skill loader, completion provider, scheduled tasks, event hooks, and registers all commands. This is a large file but orchestration-only; logic lives in the subsystem modules.

### Backend Abstraction (`src/ollama/`)

All LLM communication goes through the `ApiBackend` interface (`backend.ts`):

```
ApiBackend (interface)
├── OllamaBackend      — /api/chat, /api/generate (FIM)
├── AnthropicBackend   — /v1/messages with prompt caching
├── OpenAIBackend      — /v1/chat/completions (generic OpenAI-compat)
├── KickstandBackend   — /v1/chat/completions + /api/v1/models/* management
├── OpenRouterBackend  — OpenAI-compat + catalog + referrer headers
├── GroqBackend        — OpenAI-compat
└── FireworksBackend   — OpenAI-compat
```

`SideCarClient` (`client.ts`) wraps the active backend with retry (`retry.ts`), circuit breaker (`circuitBreaker.ts`), rate limiting (`rateLimitState.ts`), fallback backend switching, and model discovery across Ollama + Kickstand.

Key types in `types.ts`: `ChatMessage`, `ContentBlock` (text/image/tool_use/tool_result/thinking), `StreamEvent`, `ToolDefinition`.

SSE parsing for all OpenAI-compatible backends is shared in `openAiSseStream.ts`.

### Agent Loop (`src/agent/`)

`loop.ts` is the orchestrator — it was decomposed in v0.50 into `src/agent/loop/` submodules:

- `streamTurn.ts` — stream one LLM turn, parse tool calls
- `executeToolUses.ts` — parallel tool execution with approval
- `compression.ts` — context pruning between turns
- `cycleDetection.ts` — burst cap + repeated-action bail
- `criticHook.ts` — adversarial critic injection after edits
- `policyHook.ts` — extensible pre/post-turn hooks (HookBus)
- `gate.ts` — completion gate (refuse to finish without lint/test)
- `stubCheck.ts` — detect placeholder code in agent output
- `textParsing.ts` — parse tool calls from model text output (qwen3, Hermes)

Tools are registered in `tools.ts` with definitions and executors. Each tool is a `{ definition: ToolDefinition, executor: (input, context) => Promise<string> }`. The second `context` parameter (`ToolExecutorContext`) carries per-call data: `onOutput` streaming callback, `signal` abort signal, `cwd` override (used by Shadow Workspaces), `client` reference, etc.

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

### Typed Sub-Agent Facets (`src/agent/facets/`)

v0.66+ dispatchable specialist system. A facet is a named sub-agent with a preferredModel, tool allowlist, system prompt, optional `dependsOn` edges, and optional RPC schema. Built-in catalog ships 8 specialists embedded in code (not loaded from disk — avoids a broken-unpack footgun). Users layer project or user facets on top via `<workspace>/.sidecar/facets/*.md` or `sidecar.facets.registry` paths.

- `facetLoader.ts` — `parseFacetFile(path, raw, source)` YAML-frontmatter parser, `FacetValidationError` with typed reason codes (`missing-frontmatter` / `missing-id` / `duplicate-id` / `unknown-dep` / `cycle` / `io-error`), `builtInFacets()` returning the 8-facet baseline.
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

The `v0.70+` retrieval-mode successor (documented on ROADMAP) will layer a `SidecarMdRetriever` onto the existing `fuseRetrievers` pipeline that uses the same chunk output — so the primitive is designed to double as the chunker for future embedding-based routing.

Config: `sidecar.sidecarMd.{mode, alwaysIncludeHeadings, lowPriorityHeadings, maxScopedSections}`.

### Terminal Execution (`src/terminal/`)

- `shellSession.ts` — long-lived `child_process.spawn`-based shell with per-command alias/function namespace reset. Fallback path for agent commands when shell integration isn't available.
- `agentExecutor.ts` — v0.59+ `AgentTerminalExecutor` routes agent `run_command` / `run_tests` through VS Code's `terminal.shellIntegration.executeCommand` API in a reusable *SideCar Agent* terminal. Listens to `onDidEndTerminalShellExecution` for exit codes. Returns `null` when shellIntegration is unavailable — caller falls back to `ShellSession`.
- `manager.ts` — user-facing terminal manager for `handleRunCommand` (chat "run this command" prompts). Distinct from the agent-facing path above.
- `errorWatcher.ts` — subscribes to `onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution` to surface user-run command failures to the agent.

### Webview & Message Handlers (`src/webview/`)

`chatView.ts` — the WebviewViewProvider that hosts the chat panel. Routes incoming webview messages (typed union in `chatWebview.ts`) to handler modules:

- `handlers/chatHandlers.ts` — main chat flow, context assembly, agent invocation (largest file, ~1900 lines)
- `handlers/modelHandlers.ts` — model install (Ollama pull, HF import, Kickstand pull/load)
- `handlers/agentHandlers.ts` — agent mode switching, background agents
- `handlers/githubHandlers.ts` — GitHub operations
- `handlers/sessionHandlers.ts` — session save/restore

The chat UI itself is vanilla HTML/JS/CSS in `media/chat.js` + `media/chat.css`.

### Configuration (`src/config/`)

`settings.ts` — reads `workspace.getConfiguration('sidecar')`, manages SecretStorage for API keys, backend profile switching, and provider auto-detection from URL patterns.

`workspaceIndex.ts` — persistent file index with relevance scoring, cached in `.sidecar/cache/`.

`symbolIndexer.ts` + `symbolGraph.ts` — tree-sitter-based symbol graph for cross-file reference resolution.

### Project Knowledge Index (`src/config/symbolEmbeddingIndex.ts`)

v0.61+ opt-in semantic layer. Symbol-granularity sibling of the file-level `EmbeddingIndex` — same `@xenova/transformers` MiniLM model + 384-dim space. `SymbolIndexer.setSymbolEmbeddings(index, maxSymbolsPerFile?)` wires the embedder so every parsed file feeds each extracted symbol's body into a debounced `queueSymbol` batch drain (500 ms window, 20/batch). Queried via the `project_knowledge_search` agent tool in [`src/agent/tools/projectKnowledge.ts`](src/agent/tools/projectKnowledge.ts); tool runs cosine over the flat vector store, then calls `enrichWithGraphWalk(directHits, graph, { maxDepth, maxGraphHits })` to walk `SymbolGraph.getCallers` edges outward from each hit — so a query like "where is auth handled?" returns `requireAuth` plus every route that wraps it, tagged with `vector: 0.823` or `graph: called-by (1 hop from requireAuth)`. Gated behind `sidecar.projectKnowledge.enabled` (default `false` in v0.62 — flips to default-on in v0.63).

**v0.62 additions**:
- **Vector backend abstraction** ([`src/config/vectorStore.ts`](src/config/vectorStore.ts)) — storage extracted into a `VectorStore<M>` interface with a `FlatVectorStore<M>` implementation. `sidecar.projectKnowledge.backend: 'flat' | 'lance'` reserves the Lance name for a future release.
- **`SemanticRetriever` migration** (`src/agent/retrieval/semanticRetriever.ts`) — prefers symbol-level hits from `SymbolEmbeddingIndex` when PKI is wired + ready + non-empty; falls back to file-level `rankFiles` when not.
- **Merkle layer** ([`src/config/merkleTree.ts`](src/config/merkleTree.ts)) — content-addressed tree with SHA-256 leaf hashes + mean-pooled aggregated embeddings at file nodes. `SymbolEmbeddingIndex.setMerkleTree(tree)` replays persisted entries; `search` uses `descend(queryVec, k)` to pick candidate subtrees before scoring leaves. Gated by `sidecar.merkleIndex.enabled` (default `true`).
- **RAG-eval** ([`src/test/retrieval-eval/`](src/test/retrieval-eval/)) — golden-case fixture + harness + metrics (precision@K, recall@K, F1@K, MRR). CI ratchet in `baseline.test.ts` gates retrieval quality against floor thresholds. LLM-judged `Faithfulness` + `AnswerRelevancy` layer under `tests/llm-eval/retrieval.eval.ts` runs with `npm run eval:llm`.

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
- Workspace-scoped executing surfaces go through `checkWorkspaceConfigTrust` (hooks · MCP servers · toolPermissions · scheduledTasks · customTools · SIDECAR.md). Any new config that runs commands from `.vscode/settings.json` should follow the same per-session trust-prompt pattern
- Kickstand needs no API key prompt — the token file is read automatically from `~/.config/kickstand/token`
- Test files co-locate with source: `foo.ts` → `foo.test.ts`. Tests that use real OS state (fs, os.homedir, child_process, real git) must mock it — see `providerReachability.test.ts`, `modelHandlers.test.ts`, `kickstandBackend.test.ts` for the `vi.mock('fs', …)` passthrough pattern. Real-git tests (e.g. `shadowWorkspace.test.ts`) are excluded from the lint-staged vitest run but execute in CI
- Async generators (`async*`) are the standard pattern for streaming (model pull, chat, safetensors import)
- Provider-specific logic is isolated in backend classes; shared SSE parsing in `openAiSseStream.ts`
- Rate limiting, circuit breaking, and retry are per-provider and wired in `SideCarClient`
- Per-tool cwd resolution: `fs.ts` tools use `resolveRootUri(context)` instead of `getRootUri()` so ShadowWorkspace can route writes via `context.cwd`
