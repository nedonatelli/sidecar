# Project: SideCar (ollama-vscode)

SideCar is a VS Code extension that turns local and cloud LLMs into a full agentic coding assistant. Backends: Ollama, Anthropic, OpenAI-compat, Kickstand, OpenRouter, Groq, Fireworks. Provides an agent loop with 64+ built-in tools, inline completions, code review, and a chat UI.

## Behavior

- When uncertain about an API, behavior, or dependency, say so directly ("I'm not sure about X") rather than hedging.
- For non-trivial implementation tasks with valid alternatives, briefly describe 2–3 options and the key tradeoff before writing code. Skip for routine edits.
- Never write stub or placeholder code — always complete the implementation.

## Tech Stack

- TypeScript (NodeNext module resolution — all imports use `.js` extensions)
- VS Code Extension API
- Vitest (tests co-locate with source: `foo.ts` → `foo.test.ts`)
- esbuild (bundle), tree-sitter (symbol parsing), @huggingface/transformers (MiniLM-L6-v2 embeddings)
- Husky + lint-staged (pre-commit: prettier, eslint, tsc --noEmit, vitest)

## Architecture

High-level components:

1. **Extension entry**: `src/extension.ts` — orchestrator; logic in `src/activation/` and `src/commands/`
2. **Backend abstraction**: `ApiBackend` interface (`src/ollama/backend.ts`) — unified API across providers; `SideCarClient` wraps with retry, circuit breaker, rate limiting
3. **Agent loop**: `src/agent/loop.ts` — inner submodules under `src/agent/loop/`
4. **Tools**: registered in `src/agent/tools.ts`; each is `{ definition, executor: (input, context) => Promise<string> }`
5. **Webview**: `src/webview/chatView.ts` + handlers under `src/webview/handlers/`
6. **Shadow Workspaces**: `src/agent/shadow/` — ephemeral git worktrees for isolated task runs
7. **Typed Facets**: `src/agent/facets/` — dispatchable specialist sub-agents with tool allowlists and RPC bus
8. **Fork & Parallel Solve**: `src/agent/fork/` — N parallel agent runs, user picks winner
9. **MCP**: `src/mcpServer/agentServer.ts` exposes SideCar as an MCP server; `src/agent/mcpManager.ts` connects to external servers

