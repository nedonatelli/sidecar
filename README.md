# SideCar — AI Coding Assistant for VS Code

**SideCar** is a free, self-hosted VS Code extension that serves as a drop-in replacement for GitHub Copilot and Claude Code. Use local [Ollama](https://ollama.com) models or the [Anthropic API](https://api.anthropic.com) for AI-powered coding — with full agentic capabilities, inline completions, and tool use.

> A free, open-source, local-first AI coding assistant. No subscriptions, no data leaving your machine.

## Features

### Agentic Coding Assistant
- **Tool use** — the model can read, write, edit, and search files, run commands, check diagnostics, and run tests autonomously
- **Agent loop** — multi-step execution (read code, edit, run tests, fix errors) without manual intervention at each step
- **Diagnostics integration** — reads compiler errors and warnings from VS Code's language services
- **Test-driven loop** — runs tests, feeds failures back to the model, iterates until passing
- **Undo/rollback** — revert all AI-made file changes with one click
- **Safety guardrails** — configurable agent mode (cautious/autonomous/manual), iteration limits, token budget

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
- **Workspace-aware** — automatically includes project files as context
- **Active file context** — includes the currently open file and cursor position
- **Context-aware file reading** — detects file paths in your messages and auto-includes their content
- **Image support** — paste screenshots or attach images for vision models
- **Chat history persistence** — conversations survive VS Code restarts (per-workspace)
- **Conversation management** — new chat, export as Markdown
- **Streaming indicator** — shows token count and generation speed
- **Model management** — switch models, install new ones from Ollama

### Dual Backend
- **Ollama** (default) — runs locally, free, no API key needed
- **Anthropic API** — use Claude models with your API key
- Same interface for both — just change `sidecar.baseUrl` and `sidecar.apiKey`

### Tool Registry (9 tools)
| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Create or overwrite files |
| `edit_file` | Search/replace edits in existing files |
| `search_files` | Glob pattern file search |
| `grep` | Content search with regex |
| `run_command` | Execute shell commands |
| `list_directory` | List directory contents |
| `get_diagnostics` | Read compiler errors and warnings |
| `run_tests` | Run test suites with auto-detection |

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

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.baseUrl` | `http://localhost:11434` | API base URL |
| `sidecar.apiKey` | `ollama` | API key (ignored for Ollama) |
| `sidecar.model` | `qwen3-coder:30b` | Model for chat |
| `sidecar.systemPrompt` | `""` | Custom system prompt |
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

## Disclaimer

SideCar is an independent project by Nicholas Donatelli and is not affiliated with, endorsed by, or sponsored by Ollama, Anthropic, Meta, Mistral AI, Google, GitHub, or any other company. All product names are trademarks of their respective holders.

## License

[MIT](LICENSE)
