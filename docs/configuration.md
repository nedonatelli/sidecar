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
| `sidecar.baseUrl` | string | `http://localhost:11434` | API base URL. Ollama: `http://localhost:11434`, Anthropic: `https://api.anthropic.com` |
| `sidecar.apiKey` | string | `ollama` | API key. Ignored for local Ollama, required for Anthropic |
| `sidecar.model` | string | `qwen3-coder:30b` | Model for chat (e.g., `qwen3-coder`, `claude-sonnet-4-6`) |
| `sidecar.systemPrompt` | string | `""` | Custom system prompt appended to the default |

## Agent behavior

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.agentMode` | enum | `cautious` | Approval mode: `cautious`, `autonomous`, `manual` |
| `sidecar.agentMaxIterations` | number | `25` | Max agent loop iterations |
| `sidecar.agentMaxTokens` | number | `100000` | Max tokens per agent run |
| `sidecar.planMode` | boolean | `false` | Generate a plan for approval before executing tools |
| `sidecar.toolPermissions` | object | `{}` | Per-tool overrides: `{ "tool_name": "allow" \| "deny" \| "ask" }` |

## Context

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.includeWorkspace` | boolean | `true` | Include workspace files in context |
| `sidecar.includeActiveFile` | boolean | `true` | Include the currently active file |
| `sidecar.filePatterns` | array | `["**/*.ts", ...]` | Glob patterns for workspace context (25+ languages) |
| `sidecar.maxFiles` | number | `10` | Max files to include in workspace context |

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
| `sidecar.verboseMode` | boolean | `false` | Show system prompt, iteration summaries, and tool selection context |
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
