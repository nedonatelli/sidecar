# SideCar Overview

SideCar is an AI-powered coding assistant for VS Code that operates as an autonomous agent. It can interact with your codebase, execute commands, and perform various development tasks using a combination of local LLMs (via Ollama) and cloud APIs (Anthropic Claude).

## Key Features

### Autonomous Agent
- Run full agent loops with local Ollama or cloud APIs
- Execute tools automatically based on LLM decisions
- Generate and execute plans before implementation
- **Conversation steering** — chat input stays enabled during processing; send a new message to redirect the agent, or press Escape to abort
- **"Continue" recognition** — terse replies like `continue`, `go on`, `keep going`, `proceed`, `next` are automatically rewritten into directives that resume the agent's most recent task instead of being taken literally
- **Custom modes** — user-defined agent modes (Architect, Debugger, Coder) with dedicated system prompts and approval behavior
- **Review mode** — new approval mode that buffers every agent file edit into a Pending Agent Changes panel instead of touching disk. Click any file to see its diff, accept or discard per-file or all-at-once before anything is persisted
- **Completion gate** — refuses to let the agent declare a turn done until lint and the colocated tests for edited files have actually run, catching the "ready for use" fabrication failure mode
- **Background agents** — `/bg <task>` spawns autonomous agents that work in parallel without blocking the main chat (up to 3 concurrent, with dashboard)
- Continuous operation until task completion or user interruption

### Multi-Modal Interface
- Chat-based interface in VS Code
- Inline code completion
- Code review and PR summarization
- Commit message generation
- **Reasoning timeline** — agent reasoning renders as numbered steps with purple (thinking) and blue (tool) pills and per-step duration badges. Each reasoning block closes out when a tool call starts, so consecutive think/tool/think cycles read as distinct timeline segments
- **Customizable chat UI** — `sidecar.chatDensity` (compact/normal/comfortable), `sidecar.chatFontSize`, and `sidecar.chatAccentColor` update live without reloading the webview
- **Message list virtualization** — offscreen text messages in long sessions detach via `IntersectionObserver` and rehydrate on scroll-back, keeping 200+ message conversations responsive
- **Streaming tool-call normalization** — models that emit `<function=name>...</function>` or `<tool_call>...</tool_call>` in plain text (qwen3-coder, Hermes-style) are parsed at the backend boundary so the raw XML never leaks into the chat

### Powerful Tool System
- Built-in tools for file operations, code search, shell commands, Git operations
- Custom tools defined in settings
- MCP (Model Control Protocol) integration for external tools
- Sub-agent spawning for complex tasks (max 3 levels deep, 15 iterations each)
- Tool execution with approval modes and security checks
- **Typed Sub-Agent Facets** *(new in v0.66)* — dispatch named specialists (`general-coder`, `test-author`, `security-reviewer`, `latex-writer`, `signal-processing`, `frontend`, `technical-writer`, `data-engineer`) against a shared task via `SideCar: Facets: Dispatch Specialists`. Each facet runs in its own isolated Shadow Workspace with its own tool allowlist, preferred model, and composed system prompt; multi-facet batches coalesce into a single aggregated review flow instead of stacking per-facet prompts. Typed RPC bus lets facets coordinate. Add project-local facets under `<workspace>/.sidecar/facets/*.md` or user facets via `sidecar.facets.registry`
- **Fork & Parallel Solve** *(new in v0.67)* — `/fork <task>` or `SideCar: Fork & Compare` spawns N parallel approaches to the same task, each running a full agent loop inside its own Shadow Workspace off the current `HEAD`. When every fork settles, a pick-the-winner QuickPick + `vscode.diff` + modal confirm + `git apply` picks the best output and discards the losers. Differs from Facets (N specialists on different subtasks) — Fork is N attempts at the **same** task. Config: `sidecar.fork.defaultCount` (default `3`), `sidecar.fork.maxConcurrent` (default `3`)

### Context Management
- **Semantic search** — ONNX embeddings (all-MiniLM-L6-v2) for meaning-based file relevance, blended with keyword scoring
- **Structured context rules** — `.sidecarrules` files with glob patterns to prefer, ban, or require files in context
- Workspace indexing with file pattern filtering
- Automatic context compression and summarization
- AST-based code understanding
- **SIDECAR.md path-scoped section injection** *(new in v0.67)* — sections in `SIDECAR.md` opt-in to path-aware routing via `<!-- @paths: src/transforms/** -->` sentinels immediately under their H2 heading. SideCar injects only the sections matching the active file (or user-mentioned paths), dropping whole sections on overflow instead of mid-chopping. Closes the "15 KB SIDECAR.md burns 3.7 KB of every turn" bloat on small-context local models. Degrades to legacy whole-file behavior when no sentinels are present
- Conversation history management
- **Large file & monorepo handling**: streaming reads with summary mode for files >50KB, lazy indexing for large directories, depth-limited traversal
- **RAG (Retrieval-Augmented Generation)**: automatic documentation discovery and keyword-based search over README, docs/, wiki/ files
- **Agent memory**: persistent learning across sessions with pattern tracking, decision recording, and use-count scoring

