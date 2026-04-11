<p align="center">
  <img src="media/SideCar.png" alt="SideCar Logo" width="200">
</p>

# SideCar — AI Coding Assistant for VS Code

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/nedonatelli.sidecar-ai)](https://marketplace.visualstudio.com/items?itemName=nedonatelli.sidecar-ai)

**SideCar** is a free, self-hosted VS Code extension that serves as a drop-in replacement for GitHub Copilot and Claude Code. Use local [Ollama](https://ollama.com) models, the [Anthropic API](https://api.anthropic.com), [Kickstand](https://github.com/kickstand/kickstand), or any [OpenAI-compatible server](https://nedonatelli.github.io/sidecar/getting-started#using-openai-compatible-servers) (LM Studio, vLLM, llama.cpp, OpenRouter) for AI-powered coding — with full agentic capabilities, inline completions, and tool use.

> A free, open-source, local-first **autonomous AI agent for coding**. Full agent loop, not just chat. No subscriptions, no data leaving your machine.

SideCar will always be free, tips not required but appreciated.

<a href="https://www.buymeacoffee.com/nedonatelli" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-red.png" alt="Buy Me A Coffee" style="height: 20px !important;" ></a>

## Why SideCar?

Most local AI extensions for VS Code are **chat wrappers or autocomplete plugins**. SideCar is a **full agentic coding assistant** — closer to Claude Code or Cursor than to a chatbot, but free, open-source, and model-agnostic.

### vs. Local Extensions

| Capability | SideCar | Continue | Llama Coder | Twinny |
|---|---|---|---|---|
| Autonomous agent loop | **Yes** | Yes | No | No |
| File read/write/edit tools | **Yes** | Yes | No | No |
| Run commands & tests | **Yes** (persistent shell) | Yes | No | No |
| Web search | **Yes** (built-in) | No | No | No |
| Security & secrets scanning | **Yes** | No | No | No |
| MCP server support | **Yes** | Yes | No | No |
| Git integration (commit, PR, releases) | **Yes** | Partial | No | No |
| Diff preview & undo/rollback | **Yes** | Partial | No | No |
| Plan mode | **Yes** | No | No | No |
| Built-in skills (8) | **Yes** | Yes | No | No |
| Tree-sitter AST parsing | **Yes** | Yes | No | No |
| Codebase indexing | **Yes** | Yes | No | No |
| Spending budgets | **Yes** | No | No | No |
| Conversation steering (type while processing) | **Yes** | No | No | No |
| Free & open-source | Yes | Yes | Yes | Yes |

### vs. Pro Tools

| Capability | SideCar | Copilot | Cursor | Claude Code |
|---|---|---|---|---|
| Autonomous agent loop | Yes | Yes | Yes | Yes |
| Model agnostic (any provider) | **Yes** | Partial | Partial | No |
| Fully offline / self-hosted | **Yes** | No | No | No |
| HuggingFace model install | **Yes** | No | No | No |
| Custom skills system | **Yes** | Yes | Yes (.cursorrules) | Yes |
| Context compaction (manual + auto) | **Yes** | Yes | Yes | Yes |
| Spending budgets & cost tracking | **Yes** | No | Yes | No |
| Plan-then-execute mode | **Yes** | No | Yes | Yes |
| Conversation steering (type while processing) | **Yes** | No | Yes | Yes |
| Works in your existing VS Code | **Yes** | Yes | No (fork) | Yes (extension + CLI) |
| Monthly subscription | **Free** | $10-19/mo | $20/mo | Usage-based |

### What sets SideCar apart

- **True agentic autonomy** — SideCar reads your code, edits files, runs tests, reads the errors, and iterates until the task is done. Switch between cautious, autonomous, and manual modes.
- **No vendor lock-in** — Use Ollama for fully offline operation, Anthropic for Claude, OpenAI-compatible servers (LM Studio, vLLM, OpenRouter), Kickstand, or install GGUF models directly from HuggingFace. Same interface, your choice.
- **Security from the ground up** — Secrets detection, vulnerability scanning, path traversal protection, sensitive file blocking, workspace hook warnings, and prompt injection sandboxing.
- **Extensible with MCP & Skills** — Connect external tools via MCP, create custom skills with markdown files, or use the 8 built-in skills (review, debug, refactor, explain, write-tests, break-this, create-skill, mcp-builder).
- **Production-grade safety** — Agent mode controls, iteration limits, token budgets, daily/weekly spending caps, cycle detection, streaming diff preview, plan mode, and one-click rollback.
- **Persistent codebase indexing** — File index and symbol graph persist across restarts via `.sidecar/cache/`. Tree-sitter AST parsing for 6 languages. Near-instant startup on subsequent activations.
- **Smart context** — Tree-sitter AST extraction for TypeScript, JavaScript, Python, Rust, Go, and Java/Kotlin. SideCar sends relevant functions and classes to the model, not entire files.

## Features

### Agentic Coding Assistant
- **Tool use** — the model can read, write, edit, and search files, run commands, check diagnostics, and run tests autonomously
- **Agent loop** — multi-step execution (read code, edit, run tests, fix errors) without manual intervention at each step
- **Agent progress** — live step count, elapsed time, and token usage during agent runs
- **Activity indicators** — animated progress bar and tool execution pulses so you always know SideCar is working
- **Conversation steering** — chat input stays enabled during processing; send a new message to redirect the agent mid-run, or press Escape to abort. The Send button dynamically switches to Stop when the input is empty
- **Diagnostics integration** — reads compiler errors and warnings from VS Code's language services
- **Test-driven loop** — runs tests, feeds failures back to the model, iterates until passing
- **Undo/rollback** — revert all AI-made file changes with one click
- **Streaming diff preview** — in cautious mode, file writes open VS Code's diff editor with dual accept/reject UI (editor notification + chat card — first click wins)
- **Stub validator** — auto-detects placeholder code (TODO, "real implementation", stub functions) in agent output and reprompts the model to finish
- **Safety guardrails** — agent mode dropdown (cautious/autonomous/manual) in the header, iteration limits, token budget, daily/weekly spending caps
- **Thinking/reasoning** — collapsible reasoning blocks from models that support extended thinking (Anthropic) or `<think>` tags (qwen3, deepseek-r1)
- **Verbose mode** — `/verbose` to show system prompt, per-iteration summaries, and tool selection context during agent runs
- **Observability** — `/audit` to browse structured tool execution logs, "Why?" button on tool cards for on-demand decision explanations, `/insights` for conversation pattern analysis with usage trends and suggestions
- **Smart context selection** — AST-based parsing extracts relevant functions, classes, and imports from JS/TS files instead of including whole files in context
- **Bounded caches** — workspace file content and AST caches use TTL-based eviction to prevent unbounded memory growth during long sessions
- **Persistent shell** — `run_command` uses a long-lived shell process; env vars, cwd, and aliases persist between calls. Supports configurable timeouts, background commands, and streaming output
- **Context pruning** — conversation history is automatically compressed between turns so local models don't choke on accumulated context from prior tool calls
- **Clean tool display** — tool calls show as `Read src/foo.ts` with icons and spinners, matching the polish of Claude Code and Copilot

### Inline Chat (Cmd+I)
- Edit code in place within the editor
- Select code and describe changes, or insert at cursor
- Uses surrounding code context for better edits

### Inline Completions
- Copilot-like autocomplete as you type (opt-in via settings)
- Uses Ollama's FIM endpoint for local models
- Falls back to Messages API for Anthropic
- Debounced with in-flight cancellation

### Code Actions
- Right-click menu: **Explain**, **Fix**, **Refactor** with SideCar
- Selected code is sent to the chat with the action

### AI Chat
- Streaming responses in a dedicated sidebar panel
- **Semantic search** — ONNX embeddings (all-MiniLM-L6-v2) for meaning-based file relevance, blended with keyword scoring. "Authentication logic" finds `src/auth/jwt.ts` without keyword matches
- **Workspace indexing** — persistent file index with relevance scoring replaces per-message glob scan, updated incrementally via file watcher
- **Structured context rules** — `.sidecarrules` files with glob patterns to prefer, ban, or require files in context
- **Chat logging** — every conversation logged as JSONL to `$TMPDIR/sidecar-chatlogs/` for debugging and recovery
- **Rich markdown rendering** — headings, bullet/numbered lists, blockquotes, horizontal rules, bold, italic, code, and links all rendered in assistant messages
- **Active file context** — includes the currently open file and cursor position
- **@ references** — `@file:path`, `@folder:path`, `@symbol:name` for precise context inclusion
- **Image support** — paste screenshots or attach images for vision models
- **Slash commands** — `/reset`, `/undo`, `/export`, `/model`, `/help`, `/batch`, `/doc`, `/spec`, `/insight`, `/save`, `/sessions`, `/scan`, `/usage`, `/context`, `/test`, `/lint`, `/deps`, `/scaffold`, `/commit`, `/verbose`, `/prompt`, `/audit`, `/insights`, `/mcp`, `/init`, `/compact`, `/move`, `/clone`, `/skills`, `/releases`, `/release` — with autocomplete dropdown as you type
- **Diagram generation** — models can generate Mermaid diagrams in code blocks; rendered natively in chat with syntax highlighting and copy-to-SVG support
- **Actionable errors** — classified error cards with retry, start Ollama, and settings buttons
- **Sticky scroll** — auto-scroll pauses when you scroll up, floating button to jump back down
- **Chat history persistence** — conversations survive VS Code restarts (per-workspace)
- **Streaming indicator** — shows token count and generation speed
- **Model management** — switch models, install new ones from Ollama, search/filter in the model picker

### Multi-Backend Support
- **Ollama** (default) — runs locally, free, no API key needed
- **Anthropic API** — use Claude models with your API key, with prompt caching for ~90% input token cost reduction
- **OpenAI-compatible** — works with LM Studio, vLLM, llama.cpp, text-generation-webui, OpenRouter, and any server with a `/v1/chat/completions` endpoint
- Same interface for all — just change `sidecar.baseUrl` and optionally `sidecar.provider`

### MCP (Model Context Protocol)
- Connect to any MCP server via **stdio**, **HTTP**, or **SSE** transport
- MCP tools appear transparently alongside built-in tools
- **`.mcp.json` project config** — team-shared server definitions (Claude Code compatible)
- **Per-tool enable/disable** — filter out dangerous tools per server
- **Output size limits** — prevent context bloat from large MCP results
- **Health monitoring** — automatic reconnection with exponential backoff
- **`/mcp` status command** — check server status, transport, and tool counts
- **`/mcp-builder` skill** — built-in guide for creating high-quality MCP servers
- Configure via `sidecar.mcpServers` or `.mcp.json`:
  ```json
  "sidecar.mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "remote-api": {
      "type": "http",
      "url": "https://mcp.example.com/api",
      "headers": { "Authorization": "Bearer ${TOKEN}" }
    }
  }
  ```

### Security Scanning
- **Automatic secrets detection** — scans files after agent writes for AWS keys, GitHub tokens, API keys, private keys, JWTs, connection strings, and more
- **Vulnerability scanning** — flags SQL injection, command injection, XSS (innerHTML), eval usage, and insecure HTTP URLs
- **Integrated into diagnostics** — `get_diagnostics` includes security findings alongside compiler errors
- **Pre-commit scan** — `/scan` command or `SideCar: Scan Staged Files for Secrets` in the command palette scans staged git files before committing
- Skips comments, node_modules, lock files, and minified code

### Tool Registry (22+ built-in tools + MCP)
| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Create or overwrite files |
| `edit_file` | Search/replace edits in existing files |
| `search_files` | Glob pattern file search |
| `grep` | Content search with regex |
| `run_command` | Execute shell commands (persistent session, background support) |
| `list_directory` | List directory contents |
| `get_diagnostics` | Read compiler errors and warnings |
| `run_tests` | Run test suites with auto-detection |
| `git_diff/status/stage/commit/log/push/pull/branch/stash` | Full git workflow |
| `find_references` | Find symbol references across workspace |
| `web_search` | Search the web via DuckDuckGo |
| `display_diagram` | Extract and render diagrams from markdown files |
| `ask_user` | Ask the user a clarifying question with selectable options |
| `spawn_agent` | Spawn a sub-agent for parallel tasks (max depth: 3, 15 iterations each) |

### Project Instructions (SIDECAR.md)
Run `/init` in the chat to auto-generate a `.sidecar/SIDECAR.md` file from your codebase. SideCar scans config files, the file tree, and sample source files (prioritizing entry points) to produce a structured project overview. It also reads `CLAUDE.md` and `AGENTS.md` if they exist.

Or create one manually:

```markdown
# Project: My App

## Build
- Run `npm run build` to compile
- Run `npm test` to run tests

## Conventions
- Use TypeScript strict mode
- Prefer async/await over callbacks
- Components go in src/components/
```

SideCar reads this file on every message and includes it in the system prompt.

### Hooks
Run shell commands before/after any tool execution:
```json
"sidecar.hooks": {
  "write_file": { "post": "npm run lint --fix" },
  "*": { "pre": "echo \"Tool: $SIDECAR_TOOL\"" }
}
```
Environment variables: `SIDECAR_TOOL`, `SIDECAR_INPUT`, `SIDECAR_OUTPUT` (post only).

### Scheduled Tasks
Run recurring agent tasks on an interval:
```json
"sidecar.scheduledTasks": [
  { "name": "Lint check", "intervalMinutes": 30, "prompt": "Run the linter and fix any issues", "enabled": true }
]
```
Scheduled tasks run autonomously and log to the SideCar Agent output channel.

### GitHub Integration
- Clone repos, list/view/create PRs and issues
- View commit history, diffs, push/pull
- Browse repo files on GitHub

### Retrieval-Augmented Generation (RAG)
- **Automatic documentation discovery** — crawls README, docs/, wiki/ folders for `.md` files at startup
- **Keyword-based search** — retrieves relevant documentation sections for every user message
- **Context injection** — matched documentation is injected into the system prompt to improve accuracy and consistency
- **Smart ranking** — title keyword matches score 3x higher than body text; organized by type (heading vs. paragraph)
- **Configurable limits** — control max entries per query, auto-refresh interval, and enable/disable via settings
- Example: Ask "how does authentication work?" and the agent automatically includes `docs/AUTHENTICATION.md` in context

### Agent Memory (Persistent Learning)
- **Pattern tracking** — remembers successful tool uses, coding conventions, and architectural decisions across sessions
- **Full-text search** — every message queries learned patterns for relevant context
- **Use-count tracking** — frequently-referenced patterns are boosted in search results
- **Persistence** — memories stored in `.sidecar/memory/agent-memories.json` and auto-loaded on startup
- **Configurable limits** — control max entries (with LRU eviction), enable/disable via settings
- **Automatic recording** — successful tool executions are recorded as patterns without manual intervention
- Example: After successfully using `formatUserName()` for a task, it's remembered. When a similar task appears later, the function is suggested and injected

## Requirements

- **[Ollama](https://ollama.com)** installed and in your PATH (for local models)
- **Visual Studio Code** 1.88.0 or later

## Getting Started

1. Install [Ollama](https://ollama.com) if you haven't already
2. Install the SideCar extension
3. Click the SideCar icon in the activity bar
4. Start chatting — SideCar launches Ollama automatically

### Using with Anthropic API

1. Set `sidecar.baseUrl` to `https://api.anthropic.com`
2. Set `sidecar.apiKey` to your Anthropic API key
3. Set `sidecar.model` to a Claude model (e.g. `claude-sonnet-4-6`)

### Using with OpenAI-compatible servers

Works with LM Studio, vLLM, llama.cpp, text-generation-webui, OpenRouter, and more:

1. Set `sidecar.baseUrl` to your server URL (e.g. `http://localhost:1234`)
2. Set `sidecar.apiKey` if your server requires it (optional for most local servers)
3. Set `sidecar.model` to the model name on your server

SideCar auto-detects the provider. To override, set `sidecar.provider` to `"openai"`.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+I` / `Ctrl+Shift+I` | Toggle SideCar chat panel |
| `Cmd+I` / `Ctrl+I` | Inline chat (edit code in place) |
| `Cmd+L` / `Ctrl+L` | Clear chat |
| `Cmd+Shift+U` / `Ctrl+Shift+U` | Undo all AI changes |
| `Cmd+Shift+E` / `Ctrl+Shift+E` | Export chat as Markdown |

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.baseUrl` | `http://localhost:11434` | API base URL |
| `sidecar.apiKey` | `ollama` | API key (ignored for Ollama) |
| `sidecar.model` | `qwen3-coder:30b` | Model for chat |
| `sidecar.systemPrompt` | `""` | Custom system prompt |
| `sidecar.toolPermissions` | `{}` | Per-tool overrides: `{ "tool_name": "allow" \| "deny" \| "ask" }` |
| `sidecar.hooks` | `{}` | Pre/post execution hooks (see Hooks section above) |
| `sidecar.scheduledTasks` | `[]` | Recurring agent tasks (see Scheduled Tasks section above) |
| `sidecar.mcpServers` | `{}` | MCP servers to connect to (see MCP section above) |
| `sidecar.agentMode` | `cautious` | Agent approval mode: cautious, autonomous, manual |
| `sidecar.agentTemperature` | `0.2` | Temperature for agent tool-calling requests. Lower = more deterministic |
| `sidecar.agentMaxIterations` | `25` | Max agent loop iterations |
| `sidecar.agentMaxTokens` | `100000` | Max tokens per agent run |
| `sidecar.includeWorkspace` | `true` | Include workspace files in context |
| `sidecar.includeActiveFile` | `true` | Include active file in context |
| `sidecar.filePatterns` | `["**/*.ts", ...]` | File patterns for workspace context |
| `sidecar.maxFiles` | `10` | Max files in workspace context |
| `sidecar.contextLimit` | `0` | Override context token limit for local models (0 = auto-detect with 16K cap) |
| `sidecar.enableInlineCompletions` | `false` | Enable Copilot-like autocomplete |
| `sidecar.completionModel` | `""` | Model for completions (empty = use chat model) |
| `sidecar.completionMaxTokens` | `256` | Max tokens for completions |
| `sidecar.verboseMode` | `false` | Show detailed agent reasoning during runs |
| `sidecar.expandThinking` | `false` | Show reasoning blocks expanded instead of collapsed |
| `sidecar.requestTimeout` | `120` | Timeout in seconds for each LLM request. Aborts if no tokens arrive within this window. Set to 0 to disable |
| `sidecar.shellTimeout` | `120` | Default timeout for shell commands in seconds |
| `sidecar.shellMaxOutputMB` | `10` | Maximum shell output size in MB before truncation |

## Documentation

Full documentation is available at [nedonatelli.github.io/sidecar](https://nedonatelli.github.io/sidecar/).

## Support & Contact

- **Bug reports & feature requests**: [GitHub Issues](https://github.com/nedonatelli/sidecar/issues)
- **Email**: [sidecarai.vscode@gmail.com](mailto:sidecarai.vscode@gmail.com)
- **Documentation**: [nedonatelli.github.io/sidecar](https://nedonatelli.github.io/sidecar/)

## Disclaimer

SideCar is an independent project by Nicholas Donatelli and is not affiliated with, endorsed by, or sponsored by Ollama, Anthropic, Meta, Mistral AI, Google, GitHub, or any other company. All product names are trademarks of their respective holders.

## License

[MIT](LICENSE)
