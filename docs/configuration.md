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
| `sidecar.baseUrl` | string | `http://localhost:11434` | API base URL. Ollama: `http://localhost:11434`, Anthropic: `https://api.anthropic.com`, Kickstand: `http://localhost:11435`, OpenAI-compatible: any URL |
| `sidecar.apiKey` | string | `ollama` | API key. **Stored in VS Code SecretStorage** (see below). Ignored for local Ollama, required for Anthropic, Kickstand, and some OpenAI-compatible servers |
| `sidecar.model` | string | `qwen3-coder:30b` | Model for chat (e.g., `qwen3-coder`, `claude-sonnet-4-6`, or any model on your server) |
| `sidecar.provider` | enum | `auto` | Backend provider: `auto`, `ollama`, `anthropic`, `openai`, `kickstand`. Auto-detects from URL |
| `sidecar.systemPrompt` | string | `""` | Custom system prompt appended to the default |

### Provider auto-detection

When `sidecar.provider` is `auto` (default), SideCar detects the backend from the URL:

- **`localhost:11434`** → Ollama (native API)
- **`anthropic.com`** → Anthropic (Messages API with prompt caching)
- **`localhost:11435`** → Kickstand (OpenAI-compatible API)
- **Everything else** → OpenAI-compatible (`/v1/chat/completions`)

Set `sidecar.provider` explicitly if auto-detection doesn't match your setup — for example, if you're running an Anthropic-compatible proxy on a custom URL, or Kickstand on a non-standard port.

### API key storage (SecretStorage)

API keys are stored in **VS Code's SecretStorage**, not in plaintext `settings.json`. This applies to both `sidecar.apiKey` and `sidecar.fallbackApiKey`.

**Setting your key:**

Open the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run:

```
SideCar: Set API Key (SecretStorage)
```

A password input prompt appears. The value is stored encrypted in your OS keychain (macOS Keychain, Windows Credential Manager, or libsecret on Linux).

**Migration from plaintext:**

If you previously set `sidecar.apiKey` in `settings.json`, SideCar automatically migrates it to SecretStorage on first activation:

1. Reads the plaintext value from `settings.json`
2. Stores it in SecretStorage
3. Clears the plaintext value from `settings.json`

After migration, the setting in `settings.json` will be empty (or back to the default `"ollama"`), and the actual key lives in SecretStorage.

**Why this matters:**

- API keys never appear in `settings.json` — safer when sharing settings, dotfiles, or screenshots
- Per-machine isolation — settings sync won't push your keys to other devices
- Standard OS-level secret storage instead of plaintext on disk

The fallback API key (`sidecar.fallbackApiKey`) follows the same pattern but does not have a dedicated command — set it via `settings.json` once and it migrates automatically on the next activation.

## Agent behavior

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.agentMode` | string | `cautious` | Agent mode: `cautious`, `autonomous`, `manual`, `plan`, `review`, or a custom mode name from `sidecar.customModes`. See [Agent Mode → Approval modes](agent-mode#approval-modes) for the behavior of each |
| `sidecar.agentTemperature` | number | `0.2` | Temperature for agent tool-calling requests. Lower values (0.1–0.3) produce more deterministic tool selection |
| `sidecar.agentMaxIterations` | number | `25` | Max agent loop iterations |
| `sidecar.agentMaxTokens` | number | `100000` | Max tokens per agent run |
| `sidecar.requestTimeout` | number | `120` | Timeout in seconds for each LLM request. Aborts if no tokens arrive within this window. Set to 0 to disable |
| `sidecar.planMode` | boolean | `false` | Generate a plan for approval before executing tools |
| `sidecar.toolPermissions` | object | `{}` | Per-tool overrides: `{ "tool_name": "allow" \| "deny" \| "ask" }` |
| `sidecar.customModes` | array | `[]` | Custom agent modes with dedicated system prompts and approval behavior. See [Custom modes](agent-mode#custom-modes) |
| `sidecar.bgMaxConcurrent` | number | `3` | Maximum number of background agents that can run simultaneously (1–10) |

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

## Completion gate

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.completionGate.enabled` | boolean | `true` | Refuse to let the agent declare a turn done until lint and the colocated tests for edited files have actually run |

