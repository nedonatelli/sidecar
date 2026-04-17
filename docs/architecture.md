# SideCar Architecture

## Overview

SideCar is an AI-powered coding assistant for VS Code that operates as an autonomous agent. It can interact with your codebase, execute commands, and perform various development tasks using a combination of local LLMs (via Ollama) and cloud APIs (Anthropic Claude).

## Core Components

### 1. Extension Entry Point
- `extension.ts` - Main activation point that initializes all components
- Sets up webview chat interface
- Registers commands and keyboard shortcuts
- Initializes workspace indexing
- Configures tooling and agent components

### 2. Webview Interface
- `ChatViewProvider` - Manages the chat UI in VS Code
- Handles user messages and displays responses
- Routes commands to appropriate handlers
- Manages chat state and history

### 3. Agent Loop System
- `runAgentLoop` — thin 255-line orchestrator in [`src/agent/loop.ts`](../src/agent/loop.ts) that reads top-to-bottom as one iteration's pseudo-code
- [`src/agent/loop/`](../src/agent/loop/) — 14 focused helpers, each taking a single `LoopState` container:
  - `state.ts` bundles all run state into one object
  - `compression.ts` handles pre-turn + post-tool context compression
  - `streamTurn.ts` owns the streamChat request loop with per-event timeout
  - `cycleDetection.ts` implements the burst cap + cycle detection
  - `messageBuild.ts` pushes assistant + tool-result messages and accounts tokens
  - `executeToolUses.ts` dispatches tool calls in parallel (spawn_agent, delegate_task, normal)
  - `gate.ts`, `autoFix.ts`, `stubCheck.ts`, `criticHook.ts` are the four post-turn policies
  - `policyHook.ts` — `PolicyHook` interface + `HookBus` registration class. Orchestrator calls `hookBus.runAfter()` / `hookBus.runEmptyResponse()` instead of calling policies directly; `AgentOptions.extraPolicyHooks` lets callers register additional hooks
  - `builtInHooks.ts` — `defaultPolicyHooks()` wraps the four policies as `PolicyHook` adapters so they register into the bus
  - `postTurnPolicies.ts` still exists but is now only used by legacy callers (the orchestrator routes through the bus)
  - `notifications.ts` emits iteration telemetry + checkpoint prompts
  - `finalize.ts` runs the post-loop teardown + next-step suggestions
  - `textParsing.ts` parses model text output for tool-call patterns and strips repeated content

### 4. Tool System
- `tools.ts` - Registry of available tools for the agent
- Built-in tools for file operations, code search, shell commands, Git operations
- Custom tools defined in settings (gated via `checkWorkspaceConfigTrust`)
- MCP (Model Control Protocol) integration for external tools
- Tool execution with approval modes and security checks
- `ToolExecutorContext` carries per-call data: streaming callback, abort signal, `cwd` override for Shadow Workspace routing, and the active `SideCarClient` reference for model-attribution git trailers. `fs.ts` tools resolve relative paths via `resolveRootUri(context)` so ShadowWorkspace can pin writes into a shadow worktree transparently

### 5. Context Management
- `WorkspaceIndex` - Indexes project files for context retrieval
- `astContext.ts` - AST-based context for code understanding
- Context compression and summarization to manage token limits
- File pattern filtering for workspace inclusion
- `streamingFileReader.ts` - Streaming reads with summary mode for large files (>50KB)
- `documentationIndexer.ts` - Doc Index: discovers and indexes documentation, provides keyword-based search
- `agentMemory.ts` - Persistent learning: stores and retrieves patterns, decisions, and conventions
- [`src/agent/retrieval/`](../src/agent/retrieval/) - Unified `Retriever` interface + reciprocal-rank fusion across documentation index, agent memory, and workspace semantic search (`SemanticRetriever` wraps `WorkspaceIndex.rankFiles`). All three sources compete under a single shared budget inside `injectSystemContext` via `fuseRetrievers()`. `ConversationSummarizer` has a per-turn cap (default 220 chars) that usually skips the LLM compression round-trip entirely

