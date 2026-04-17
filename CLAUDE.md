# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

SideCar is a VS Code extension that turns local and cloud LLMs into a full agentic coding assistant. It supports Ollama, Anthropic, OpenAI-compatible servers, Kickstand, OpenRouter, Groq, and Fireworks as backends. The extension provides an agent loop with 23+ tools (file ops, shell, git, web search, MCP), inline completions, code review, and a chat UI.

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

- `auditBuffer.ts` — process-wide singleton `AuditBuffer` accessed via `getDefaultAuditBuffer()`. Every `write_file` / `edit_file` / `delete_file` in `fs.ts` diverts into a `Map<path, BufferedChange>` when audit mode is active. Read-through: `read_file` returns buffered content for paths the agent already wrote. Atomic `flush(writeDisk, deleteDisk, paths?)` — any per-write failure rolls back everything already applied and throws `AuditFlushError`.
- `reviewCommands.ts` — three `sidecar.audit.*` commands (`review` / `acceptAll` / `rejectAll`) backed by an `AuditReviewUi` abstraction so tests bypass `window.*`. Review opens a `showQuickPick`; `vscode.diff` renders per-file diff against captured `originalContent`. Accept flushes via `workspace.fs.writeFile` + `workspace.fs.delete({ useTrash: true })`.

Scope is the agent's file-authoring surface only — shell commands still run normally. Match the threat model: `write_file` is how hallucinations become persistent damage, so that's what we gate.

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