When enabled, SideCar tracks every `write_file` / `edit_file` call against every `run_tests` / `eslint` / `tsc` / `vitest` / `jest` / `pytest` / `npm test` invocation during the turn. At the natural termination point, if any edited source file has a colocated `.test.ts` / `.spec.ts` that wasn't exercised, or if lint never ran, the gate injects a synthetic user message into the loop demanding the checks before the turn can end. Capped at 2 injections per turn to prevent loops — after exhaustion the loop terminates with a warning rather than hanging.

This catches the failure mode where the model reports a change as "ready for use" without ever running the checks it claims pass. See [Agent Mode → Safety guardrails](agent-mode#safety-guardrails) for the full mechanism.

## Background doc sync

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.jsDocSync.enabled` | boolean | `true` | On save and open of any TS/JS file, flag orphan and missing JSDoc `@param` tags with quick fixes |
| `sidecar.readmeSync.enabled` | boolean | `true` | On save and open of `README.md` (and on save of any `src/` source file), flag fenced code-block calls whose argument count no longer matches the current workspace-exported function |

**JSDoc sync** scans the leading JSDoc block for every top-level `function` / arrow-const declaration and compares each `@param` entry against the signature. Orphan tags (tags with no matching parameter) and missing tags (parameters with no documentation) surface as warning diagnostics. Two quick fixes are offered per finding: "Remove orphan @param" and "Add missing @param" — both preserve the JSDoc block's indentation and `*` prefix. Functions with destructured or rest parameters are skipped.

**README sync** scans fenced `ts` / `tsx` / `js` / `jsx` / `typescript` / `javascript` code blocks in `README.md` for direct calls to workspace-exported functions. Exported functions are indexed from `src/**/*.{ts,tsx,js,jsx}` on activation and refreshed incrementally on file save / create / change / delete, so README drift surfaces immediately after you rename or change a function signature. Quick fix rewrites the call to match the signature: drops trailing arguments when there are too many, or appends the missing parameter names as placeholders when there are too few. Method calls (`obj.foo(...)`), constructor calls (`new Foo(...)`), and control-flow keywords (`if (x)`, `while (y)`) are excluded. Only single-line call expressions with no nested parens in their arguments are checked — nested or multi-line calls are silently skipped rather than mis-flagged.

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

Since v0.45.0, reasoning is rendered as a **numbered timeline**: each thinking block closes out when a tool call starts, producing discrete steps with purple pills (reasoning) or blue pills (tools) and a duration badge per step. Longer-running steps show elapsed time; sub-500ms steps hide the badge to reduce visual noise.

## Chat UI

Three settings control chat UI density, font size, and accent color. All three update live — changing them in Settings takes effect immediately without a reload.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.chatDensity` | string | `normal` | One of `compact`, `normal`, `comfortable`. Controls message padding and the gap between messages |
| `sidecar.chatFontSize` | number | `13` | Chat UI base font size in pixels (10–22) |
| `sidecar.chatAccentColor` | string | `""` | Override the chat accent color (user message bubble and step indicator pills). Accepts hex (`#ff6b6b`), `rgb()` / `rgba()`, `hsl()` / `hsla()`, or a small allowlist of named colors. Leave empty to inherit from the active VS Code theme |

Accent color values pass through an allowlist CSS-color validator before being written to the DOM as a custom property, so settings strings can't smuggle additional style declarations into the chat.

## Terminal error interception

SideCar watches the integrated terminal for commands that exit with a non-zero status. When it detects a failure it shows a **Diagnose in chat** notification; accepting injects a synthesized prompt containing the command, exit code, working directory, and the ANSI-stripped tail of the output, then runs the agent against the failure.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.terminalErrorInterception` | boolean | `true` | Enable automatic detection of failed terminal commands. Requires VS Code shell integration |

**Requirements:** VS Code 1.93+ with shell integration active. POSIX shells (bash, zsh, fish) and PowerShell are supported natively; other shells may need manual shell integration setup. When shell integration is unavailable the watcher silently no-ops — the setting itself is harmless.

**Dedup:** Identical command lines within a 30-second cooldown window fire only once, so a retry loop of `npm test` won't spam notifications.

**Ignored terminals:** SideCar's own `SideCar` terminal is always skipped to avoid feedback loops when the agent runs shell commands.

## Semantic Search

SideCar uses ONNX embeddings for semantic file search — queries like "authentication logic" find `src/auth/jwt.ts` even without keyword matches in the file path or conversation history.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.enableSemanticSearch` | boolean | `true` | Enable ONNX-based semantic file search. The embedding model (~23MB) downloads on first use |
| `sidecar.semanticSearchWeight` | number | `0.6` | Blend ratio between semantic and heuristic scoring (0 = keyword only, 1 = embeddings only). Default 0.6 weights embeddings higher |

The embedding model (all-MiniLM-L6-v2, 384-dimensional, quantized) loads in the background after the workspace is indexed. Until it's ready, SideCar falls back to keyword-based scoring. Embeddings are cached in `.sidecar/cache/embeddings.bin` and only recomputed when file content changes.

## RAG & Agent Memory

SideCar uses **Retrieval-Augmented Generation (RAG)** to inject relevant documentation into the agent's context, and **persistent memory** to track learned patterns across sessions.

### RAG Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.enableDocumentationRAG` | boolean | `true` | Enable documentation retrieval for every user message |
| `sidecar.ragMaxDocEntries` | number | `5` | Maximum number of documentation entries to inject per message (1-20) |
| `sidecar.ragUpdateIntervalMinutes` | number | `60` | Re-index documentation every N minutes (5-360). Set to `0` to disable auto-refresh |

Documentation is automatically discovered in:
- Project root: `README*`, `ARCHITECTURE*`, `DESIGN*`
- Directories: `docs/**`, `doc/**`, `wiki/**`
- All `.md` files in these locations are indexed and searchable

When a user sends a message, SideCar searches the indexed documentation for relevant sections using keyword matching. Matching entries are injected into the system prompt to improve accuracy.

**Example**: If you ask "how does authentication work?", and there's a `docs/AUTHENTICATION.md` with relevant content, it's automatically included in the context.

### Agent Memory Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.enableAgentMemory` | boolean | `true` | Enable persistent agent memory across sessions |
| `sidecar.agentMemoryMaxEntries` | number | `500` | Maximum number of memory entries to retain (10-500). Older entries are evicted when limit is reached |

Agent memory tracks:
- **Patterns**: Tools that work well for specific problem types
- **Decisions**: Coding conventions and architectural choices
- **Conventions**: Project-specific patterns and established practices

Memory is persisted to `.sidecar/memory/agent-memories.json` and automatically loaded when SideCar starts. Each memory entry includes:
- Timestamp of when it was learned
- Use count (incremented each time referenced)
- Category for organization

**Example**: After the agent successfully uses `formatAuthorName()` for a specific task, it's remembered. When a similar task is encountered later, the memory is retrieved and injected, improving consistency.

Memory is also recorded during agent runs whenever:
- A tool is successfully executed (success pattern recorded)
- New coding conventions are applied
- Project decisions are made

## Extensibility

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `sidecar.mcpServers` | object | `{}` | MCP server connections (stdio, HTTP, SSE). See [MCP Servers](mcp-servers) |
| `sidecar.hooks` | object | `{}` | Pre/post tool execution hooks. See [Hooks](hooks-and-tasks#tool-hooks) |
| `sidecar.eventHooks` | object | `{}` | Event-based hooks (`onSave`, `onCreate`, `onDelete`) |
| `sidecar.scheduledTasks` | array | `[]` | Recurring agent tasks. See [Scheduled Tasks](hooks-and-tasks#scheduled-tasks) |
| `sidecar.customTools` | array | `[]` | Custom shell command tools. See [Custom Tools](hooks-and-tasks#custom-tools) |
| `sidecar.customModes` | array | `[]` | Custom agent modes. See [Custom modes](agent-mode#custom-modes) |

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
