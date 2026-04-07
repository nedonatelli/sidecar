<p align="center">
  <img src="media/SideCar.png" alt="SideCar Logo" width="200">
</p>

# SideCar — AI Coding Assistant for VS Code

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/nedonatelli.sidecar-ai)](https://marketplace.visualstudio.com/items?itemName=nedonatelli.sidecar-ai)

**SideCar** is a free, self-hosted VS Code extension that serves as a drop-in replacement for GitHub Copilot and Claude Code. Use local [Ollama](https://ollama.com) models or the [Anthropic API](https://api.anthropic.com) for AI-powered coding — with full agentic capabilities, inline completions, and tool use.

> A free, open-source, local-first AI coding assistant. No subscriptions, no data leaving your machine.

## Why SideCar?

Most local AI extensions for VS Code are **chat wrappers or autocomplete plugins**. SideCar is a **full agentic coding assistant** — closer to Claude Code or Cursor than to a chatbot.

| Capability | SideCar | Continue | Llama Coder | Twinny | Copilot (free) |
|---|---|---|---|---|---|
| Chat with local models | Yes | Yes | No | Yes | Yes |
| Inline completions | Yes | Yes | Yes | Yes | Yes |
| Autonomous agent loop | **Yes** | No | No | No | No |
| File read/write/edit tools | **Yes** | No | No | No | No |
| Run commands & tests | **Yes** (persistent shell) | No | No | No | No |
| Diagnostics integration | **Yes** | No | No | No | No |
| Security & secrets scanning | **Yes** | No | No | No | No |
| MCP server support | **Yes** | No | No | No | No |
| Hooks & scheduled tasks | **Yes** | No | No | No | No |
| Git integration (commit, PR) | **Yes** | No | No | No | No |
| Diff preview & undo/rollback | **Yes** | No | No | No | No |
| Fully offline / self-hosted | Yes | Yes | Yes | Yes | No |
| Free & open-source | Yes | Yes | Yes | Yes | Freemium |

### What sets SideCar apart

- **True agentic autonomy** — SideCar doesn't just answer questions. It reads your code, edits files, runs tests, reads the errors, and iterates until the task is done. Other local AI extensions stop at chat and autocomplete.
- **No vendor lock-in** — Use Ollama for fully offline operation or the Anthropic API for Claude models. Same interface, your choice.
- **Security from the ground up** — Built-in secrets detection and vulnerability scanning run automatically after every file write. No other local-first extension does this.
- **Extensible with MCP** — Connect external tools (databases, APIs, custom scripts) via the Model Context Protocol. SideCar treats them as first-class tools alongside its built-in ones.
- **Production-grade safety** — Agent mode controls (cautious/autonomous/manual), iteration limits, token budgets, diff preview, and one-click rollback keep you in control.

## Features

### Agentic Coding Assistant
- **Tool use** — the model can read, write, edit, and search files, run commands, check diagnostics, and run tests autonomously
- **Agent loop** — multi-step execution (read code, edit, run tests, fix errors) without manual intervention at each step
- **Agent progress** — live step count, elapsed time, and token usage during agent runs
- **Activity indicators** — animated progress bar and tool execution pulses so you always know SideCar is working
- **Stop button** — abort the agent loop at any time (Send button toggles to Stop while processing)
- **Diagnostics integration** — reads compiler errors and warnings from VS Code's language services
- **Test-driven loop** — runs tests, feeds failures back to the model, iterates until passing
- **Undo/rollback** — revert all AI-made file changes with one click
- **Diff preview** — in cautious mode, file writes open VS Code's diff editor for review before applying
- **Safety guardrails** — agent mode dropdown (cautious/autonomous/manual) in the header, iteration limits, token budget
- **Thinking/reasoning** — collapsible reasoning blocks from models that support extended thinking (Anthropic) or `<think>` tags (qwen3, deepseek-r1)
- **Verbose mode** — `/verbose` to show system prompt, per-iteration summaries, and tool selection context during agent runs
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
- **Workspace indexing** — persistent file index with relevance scoring replaces per-message glob scan, updated incrementally via file watcher
- **Rich markdown rendering** — headings, bullet/numbered lists, blockquotes, horizontal rules, bold, italic, code, and links all rendered in assistant messages
- **Active file context** — includes the currently open file and cursor position
- **@ references** — `@file:path`, `@folder:path`, `@symbol:name` for precise context inclusion
- **Image support** — paste screenshots or attach images for vision models
- **Slash commands** — `/reset`, `/undo`, `/export`, `/model`, `/help`, `/batch`, `/doc`, `/spec`, `/insight`, `/save`, `/sessions`, `/scan`, `/usage`, `/context`, `/test`, `/lint`, `/deps`, `/scaffold`, `/commit`, `/verbose`, `/prompt` — with autocomplete dropdown as you type
- **Actionable errors** — classified error cards with retry, start Ollama, and settings buttons
- **Sticky scroll** — auto-scroll pauses when you scroll up, floating button to jump back down
- **Chat history persistence** — conversations survive VS Code restarts (per-workspace)
- **Streaming indicator** — shows token count and generation speed
- **Model management** — switch models, install new ones from Ollama

### Dual Backend
- **Ollama** (default) — runs locally, free, no API key needed
- **Anthropic API** — use Claude models with your API key, with prompt caching for ~90% input token cost reduction
- Same interface for both — just change `sidecar.baseUrl` and `sidecar.apiKey`

### MCP (Model Context Protocol)
- Connect to any MCP server for external tools (Gmail, Slack, databases, custom tools)
- MCP tools appear transparently alongside built-in tools
- Configure via `sidecar.mcpServers` setting:
  ```json
  "sidecar.mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    }
  }
  ```

### Security Scanning
- **Automatic secrets detection** — scans files after agent writes for AWS keys, GitHub tokens, API keys, private keys, JWTs, connection strings, and more
- **Vulnerability scanning** — flags SQL injection, command injection, XSS (innerHTML), eval usage, and insecure HTTP URLs
- **Integrated into diagnostics** — `get_diagnostics` includes security findings alongside compiler errors
- **Pre-commit scan** — `/scan` command or `SideCar: Scan Staged Files for Secrets` in the command palette scans staged git files before committing
- Skips comments, node_modules, lock files, and minified code

### Tool Registry (10+ built-in tools + MCP)
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

### Project Instructions (SIDECAR.md)
Create a `SIDECAR.md` file in your project root to give SideCar project-specific instructions that persist across sessions:

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
| `sidecar.agentMaxIterations` | `25` | Max agent loop iterations |
| `sidecar.agentMaxTokens` | `100000` | Max tokens per agent run |
| `sidecar.includeWorkspace` | `true` | Include workspace files in context |
| `sidecar.includeActiveFile` | `true` | Include active file in context |
| `sidecar.filePatterns` | `["**/*.ts", ...]` | File patterns for workspace context |
| `sidecar.maxFiles` | `10` | Max files in workspace context |
| `sidecar.enableInlineCompletions` | `false` | Enable Copilot-like autocomplete |
| `sidecar.completionModel` | `""` | Model for completions (empty = use chat model) |
| `sidecar.completionMaxTokens` | `256` | Max tokens for completions |
| `sidecar.verboseMode` | `false` | Show detailed agent reasoning during runs |
| `sidecar.expandThinking` | `false` | Show reasoning blocks expanded instead of collapsed |
| `sidecar.shellTimeout` | `120` | Default timeout for shell commands in seconds |
| `sidecar.shellMaxOutputMB` | `10` | Maximum shell output size in MB before truncation |

## Documentation

Full documentation is available at [nedonatelli.github.io/sidecar](https://nedonatelli.github.io/sidecar/).

## Disclaimer

SideCar is an independent project by Nicholas Donatelli and is not affiliated with, endorsed by, or sponsored by Ollama, Anthropic, Meta, Mistral AI, Google, GitHub, or any other company. All product names are trademarks of their respective holders.

## License

[MIT](LICENSE)
