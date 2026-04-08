---
title: Configuration
layout: default
nav_order: 4
---

# Configuration

All settings are under the `sidecar.*` prefix. Open VS Code settings (`Cmd+,` / `Ctrl+,`) and search for "sidecar".

## Connection

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.baseUrl` | string | `http://localhost:11434` | API base URL. Ollama: `http://localhost:11434`, Anthropic: `https://api.anthropic.com`, OpenAI-compatible: any URL |
| `sidecar.apiKey` | string | `ollama` | API key. Ignored for local Ollama, required for Anthropic and some OpenAI-compatible servers |
| `sidecar.model` | string | `qwen3-coder:30b` | Model for chat (e.g., `qwen3-coder`, `claude-sonnet-4-6`, or any model on your server) |
| `sidecar.provider` | enum | `auto` | Backend provider: `auto`, `ollama`, `anthropic`, `openai`. Auto-detects from URL |
| `sidecar.systemPrompt` | string | `""` | Custom system prompt appended to the default |

### Provider auto-detection

When `sidecar.provider` is `auto` (default), SideCar detects the backend from the URL:

- **`localhost:11434`** → Ollama (native API)
- **`anthropic.com`** → Anthropic (Messages API with prompt caching)
- **Everything else** → OpenAI-compatible (`/v1/chat/completions`)

Set `sidecar.provider` explicitly if auto-detection doesn't match your setup — for example, if you're running an Anthropic-compatible proxy on a custom URL.

## Agent behavior

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.agentMode` | enum | `cautious` | Approval mode: `cautious`, `autonomous`, `manual` |
| `sidecar.agentTemperature` | number | `0.2` | Temperature for agent tool-calling requests. Lower values (0.1–0.3) produce more deterministic tool selection |
| `sidecar.agentMaxIterations` | number | `25` | Max agent loop iterations |
| `sidecar.agentMaxTokens` | number | `100000` | Max tokens per agent run |
| `sidecar.requestTimeout` | number | `120` | Timeout in seconds for each LLM request. Aborts if no tokens arrive within this window. Set to 0 to disable |
| `sidecar.planMode` | boolean | `false` | Generate a plan for approval before executing tools |
| `sidecar.toolPermissions` | object | `{}` | Per-tool overrides: `{ "tool_name": "allow" \| "deny" \| "ask" }` |

## Context

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.includeWorkspace` | boolean | `true` | Include workspace files in context |
| `sidecar.includeActiveFile` | boolean | `true` | Include the currently active file |
| `sidecar.filePatterns` | array | `["**/*.ts", ...]` | Glob patterns for workspace context (25+ languages) |
| `sidecar.maxFiles` | number | `10` | Max files to include in workspace context |
| `sidecar.pinnedContext` | array | `[]` | Files or folders always included in context (relative paths) |
| `sidecar.fetchUrlContext` | boolean | `true` | Auto-fetch web page content when URLs are pasted in chat |

### Context pinning

Pin files or folders so they're always included in context, regardless of relevance scoring:

```json
"sidecar.pinnedContext": ["src/config/settings.ts", "src/agent/"]
```

You can also pin files dynamically in chat using `@pin:path`:

```
@pin:src/types.ts How does the ContentBlock type work?
```

Pinned files appear in a dedicated "Pinned Files" section before relevance-scored files.

## Auto-fix

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.autoFixOnFailure` | boolean | `false` | Auto-check diagnostics after edits and feed errors back to the model |
| `sidecar.autoFixMaxRetries` | number | `3` | Max auto-fix retry attempts |

When enabled, SideCar automatically runs VS Code's language diagnostics after the agent writes or edits a file. If errors are found, they're fed back to the model to self-correct — up to the configured retry limit.

## Inline completions

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.enableInlineCompletions` | boolean | `false` | Enable Copilot-like autocomplete |
| `sidecar.completionModel` | string | `""` | Model for completions (empty = use chat model) |
| `sidecar.completionMaxTokens` | number | `256` | Max tokens per completion |
| `sidecar.completionDebounceMs` | number | `300` | Minimum ms between completion requests |

## Shell execution

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.shellTimeout` | number | `120` | Default timeout for shell commands in seconds |
| `sidecar.shellMaxOutputMB` | number | `10` | Maximum shell output size in MB before truncation |

Shell commands (`run_command`, `run_tests`) use a **persistent shell session** — environment variables, working directory changes, and aliases persist between tool calls. Set a longer timeout for builds and installs. Use `background: true` to start long-running processes and check on them later with `command_id`.

## Debugging & reasoning

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.verboseMode` | boolean | `true` | Show system prompt, iteration summaries, and tool selection context |
| `sidecar.expandThinking` | boolean | `false` | Show model reasoning blocks expanded instead of collapsed |

## Extensibility

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.mcpServers` | object | `{}` | MCP server connections. See [MCP Servers](mcp-servers) |
| `sidecar.hooks` | object | `{}` | Pre/post tool execution hooks. See [Hooks](hooks-and-tasks#tool-hooks) |
| `sidecar.eventHooks` | object | `{}` | Event-based hooks (`onSave`, `onCreate`, `onDelete`) |
| `sidecar.scheduledTasks` | array | `[]` | Recurring agent tasks. See [Scheduled Tasks](hooks-and-tasks#scheduled-tasks) |
| `sidecar.customTools` | array | `[]` | Custom shell command tools. See [Custom Tools](hooks-and-tasks#custom-tools) |

### Custom tools example

```json
"sidecar.customTools": [
  {
    "name": "deploy",
    "description": "Deploy the application to staging",
    "command": "npm run deploy:staging"
  }
]
```

Custom tools appear alongside built-in tools and go through the same approval flow.
