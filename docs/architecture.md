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
  - `postTurnPolicies.ts` composes the three mutation policies (autoFix → stub → critic)
  - `notifications.ts` emits iteration telemetry + checkpoint prompts
  - `finalize.ts` runs the post-loop teardown + next-step suggestions
  - `textParsing.ts` parses model text output for tool-call patterns and strips repeated content

### 4. Tool System
- `tools.ts` - Registry of available tools for the agent
- Built-in tools for file operations, code search, shell commands, Git operations
- Custom tools defined in settings
- MCP (Model Control Protocol) integration for external tools
- Tool execution with approval modes and security checks

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
- `openAiSseStream.ts` - Shared OpenAI-compatible SSE parser (anticorruption layer). Every backend that speaks `/v1/chat/completions` delegates here for stream framing, tool_call reconstruction, think-tag parsing, text tool-call interception, usage events, and finish_reason mapping. Adding a new OpenAI-compatible provider becomes a ~50-line subclass
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
- Git operations (status, diff, commit, push, pull, branch, stash)
- Testing framework integration
- Security scanning
- Custom shell commands
- **Persistent learning**: automatic recording of successful patterns during agent runs
- MCP (Model Control Protocol) for external tool integration