### Code Quality
- **Stub validator** — auto-detects placeholder code in agent output and reprompts the model to finish
- **Streaming diff preview** — cautious mode shows file changes in VS Code's diff editor with dual accept/reject UI
- **JSDoc staleness diagnostics** — on save, detects orphan `@param` tags and missing parameter documentation. Surfaces as warnings with "Remove orphan" and "Add missing" quick fixes that preserve JSDoc indentation. Toggle with `sidecar.jsDocSync.enabled`
- **README sync** — on save of `README.md` or any `src/` source file, detects calls in fenced ts/tsx/js/jsx code blocks whose argument count no longer matches the current signature. Quick fix rewrites the call — drops extras or appends missing parameter names as placeholders. Toggle with `sidecar.readmeSync.enabled`
- **Chat logging** — JSONL tmp files for every conversation for debugging and recovery

### Integration Points
- Git operations (status, diff, commit, push, pull, branch, stash)
- Testing framework integration
- Security scanning
- Custom shell commands
- MCP (Model Control Protocol) for external tool integration
- **Terminal error interception** — watches the integrated terminal for non-zero exit codes and offers a **Diagnose in chat** notification that injects a synthesized prompt with the command, exit code, cwd, and ANSI-stripped output tail. Dedupes identical commands within a 30s cooldown and requires VS Code shell integration

## Architecture Overview

SideCar is built as a VS Code extension with the following main components:

1. **Extension Entry Point** (`extension.ts`) - Initializes all components and sets up the UI
2. **Webview Interface** - Chat UI and command routing
3. **Agent Loop System** - Core autonomous execution engine
4. **Tool System** - Registry and execution of available tools
5. **Context Management** - Workspace indexing, RAG, and agent memory
   - **Workspace indexing**: persistent file index with pattern filtering
   - **Streaming file reader**: handles large files with summary mode
   - **Documentation indexer**: RAG system for automatic documentation discovery
   - **Agent memory**: persistent learning store across sessions
6. **Communication Layer** - LLM API clients and VS Code API integration

## Supported Models

### Local Ollama
- Default: `qwen3-coder:30b` (or other local models)
- Works with any Ollama-compatible model
- No internet required for operation

### Cloud APIs
- Anthropic Claude models (e.g., `claude-sonnet-4-6`)
- OpenAI models (when configured)
- Other providers via custom API configuration

### Kickstand *(new in v0.67)*
- Self-hosted LLM backend with managed GPU memory and model lifecycle
- **Hot-swap LoRA adapters** on loaded models without reloading — attach a fine-tuned style/domain adapter via `SideCar: Kickstand: Load LoRA Adapter`, stack multiple adapters with per-adapter scaling, detach with `Kickstand: Unload LoRA Adapter`
- **Browse HuggingFace repos** directly from the command palette — `SideCar: Browse & Pull Models` walks the repo, renders each GGUF/MLX file with its size and quantization, and pulls the pick via Kickstand's streaming pull endpoint
- Managed via the existing `Kickstand: Load Model` / `Kickstand: Unload Model` command-palette entries

## Quick Start

1. Install SideCar extension in VS Code
2. Configure Ollama or API settings in VS Code settings
3. Open a workspace folder
4. Use the SideCar chat panel to interact with the AI agent
5. The agent can perform tasks like code explanation, bug fixing, refactoring, and more

## Usage Patterns

### Chat Mode
- Ask questions about your codebase
- Request explanations of code sections
- Get help with debugging issues

### Autonomous Mode
- Let the agent work on tasks without intervention
- Execute complex operations like code generation or refactoring

### Plan Mode
- Generate a plan for approval before executing tools
- Review and modify the approach before implementation

### Code Review
- Review current changes with the agent
- Generate PR summaries
- Create commit messages

### Testing
- Run test suites
- Generate new tests
- Analyze test failures

## Configuration

SideCar can be configured through VS Code settings with options for:
- API base URL and keys
- Model selection
- File patterns to include in context
- Tool permissions
- Custom tools
- Event hooks
- Scheduled tasks
- And more