### Agent Loop
<!-- @paths: src/agent/loop.ts, src/agent/loop/** -->

`loop.ts` orchestrates iteration; inner submodules in `src/agent/loop/`:
- `streamTurn.ts` — stream one LLM turn; queries `EpisodicMemoryStore` before each call and appends `<prior_context>` block
- `executeToolUses.ts` — parallel tool execution with approval gates
- `dispatchToolUses.ts` — lower-level dispatch (parallel + serial batching)
- `compression.ts` — context pruning at `CONTEXT_COMPRESSION_THRESHOLD` (70% of budget); runs `ConversationSummarizer` + `compressMessages`; persists episodic summary after summarization
- `cycleDetection.ts` — burst cap + exact-match ring buffer (fires at 4) + normalized-signature ring buffer (fires at 3)
- `criticHook.ts` — adversarial critic injection after edits
- `gate.ts` — completion gate (refuses to finish without lint/test verification)
- `state.ts` — `LoopState` shared across all submodules
- `steerDrain.ts` — drains `SteerQueue` at iteration boundaries; fires abort on interrupt urgency

`AgentOptions` key fields: `toolTier` ('read' | 'full'), `episodicMemory`, `systemPromptOverride`, `modelOverride`, `maxIterations`, `approvalMode`.

### Tool Registry
<!-- @paths: src/agent/tools.ts, src/agent/tools/** -->

All tools registered in `TOOL_REGISTRY` in `src/agent/tools.ts`. Each entry: `{ definition: ToolDefinition, executor: (input, context) => Promise<string> }`.

`getToolDefinitionsForTier(tier, mcpManager?)`:
- `'read'` tier: 18 observation-only tools (no writes, no shell mutations) + always-available `describe_tool`
- `'full'` tier: all tools; extended built-ins beyond the core set get compact stub schemas (empty `input_schema`); call `describe_tool(name)` to get full parameters

`ToolExecutorContext` carries: `onOutput` (streaming callback), `signal` (abort), `cwd` (shadow workspace override), `client`, `mcpManager`, `approvalMode`.

`ToolDefinition.nondeterministicOutput?: boolean` — marks tools whose results must never be dedup'd by the prompt pruner (e.g. `read_file`, `git_diff`).

### Backend & Client
<!-- @paths: src/ollama/** -->

`ApiBackend` interface (`src/ollama/backend.ts`) unified across:
- `OllamaBackend` — `/api/chat`, `/api/generate` (FIM)
- `AnthropicBackend` — `/v1/messages` with prompt caching
- `OpenAIBackend` — `/v1/chat/completions` (generic OAI-compat)
- `KickstandBackend` — OAI-compat + management endpoints; reads bearer token automatically from `~/.config/kickstand/token` — no user prompt, no API key needed
- `OpenRouterBackend`, `GroqBackend`, `FireworksBackend` — OAI-compat variants

`SideCarClient` (`client.ts`) wraps the active backend with retry (`retry.ts`), circuit breaker (`circuitBreaker.ts`), rate limiting (`rateLimitState.ts`), fallback backend switching, model discovery.

Key types in `types.ts`: `ChatMessage`, `ContentBlock` (text/image/tool_use/tool_result/thinking), `StreamEvent`, `ToolDefinition`. SSE parsing shared in `openAiSseStream.ts`.

### Webview & Handlers
<!-- @paths: src/webview/** -->

`chatView.ts` — `WebviewViewProvider` hosting the chat panel. Routes incoming messages to handlers in `src/webview/handlers/`:
- `chatHandlers.ts` — thin orchestrator; calls `runAgentLoop` with `toolTier: resolveToolTier(text)` + `episodicMemory: state.episodicMemoryStore`
- `dispatchHandlers.ts` — top-level message dispatcher
- `messageUtils.ts` — `resolveToolTier(text)` (intent classification: 'read' | 'full'), continuation detection, error taxonomy
- `systemPrompt.ts` — base prompt assembly, retriever fusion; topK doubles (2× `ragMaxDocEntries`) for read-tier queries
- `fileHandlers.ts` — file attach/drop/save/create/move/undo/revert
- `agentCallbacks.ts` — agent-loop callback factory
- `modelHandlers.ts` — model install flows (Ollama pull, HF import, Kickstand pull/load)

Chat UI: `media/chat.js` + `media/chat.css` (vanilla HTML/JS/CSS).

### Configuration & Constants
<!-- @paths: src/config/**, src/activation/**, src/commands/** -->

- `settings.ts` — `getConfig()` reads `workspace.getConfiguration('sidecar')`; manages SecretStorage for API keys
- `constants.ts` — `CONTEXT_COMPRESSION_THRESHOLD` (0.7), `LOCAL_CONTEXT_CAP` (32 768), `MODEL_CONTEXT_LENGTHS`, `INPUT_TOKEN_RATIO`
- `tokenEstimation.ts` — lightweight token estimator; used by compression + notifications
- `sidecarDir.ts` — workspace-scoped persistent storage helper (`readJson`/`writeJson`/`getPath`/`isReady`)
- `vectorStore.ts` — `FlatVectorStore<M>` + `VectorStore<M>` interface; used by PKI, EpisodicMemoryStore, SidecarMdIndex

Activation modules in `src/activation/`: `baseSetup`, `servicesInit`, `mcpSetup`, `warmup`, `workspaceIndexer`, `chatViewSetup`, `editorFeatures`, `arenaSetup`, `depsSetup`, `executiveFunctionSetup`.

### Shadow Workspaces & Audit
<!-- @paths: src/agent/shadow/**, src/agent/audit/** -->

**Shadow Workspaces** (`src/agent/shadow/`): ephemeral git worktrees at `.sidecar/shadows/<task-id>/`.
- `shadowWorkspace.ts` — `git worktree add --detach`, `diff()`, `applyToMain()` via `git apply --index`, `dispose()`
- `sandbox.ts` — `runAgentLoopInSandbox()`; `deferPrompt: true` captures diff without prompting (used by Facets/Fork batch review)

Per-tool cwd threading: `fs.ts` tools use `resolveRootUri(context)` instead of `getRootUri()` so shadow writes land transparently when `context.cwd` is set.

**Audit Mode** (`src/agent/audit/`): in-memory write buffer when `sidecar.agentMode: 'audit'`.
- `auditBuffer.ts` — `AuditBuffer` singleton; `write_file`/`edit_file`/`delete_file` divert into `Map<path, BufferedChange>`; `flush()` has file-write atomicity; concurrent flushes serialize via `flushChain`
- `reviewCommands.ts` — `sidecar.audit.review/acceptAll/rejectAll`

### Facets, Fork & Parallel Dispatch
<!-- @paths: src/agent/facets/**, src/agent/fork/**, src/agent/parallelDispatch.ts -->

**Facets** (`src/agent/facets/`): typed specialist sub-agents; built-in catalog of 8 specialists.
- `facetLoader.ts` — YAML-frontmatter parser, `FacetValidationError` with reason codes, `builtInFacets()`
- `facetDispatcher.ts` — `dispatchFacets()` walks topological layers with bounded concurrency; `deferPrompt: true` batches review
- `facetRpcBus.ts` — `FacetRpcBus.call` never rejects; generates `rpc.<peerId>.<method>` tools per batch

**Fork** (`src/agent/fork/`): N parallel runs of the same task in separate shadow workspaces; single winner.
- `forkDispatcher.ts` — `dispatchForks()` via `runWithCap`; each run uses `forceShadow: true, deferPrompt: true`
- `forkReview.ts` — `reviewForkBatch()`: QuickPick → `vscode.diff` → `git apply`

**Parallel primitive** (`src/agent/parallelDispatch.ts`): `runWithCap<T>` (ordered results) + `runForEachWithCap<T>` (worker pattern); abort-signal plumbing; `AbortedBeforeStartError`.

### Memory & Context
<!-- @paths: src/agent/memory/**, src/agent/episodicMemory.ts, src/agent/agentMemory.ts, src/agent/sidecarMdIndex.ts, src/agent/sidecarMdParser.ts, src/agent/retrieval/** -->

**Pinned Memory** (`src/agent/memory/pinnedMemory.ts`): user-pinned notes/snippets persisted to `.sidecar/memory/`; content-addressed by SHA-256; always injected into system prompt.

**Episodic Memory** (`src/agent/episodicMemory.ts`): session-scoped RAG for conversation context.
- When `compression.ts` summarizes old turns, the batch summary is embedded + stored in `FlatVectorStore`
- Before each LLM turn, `streamTurn.ts` queries and appends a `<prior_context>` block
- Persisted to `.sidecar/cache/episodic/`; shared across all agent runs via `state.episodicMemoryStore` on `ChatState`
- Constructor: `new EpisodicMemoryStore(sidecarDir)` — pass null for session-only (no disk persistence)

**SIDECAR.md Index** (`src/agent/sidecarMdIndex.ts`): embeds each H2/H3 section for semantic retrieval mode. Persisted to `.sidecar/cache/sidecarMd/`.

**Retrieval pipeline** (`src/agent/retrieval/`): RRF fusion of `SemanticRetriever` (PKI symbols), `DocRetriever` (docs), `SidecarMdRetriever` (SIDECAR.md). topK doubles for read-tier queries.

### MCP & External Integration
<!-- @paths: src/mcpServer/**, src/agent/mcpManager.ts, src/agent/tools/mcpDelegate.ts, src/context/** -->

**SideCar as MCP server** (`src/mcpServer/agentServer.ts`): `McpAgentServer` on `127.0.0.1:3457`; exposes `run_agent_task(task, maxIterations?, approvalMode?)`; optional bearer-token auth; concurrency guard.

**External MCP servers** (`src/agent/mcpManager.ts`): connect/reconnect/dispatch; three transports (stdio, SSE, StreamableHTTP). `getServerToolNames(serverName)`, `callServerTool(serverName, toolName, input)`.

**`delegate_to_mcp` tool** (`src/agent/tools/mcpDelegate.ts`): agent delegates sub-tasks to any configured MCP server; auto-detects entry-point tool from `TASK_TOOL_CANDIDATES`.

**External Context Providers** (`src/context/`): GitHub, Linear, Jira, Bitbucket; fetched at turn start, `## Active Issues` injected into system prompt; 5-min cache; errors non-fatal.

## Commands

```bash
npm run test              # run all tests (vitest)
npx vitest run path/to/file.test.ts  # run a single test file
npm run lint              # ESLint
npm run compile           # TypeScript type-check
npm run build             # compile + esbuild bundle
npm run check             # compile + lint + test (full CI)
npm run package           # build + vsce package → .vsix
```

## Conventions

- All imports use explicit `.js` extensions (NodeNext)
- Test files co-locate with source: `foo.ts` → `foo.test.ts`
- Mock VS Code API via `src/__mocks__/vscode.ts` (configured in `vitest.config.ts`)
- Streaming uses `async*` generators throughout
- Provider-specific logic stays in backend classes; shared SSE parsing in `openAiSseStream.ts`
- `.sidecar/` top-level is tracked (curated files); ephemeral subdirs (`cache/`, `memory/`, `sessions/`, `logs/`, `shadows/`) are gitignored
- Per-tool cwd resolution: `fs.ts` tools use `resolveRootUri(context)` — required for Shadow Workspace routing
- Workspace-scoped executing surfaces go through `checkWorkspaceConfigTrust` (hooks, MCP, toolPermissions, SIDECAR.md)