### 6. Communication Layer
- `SideCarClient` - LLM API client routes to the right backend per provider
- `ollamaBackend.ts` - Ollama native `/api/chat` protocol
- `anthropicBackend.ts` - Anthropic Messages API with thinking + tool_use blocks
- `openaiBackend.ts` - OpenAI-compatible `/v1/chat/completions` (OpenAI, LM Studio, vLLM, llama.cpp)
- `kickstandBackend.ts` - Kickstand self-hosted (OpenAI-compatible wrapper)
- `openrouterBackend.ts` - OpenRouter with referrer headers + catalog pricing (subclass of OpenAIBackend)
- `groqBackend.ts` - Groq LPU inference (empty-body subclass of OpenAIBackend — pure plumbing, no protocol quirks)
- `fireworksBackend.ts` - Fireworks open-weight model hosting (empty-body subclass of OpenAIBackend)
- `openAiSseStream.ts` - Shared OpenAI-compatible SSE parser (anticorruption layer). Every backend that speaks `/v1/chat/completions` delegates here for stream framing, tool_call reconstruction, think-tag parsing, text tool-call interception, usage events, and finish_reason mapping. Adding a new OpenAI-compatible provider becomes a ~10-line subclass (see Groq and Fireworks)
- `mcpManager.ts` - Manages MCP servers for external tool integration
- `circuitBreaker.ts` - Per-provider three-state circuit breaker (closed → open after 5 consecutive failures → half-open after 60s cooldown). Fast-fails when a provider is demonstrably down instead of hanging on a dead request
- `streamTurn.ts` - Captures partial assistant text when a stream dies mid-turn and fires `onStreamFailure` so `/resume` can re-dispatch with a continuation hint

## Data Flow

```
User Input → Webview → Chat Handlers → Agent Loop → LLM → Tool Execution → VS Code API
                              ↑
                              └── Tool Results → Agent Loop → LLM → Response
```

## Key Features

### Autonomous Mode
- Agent runs without user intervention
- Automatically executes tools based on LLM decisions
- Can generate and execute plans before implementation

### Plan Mode
- Generates a plan for approval before executing tools
- Allows user to review and modify the approach

### Tool Permissions
- Configurable approval modes (ask, allow, deny)
- Custom tool permissions
- Security scanning for file operations

### Context Management
- Workspace indexing with file pattern filtering
- Automatic context compression
- Conversation summarization to extend context window
- **Large file handling**: streaming reads with head+tail summary for files >50KB
- **Monorepo support**: lazy indexing, depth-limited traversal, multi-root workspace configuration
- **RAG context injection**: automatic documentation discovery and retrieval
- **Agent memory injection**: learned patterns and conventions injected alongside RAG results

### Integration Points
- Git operations (status, diff, commit, push, pull, branch, stash, worktree add/remove/list)
- Testing framework integration
- Security scanning
- Custom shell commands
- **Persistent learning**: automatic recording of successful patterns during agent runs
- MCP (Model Control Protocol) for external tool integration

### Shadow Workspaces (v0.59+)

An opt-in sandbox for agent tasks. When `sidecar.shadowWorkspace.mode` is `always` (or `opt-in` + explicit per-task opt-in), the agent loop runs inside an ephemeral git worktree at `.sidecar/shadows/<task-id>/` off the current `HEAD`. The user's main working tree stays pristine; at task end, a `showQuickPick` prompt lets the user accept (apply diff to main as staged changes) or reject (discard the shadow).

Key pieces in `src/agent/shadow/`:
- `shadowWorkspace.ts` — `ShadowWorkspace` class wraps `GitCLI.worktreeAdd/Remove/getHeadSha/diffAgainstHead/applyPatch`. `git worktree add --detach` shares the main repo's object database, so only the tracked-source checkout costs disk (tens of MB typically, not a full repo clone)
- `sandbox.ts` — `runAgentLoopInSandbox()` drop-in replacement for `runAgentLoop` that plumbs `cwdOverride = shadow.path` through every per-tool `ToolExecutorContext.cwd`

v0.59 ships the MVP: per-hunk review UI, gate-command integration, shell-tool cwd pinning, symlinked build dirs, and rebase-on-moved-main conflict handling all land in v0.60+.

### Agent Terminal Integration (v0.59+)

`src/terminal/agentExecutor.ts` routes agent `run_command` / `run_tests` dispatches through VS Code's `terminal.shellIntegration.executeCommand` API in a reusable *SideCar Agent* terminal. The user sees the agent's commands execute live instead of in a hidden `child_process.spawn`, and on SSH / Dev Containers / WSL / Codespaces the shell integration inherits VS Code's remote shell session rather than escaping to the host. Listens to `onDidEndTerminalShellExecution` for exit codes. Falls back to `ShellSession` (the pre-v0.59 `child_process`-based path) when shell integration isn't available (bare shells without VS Code's init script, older VS Code, or user-disabled via `sidecar.terminalExecution.enabled`).