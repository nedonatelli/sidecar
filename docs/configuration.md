---
title: Configuration
layout: docs
nav_order: 4
---

# Configuration

All settings are under the `sidecar.*` prefix. Open VS Code settings (`Cmd+,` / `Ctrl+,`) and search for "sidecar".

## Connection

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.baseUrl` | string | `http://localhost:11434` | API base URL. Ollama: `http://localhost:11434`, Anthropic: `https://api.anthropic.com`, LLMManager: `http://localhost:11435`, OpenAI-compatible: any URL |
| `sidecar.apiKey` | string | `ollama` | API key. Ignored for local Ollama, required for Anthropic, LLMManager, and some OpenAI-compatible servers |
| `sidecar.model` | string | `qwen3-coder:30b` | Model for chat (e.g., `qwen3-coder`, `claude-sonnet-4-6`, or any model on your server) |
| `sidecar.provider` | enum | `auto` | Backend provider: `auto`, `ollama`, `anthropic`, `openai`, `llmmanager`. Auto-detects from URL |
| `sidecar.systemPrompt` | string | `""` | Custom system prompt appended to the default |

### Provider auto-detection

When `sidecar.provider` is `auto` (default), SideCar detects the backend from the URL:

- **`localhost:11434`** → Ollama (native API)
- **`anthropic.com`** → Anthropic (Messages API with prompt caching)
- **`localhost:11435`** → LLMManager (OpenAI-compatible API)
- **Everything else** → OpenAI-compatible (`/v1/chat/completions`)

Set `sidecar.provider` explicitly if auto-detection doesn't match your setup — for example, if you're running an Anthropic-compatible proxy on a custom URL, or LLMManager on a non-standard port.

## Agent behavior

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.agentMode` | enum | `cautious` | Approval mode: `cautious`, `autonomous`, `manual` |
| `sidecar.agentTemperature` | number | `0.2` | Temperature for agent tool-calling requests. Lower values (0.1–0.3) produce more deterministic tool selection |
| `sidecar.agentMaxIterations` | number | `50` | Max agent loop iterations |
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
| `sidecar.contextLimit` | number | `0` | Override context token limit for local models (0 = auto-detect with 16K cap). Increase if you have enough VRAM for longer conversations |
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

## Large file & monorepo handling

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.workspaceRoots` | array | `[]` | Specific workspace roots to index (empty = all folders). Use for monorepos to focus on specific sub-projects |
| `sidecar.maxFileSizeBytes` | number | `102400` (100KB) | Maximum file size to fully read. Larger files get summaries first/last lines |
| `sidecar.streamingReadThreshold` | number | `51200` (50KB) | Files above this size use summary mode (head/tail lines) instead of full content |
| `sidecar.maxTraversalDepth` | number | `10` | Maximum directory nesting depth for context inclusion. Set lower for shallow indexing in large projects |
| `sidecar.enableLazyIndexing` | boolean | `true` | Defer indexing slow/large directories until explicitly needed |
| `sidecar.maxIndexedFiles` | number | `1000` | Maximum indexed files before lazy-loading remainder. Improves startup time in huge repos |

### Streaming reads

For large files exceeding `streamingReadThreshold`, SideCar automatically uses summary mode:
- Reads first N lines (default 50)
- Reads last M lines (default 30)
- Shows omitted line count in the middle

This keeps context focused on the structure and key parts of files without loading entire file content.

### Multi-root workspaces

Pin specific workspace roots for monorepo development:

```json
"sidecar.workspaceRoots": ["/path/to/repo/packages/core", "/path/to/repo/packages/ui"]
```

This is useful for:
- **Monorepos**: focus indexing on the sub-projects you're actively working on
- **Multi-root workspaces**: reduce context noise by excluding irrelevant projects
- **Large codebases**: improve startup time by indexing only relevant directories

If not set (default), SideCar indexes all workspace folders.

### Depth limiting

For deeply nested projects, limit traversal depth to prevent context bloat:

```json
"sidecar.maxTraversalDepth": 5
```

Files deeper than this level are excluded from workspace indexing, reducing noise in large projects with many nested directories.

### Ignoring patterns

Create a `.sidecarignore` file in your workspace root (same format as `.gitignore`):

```
# Ignore build artifacts
dist/
build/
.next/

# Ignore dependencies
node_modules/
venv/
```

Patterns from `.sidecarignore` are merged with default excludes (`.git`, `.sidecar`, `node_modules`, etc.).

## Auto-fix

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.autoFixOnFailure` | boolean | `false` | Auto-check diagnostics after edits and feed errors back to the model |
| `sidecar.autoFixMaxRetries` | number | `3` | Max auto-fix retry attempts |

When enabled, SideCar automatically runs VS Code's language diagnostics after the agent writes or edits a file. If errors are found, they're fed back to the model to self-correct — up to the configured retry limit.

## Spending budgets

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.dailyBudget` | number | `0` | Daily spending budget in USD. Agent runs are blocked when the limit is reached. Set to 0 to disable |
| `sidecar.weeklyBudget` | number | `0` | Weekly spending budget in USD. Agent runs are blocked when the limit is reached. Set to 0 to disable |

Set spending limits to prevent runaway costs when using paid APIs (Anthropic, OpenRouter). When a budget is active:

- At **80% usage**: a warning message appears in chat before the agent run starts
- At **100% usage**: the agent run is blocked with a message indicating which setting to adjust

Budget tracking uses the per-run cost estimates stored in metrics history. View current spending with the `/usage` command, which shows a Budget Status table with spent/limit/remaining for each active budget.

Budgets reset on calendar boundaries — daily at midnight local time, weekly on Monday midnight.

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
