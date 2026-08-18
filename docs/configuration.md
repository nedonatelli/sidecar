---
title: Configuration
layout: docs
nav_order: 1
nav_section: 'Configuration'
---

# Configuration

All settings are under the `sidecar.*` prefix. Open VS Code settings (`Cmd+,` / `Ctrl+,`) and search for "sidecar".

## Connection

| Setting                | Type   | Default                  | Description                                                                                                                                                                               |
| ---------------------- | ------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.baseUrl`      | string | `http://localhost:11434` | API base URL. Ollama: `http://localhost:11434`, Anthropic: `https://api.anthropic.com`, OpenAI: `https://api.openai.com`, Kickstand: `http://localhost:11435`, OpenAI-compatible: any URL |
| `sidecar.apiKey`       | string | `ollama`                 | API key. **Stored in VS Code SecretStorage** (see below). Ignored for local Ollama, required for Anthropic, OpenAI, and some OpenAI-compatible servers                                    |
| `sidecar.model`        | string | `gemma4:e4b`             | Model for chat (e.g., `gemma4:e4b`, `ministral-3:latest`, `qwen3-coder:30b`, `claude-sonnet-4-6`, or any model on your server)                                                            |
| `sidecar.provider`     | enum   | `auto`                   | Backend provider: `auto`, `ollama`, `anthropic`, `openai`, `kickstand`, `openrouter`, `groq`, `fireworks`, `gemini`, `copilot`, `bedrock`. Auto-detects from URL                          |
| `sidecar.systemPrompt` | string | `""`                     | Custom system prompt appended to the default                                                                                                                                              |

### Switching backends (recommended)

You don't have to edit these settings by hand. Click the **⚙ gear** in the chat header and pick a backend from the **Backend** section of the settings menu — SideCar's built-in profiles flip `baseUrl`, `provider`, and `model` in one click:

| Profile          | Provider     | Base URL                                           | Default model                                                                   |
| ---------------- | ------------ | -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Local Ollama     | `ollama`     | `http://localhost:11434`                           | `gemma4:e4b`                                                                    |
| Anthropic Claude | `anthropic`  | `https://api.anthropic.com`                        | `claude-haiku-4-5`                                                              |
| OpenAI           | `openai`     | `https://api.openai.com`                           | `gpt-4o`                                                                        |
| OpenRouter       | `openrouter` | `https://openrouter.ai/api/v1`                     | `anthropic/claude-sonnet-4.5`                                                   |
| Groq             | `groq`       | `https://api.groq.com/openai/v1`                   | `llama-3.3-70b-versatile`                                                       |
| Fireworks        | `fireworks`  | `https://api.fireworks.ai/inference/v1`            | `qwen2p5-coder-32b-instruct`                                                    |
| Kickstand        | `kickstand`  | `http://localhost:11435`                           | Token auto-loaded from `~/.config/kickstand/token` — no key prompt              |
| AWS Bedrock      | `bedrock`    | `https://bedrock-runtime.us-east-1.amazonaws.com`  | `us.anthropic.claude-sonnet-4-20250514-v1:0` (AWS credential chain, no API key) |
| Google Gemini    | `gemini`     | `https://generativelanguage.googleapis.com/openai` | `gemini-2.0-flash`                                                              |
| GitHub Copilot   | `copilot`    | `vscode://github.copilot`                          | `gpt-4o` (uses your Copilot subscription — no API key)                          |

Each profile stores its API key in its own SecretStorage slot (`sidecar.profileKey.<id>`), so switching between profiles preserves keys you've already entered — setting your Anthropic key once won't clobber your OpenAI key, and vice versa. The currently active profile is checkmarked in the menu. The same flow is available from the Command Palette as `SideCar: Switch Backend`.

On first switch to a profile that needs a key, SideCar will surface a warning with a "Set API Key" button that chains into the standard `SideCar: Set API Key` flow — the key is stored under the correct profile slot automatically.

For custom setups (non-standard ports, Anthropic-compatible proxies, etc.) the settings table above is still the right path — the profile switcher only covers the built-in providers.

### Provider auto-detection

When `sidecar.provider` is `auto` (default), SideCar detects the backend from the URL:

- **`localhost:11434`** → Ollama (native API)
- **`anthropic.com`** → Anthropic (Messages API with prompt caching)
- **`localhost:11435`** → Kickstand — reads bearer token from `~/.config/kickstand/token` automatically
- **`openrouter.ai`** → OpenRouter · **`groq.com`** → Groq · **`fireworks.ai`** → Fireworks · **`generativelanguage.googleapis.com`** → Gemini · **`bedrock-runtime.*.amazonaws.com`** → AWS Bedrock
- **Everything else** → OpenAI-compatible (`/v1/chat/completions`)

Set `sidecar.provider` explicitly if auto-detection doesn't match your setup — for example, if you're running an Anthropic-compatible proxy on a custom URL, or a local Kickstand dev build on a non-standard port.

### API key storage (SecretStorage)

API keys are stored in **VS Code's SecretStorage**, not in plaintext `settings.json`. This applies to both `sidecar.apiKey` and `sidecar.fallbackApiKey`.

**Setting or refreshing your key:**

Three equivalent ways to set or rotate your key:

1. Open the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) and run `SideCar: Set / Refresh API Key`.
2. Click the `$(key)` icon in the chat view's title bar.
3. Let a native error toast prompt you — when an auth error fires, the `Set API Key` action button on the toast runs the same flow.

A password input prompt appears. Values are trimmed of whitespace on save (defense-in-depth trim also fires at the `AnthropicBackend` constructor, in case an existing stored key has a stray newline from an earlier paste). Empty input is rejected with a warning. The value is stored encrypted in your OS keychain (macOS Keychain, Windows Credential Manager, or libsecret on Linux). After saving, SideCar automatically refreshes the model list so the UI recovers from any "Cannot connect" error state without requiring a window reload.

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

## Multi-file Edit Planning (v0.111+)

When an agent task touches 3 or more files, SideCar generates an `EditPlan` manifest before writing anything. The plan lists every file, operation (`create` / `edit` / `delete`), rationale, and dependency edges. A collapsible **Planned edits** card appears in chat so you see the full scope before execution begins.

| Setting                                  | Type   | Default | Description                                                                                                                                              |
| ---------------------------------------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.multiFileEdits.minFilesForPlan` | number | `3`     | Minimum number of files in a batch before the planner pass fires. Set to `1` to always plan; `0` to disable planning                                     |
| `sidecar.multiFileEdits.maxParallel`     | number | `8`     | Maximum files written in parallel within a DAG layer. Independent files stream simultaneously; files with `dependsOn` edges wait for their prerequisites |
| `sidecar.multiFileEdits.plannerModel`    | string | `""`    | Model used for the structured planning pass (empty = use the main chat model). Use a smaller/faster model to reduce planning overhead                    |

Add `@no-plan` anywhere in your prompt to skip the planner for that request.

| Setting                                    | Type    | Default      | Description                                                                                                                                                                                             |
| ------------------------------------------ | ------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.multiFileEdits.enabled`           | boolean | `true`       | Master toggle for multi-file edit streams. When `false`, the agent writes files sequentially without a plan card.                                                                                       |
| `sidecar.multiFileEdits.planningPass`      | boolean | `true`       | Run a dedicated Edit Plan LLM turn before executing writes. Adds one extra LLM call but produces the plan card and enables per-file cancel. Set `false` to skip planning and stream writes immediately. |
| `sidecar.multiFileEdits.reviewGranularity` | string  | `"per-file"` | How the Pending Changes panel presents the batch. `"per-file"` = accept/reject each file individually; `"bulk"` = Accept All / Reject All only.                                                         |

Each file in the planned-edits card has a **cancel button** — clicking it aborts that file's write mid-stream without affecting other in-flight files. Use **Accept All** or **Reject All** in the card to apply or discard the entire batch atomically.

## Agent behavior

| Setting                      | Type   | Default    | Description                                                                                                                                                                                               |
| ---------------------------- | ------ | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.agentMode`          | string | `cautious` | Agent mode: `cautious`, `autonomous`, `manual`, `plan`, `review`, or a custom mode name from `sidecar.customModes`. See [Agent Mode → Approval modes](agent-mode#approval-modes) for the behavior of each |
| `sidecar.agentTemperature`   | number | `0.2`      | Temperature for agent tool-calling requests. Lower values (0.1–0.3) produce more deterministic tool selection                                                                                             |
| `sidecar.agentMaxIterations` | number | `50`       | Max agent loop iterations                                                                                                                                                                                 |
| `sidecar.agentMaxTokens`     | number | `200000`   | Max tokens per agent run                                                                                                                                                                                  |
| `sidecar.requestTimeout`     | number | `120`      | Timeout in seconds for each LLM request. Aborts if no tokens arrive within this window. Set to 0 to disable                                                                                               |
| `sidecar.toolPermissions`    | object | `{}`       | Per-tool overrides: `{ "tool_name": "allow" \| "deny" \| "ask" }`                                                                                                                                         |
| `sidecar.customModes`        | array  | `[]`       | Custom agent modes with dedicated system prompts and approval behavior. See [Custom modes](agent-mode#custom-modes)                                                                                       |
| `sidecar.bgMaxConcurrent`    | number | `3`        | Maximum number of background agents that can run simultaneously (1–10)                                                                                                                                    |

## Model Management

### Editor model

| Setting               | Type   | Default | Description                                                                                                                                                                                             |
| --------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.editorModel` | string | `""`    | Secondary model for agent execution turns. When set, planning turns (no prior tool calls) use `sidecar.model`; execution turns (following tool calls) use this model. Leave empty to disable the split. |

Set `sidecar.editorModel` to a cheaper/faster model (e.g. `claude-haiku-4-5`) to reduce cost on long agent runs without sacrificing planning quality.

### Fallback backend

| Setting                   | Type   | Default | Description                                                                                                             |
| ------------------------- | ------ | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `sidecar.fallbackBaseUrl` | string | `""`    | URL of a fallback backend. SideCar switches here automatically after repeated primary failures. Leave empty to disable. |
| `sidecar.fallbackApiKey`  | string | `""`    | API key for the fallback backend. Stored in VS Code SecretStorage.                                                      |
| `sidecar.fallbackModel`   | string | `""`    | Model to use on the fallback backend. Empty = reuse the primary model name.                                             |

Typical setup: primary = Anthropic, fallback = local Ollama, so API outages don't block work. SideCar switches back to the primary automatically once it recovers.

### Model routing

| Setting                             | Type    | Default | Description                                                                                                                                                                          |
| ----------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidecar.modelRouting.enabled`      | boolean | `false` | Enable role-based routing. When `false`, every dispatch role uses `sidecar.model`.                                                                                                   |
| `sidecar.modelRouting.rules`        | array   | `[]`    | Ordered routing rules. Each rule has a `when` expression, a `model`, and optional `fallbackModel` plus per-rule budget caps (`sessionBudget`, `dailyBudget`, `hourlyBudget` in USD). |
| `sidecar.modelRouting.defaultModel` | string  | `""`    | Model used when no rule matches. Empty falls back to `sidecar.model`.                                                                                                                |
| `sidecar.modelRouting.dryRun`       | boolean | `false` | Log routing decisions without applying them — calibrate rules before enabling.                                                                                                       |
| `sidecar.modelRouting.visibleSwaps` | boolean | `true`  | Show a toast whenever a routing rule swaps the active model mid-session.                                                                                                             |

Rule `when` expressions support role names (`agent-loop`, `chat`, `summarize`, `completion`, `planner`), attribute comparisons (`agent-loop.complexity=high`), prompt regex (`chat.prompt~=/proof/i`), and file glob (`agent-loop.files~=src/physics/**`). Budget caps trigger an automatic downgrade to `fallbackModel`.

### Thinking mode

| Setting                 | Type   | Default    | Description                                                                                                                                                                                                    |
| ----------------------- | ------ | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.thinking.mode` | string | `"single"` | Thinking visualization mode for models with extended thinking. Values: `"single"` (default), `"self-debate"` (pros/cons framing), `"tree-of-thought"` (possibility tree), `"red-team"` (adversarial critique). |

### SteerQueue and message limits

| Setting                               | Type   | Default | Description                                                                                                                                      |
| ------------------------------------- | ------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidecar.steerQueue.coalesceWindowMs` | number | `2000`  | Milliseconds to wait at an iteration boundary before draining pending steers, coalescing rapid follow-ups into one turn. `0` drains immediately. |
| `sidecar.steerQueue.maxPending`       | number | `5`     | Maximum queued steers. When full, the oldest nudge is evicted; an all-interrupt queue rejects new submissions with an explicit error.            |
| `sidecar.agentMaxMessages`            | number | `25`    | Soft ceiling on conversation message count before the agent wraps up.                                                                            |
| `sidecar.firstTokenTimeout`           | number | `300`   | Seconds to wait for the first token from the model. Local models loading from disk may need the full window. Set to `0` to disable.              |

## Context

| Setting                     | Type    | Default            | Description                                                                                                                                                                                      |
| --------------------------- | ------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidecar.includeWorkspace`  | boolean | `true`             | Include workspace files in context                                                                                                                                                               |
| `sidecar.includeActiveFile` | boolean | `true`             | Include the currently active file                                                                                                                                                                |
| `sidecar.filePatterns`      | array   | `["**/*.ts", ...]` | Glob patterns for workspace context (25+ languages)                                                                                                                                              |
| `sidecar.maxFiles`          | number  | `10`               | Max files to include in workspace context                                                                                                                                                        |
| `sidecar.contextLimit`      | number  | `0`                | Override context token limit for local models. `0` = auto-detect — uses the value Ollama reports, capped at 128K. Set explicitly (e.g. `32768`) to reduce KV-cache pressure on low-VRAM machines |
| `sidecar.pinnedContext`     | array   | `[]`               | Files or folders always included in context (relative paths)                                                                                                                                     |
| `sidecar.fetchUrlContext`   | boolean | `true`             | Auto-fetch web page content when URLs are pasted in chat                                                                                                                                         |

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

| Setting                          | Type    | Default          | Description                                                                                                  |
| -------------------------------- | ------- | ---------------- | ------------------------------------------------------------------------------------------------------------ |
| `sidecar.workspaceRoots`         | array   | `[]`             | Specific workspace roots to index (empty = all folders). Use for monorepos to focus on specific sub-projects |
| `sidecar.maxFileSizeBytes`       | number  | `102400` (100KB) | Maximum file size to fully read. Larger files get summaries first/last lines                                 |
| `sidecar.streamingReadThreshold` | number  | `51200` (50KB)   | Files above this size use summary mode (head/tail lines) instead of full content                             |
| `sidecar.maxTraversalDepth`      | number  | `10`             | Maximum directory nesting depth for context inclusion. Set lower for shallow indexing in large projects      |
| `sidecar.enableLazyIndexing`     | boolean | `true`           | Defer indexing slow/large directories until explicitly needed                                                |
| `sidecar.maxIndexedFiles`        | number  | `1000`           | Maximum indexed files before lazy-loading remainder. Improves startup time in huge repos                     |

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

| Setting                     | Type    | Default | Description                                                          |
| --------------------------- | ------- | ------- | -------------------------------------------------------------------- |
| `sidecar.autoFixOnFailure`  | boolean | `false` | Auto-check diagnostics after edits and feed errors back to the model |
| `sidecar.autoFixMaxRetries` | number  | `3`     | Max auto-fix retry attempts                                          |

When enabled, SideCar automatically runs VS Code's language diagnostics after the agent writes or edits a file. If errors are found, they're fed back to the model to self-correct — up to the configured retry limit.

## Reactive Diagnostics Fix (v0.71+)

| Setting                                     | Type    | Default   | Description                                                                                    |
| ------------------------------------------- | ------- | --------- | ---------------------------------------------------------------------------------------------- |
| `sidecar.diagnostics.reactiveFixEnabled`    | boolean | `false`   | Automatically propose fixes for new VS Code diagnostics as they appear in the Problems panel.  |
| `sidecar.diagnostics.reactiveFixSeverity`   | string  | `"error"` | Minimum severity to trigger a fix. `"error"` = errors only; `"warning"` = errors and warnings. |
| `sidecar.diagnostics.reactiveFixDebounceMs` | number  | `2000`    | Milliseconds to wait after a diagnostic appears before firing, to avoid triggering mid-edit.   |

## On-demand analysis for `get_diagnostics`

| Setting                                | Type   | Default | Description                                                                              |
| -------------------------------------- | ------ | ------- | ---------------------------------------------------------------------------------------- |
| `sidecar.diagnostics.analysisBudgetMs` | number | `5000`  | How long `get_diagnostics` waits for a language server to analyze the file it was given. |

VS Code only reports diagnostics for files a language server has open, so a file the agent just wrote to disk has none — `get_diagnostics` used to return "No diagnostics" for exactly the case it exists to serve. It now opens the file in a **preview tab that does not take focus**, waits for the analysis, and closes the tab again. Nothing is saved and no editor is left dirty; the visible cost is a tab that briefly appears.

Set to `0` to skip this entirely and read only what is already cached — invisible and instant, but usually empty for files you have not opened yourself.

Note that an empty result is never reported as proof a file is clean, whatever the budget: an analysis that has not finished is indistinguishable from one that found nothing. Use `run_command` with your type-checker, or `run_tests`, to verify a change.

## Completion gate

| Setting                                      | Type    | Default | Description                                                                                                                                                                                                                            |
| -------------------------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.completionGate.enabled`             | boolean | `true`  | Refuse to let the agent declare a turn done until lint and the colocated tests for edited files have actually run                                                                                                                      |
| `sidecar.behavioralVerificationGate.enabled` | boolean | `false` | Reprompt for a real test when the agent edits behavioral code without one. Off by default — on local models it tends to push a correct fix into writing extra, often broken, test files (same over-edit pattern as the removed critic) |
| `sidecar.syntaxGate.enabled`                 | boolean | `true`  | Refuse to finish (and break a cycle bail) while an edited file fails to parse. On by default; requires the completion gate. Disable to run the loop without deterministic syntax verification                                          |
| `sidecar.redCheckGate.enabled`               | boolean | `true`  | Refuse to finish while the agent's own last verification (test/lint/compile) is still failing. On by default; requires the completion gate. The verification-forcing lever — independently toggleable to study lift vs over-editing    |

When enabled, SideCar tracks every `write_file` / `edit_file` call against every `run_tests` / `eslint` / `tsc` / `vitest` / `jest` / `pytest` / `npm test` invocation during the turn. At the natural termination point, if any edited source file has a colocated `.test.ts` / `.spec.ts` that wasn't exercised, or if lint never ran, the gate injects a synthetic user message into the loop demanding the checks before the turn can end. Capped at 2 injections per turn to prevent loops — after exhaustion the loop terminates with a warning rather than hanging.

This catches the failure mode where the model reports a change as "ready for use" without ever running the checks it claims pass. See [Agent Mode → Safety guardrails](agent-mode#safety-guardrails) for the full mechanism.

## Regression Guards (v0.107+)

Shell-command guards wired into the agent loop via `RegressionGuardHook`. Guards run after relevant tool calls and block the turn with a reprompt when they fail, preventing the agent from declaring a task done while regressions exist.

| Setting                         | Type  | Default    | Description                                                                                         |
| ------------------------------- | ----- | ---------- | --------------------------------------------------------------------------------------------------- |
| `sidecar.regressionGuards`      | array | `[]`       | List of guard configs. Each has `name`, `command`, `trigger`, `mode`, `scope`, and `maxAttempts`    |
| `sidecar.regressionGuards.mode` | enum  | `"strict"` | Global override: `strict` (block on failure), `warn` (log but continue), `off` (disable all guards) |

### Guard config schema

```json
"sidecar.regressionGuards": [
  {
    "name": "lint",
    "command": "npm run lint",
    "trigger": "post-write",
    "mode": "blocking",
    "scope": ["src/**/*.ts"],
    "maxAttempts": 5
  }
]
```

- **`trigger`**: `"post-write"` (after any file write), `"post-turn"` (at turn end), or `"pre-completion"` (before the agent declares done)
- **`mode`**: `"blocking"` (failure halts the turn with a reprompt) or `"advisory"` (logged but non-blocking)
- **`scope`**: glob array — guard only fires when an edited file matches. Empty = always fires.
- **`maxAttempts`** (default `5`) — guard retries cap with exponential backoff; after exhaustion the turn terminates with a warning.

### Built-in guards

Three ecosystem-aware guards are available without configuration. Enable them per-skill via `guards:` frontmatter — see [Extending SideCar — Skills](extending-sidecar#skills).

| Guard          | Trigger command                             | Ecosystem     |
| -------------- | ------------------------------------------- | ------------- |
| `lint-clean`   | `npm run lint` / `cargo clippy` / `flake8`  | auto-detected |
| `tests-pass`   | `npm test` / `cargo test` / `pytest`        | auto-detected |
| `no-new-todos` | grep for new `TODO`/`FIXME` in edited files | any           |

Use `/guards` in chat to list active guards and the built-in catalog.

## Background doc sync

| Setting                      | Type    | Default | Description                                                                                                                                                                          |
| ---------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidecar.jsDocSync.enabled`  | boolean | `true`  | On save and open of any TS/JS file, flag orphan and missing JSDoc `@param` tags with quick fixes                                                                                     |
| `sidecar.readmeSync.enabled` | boolean | `true`  | On save and open of `README.md` (and on save of any `src/` source file), flag fenced code-block calls whose argument count no longer matches the current workspace-exported function |

**JSDoc sync** scans the leading JSDoc block for every top-level `function` / arrow-const declaration and compares each `@param` entry against the signature. Orphan tags (tags with no matching parameter) and missing tags (parameters with no documentation) surface as warning diagnostics. Two quick fixes are offered per finding: "Remove orphan @param" and "Add missing @param" — both preserve the JSDoc block's indentation and `*` prefix. Functions with destructured or rest parameters are skipped.

**README sync** scans fenced `ts` / `tsx` / `js` / `jsx` / `typescript` / `javascript` code blocks in `README.md` for direct calls to workspace-exported functions. Exported functions are indexed from `src/**/*.{ts,tsx,js,jsx}` on activation and refreshed incrementally on file save / create / change / delete, so README drift surfaces immediately after you rename or change a function signature. Quick fix rewrites the call to match the signature: drops trailing arguments when there are too many, or appends the missing parameter names as placeholders when there are too few. Method calls (`obj.foo(...)`), constructor calls (`new Foo(...)`), and control-flow keywords (`if (x)`, `while (y)`) are excluded. Only single-line call expressions with no nested parens in their arguments are checked — nested or multi-line calls are silently skipped rather than mis-flagged.

## Spending budgets

| Setting                | Type   | Default | Description                                                                                          |
| ---------------------- | ------ | ------- | ---------------------------------------------------------------------------------------------------- |
| `sidecar.dailyBudget`  | number | `0`     | Daily spending budget in USD. Agent runs are blocked when the limit is reached. Set to 0 to disable  |
| `sidecar.weeklyBudget` | number | `0`     | Weekly spending budget in USD. Agent runs are blocked when the limit is reached. Set to 0 to disable |

Set spending limits to prevent runaway costs when using paid APIs (Anthropic, OpenRouter). When a budget is active:

- At **80% usage**: a warning message appears in chat before the agent run starts
- At **100% usage**: the agent run is blocked with a message indicating which setting to adjust

Budget tracking uses the per-run cost estimates stored in metrics history. View current spending with the `/usage` command, which shows a Budget Status table with spent/limit/remaining for each active budget.

Budgets reset on calendar boundaries — daily at midnight local time, weekly on Monday midnight.

## Cost controls (paid backends)

Four additional settings that pair with the spending budgets above to drive down the cost of agent runs on Anthropic / OpenAI. See the **Cost controls** section in the README for the full rationale.

| Setting                                     | Type    | Default                  | Description                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------- | ------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.promptPruning.enabled`             | boolean | `true`                   | Prune prompts before sending to paid backends. Collapses whitespace, head+tail truncates oversized tool results, and dedupes repeated file content. Safe for agent loops — only lossy on tool output, never on user or assistant messages                                                                            |
| `sidecar.promptPruning.maxToolResultTokens` | number  | `4000`                   | Maximum token count for any single `tool_result` block sent to a paid backend. Longer results are head+tail truncated with an elision marker. Raise this for frontier models with large context windows; lower it to reduce cost on exploration-heavy tasks. Clamped to `[200, 20000]`                               |
| `sidecar.localToolTrim.enabled`             | boolean | `true`                   | For local models (Ollama/Kickstand), send only the core coding tools (read/edit/search/run/diagnostics) at full schema and compact the rest to one-line stubs the model expands with `describe_tool`. Cuts ~2.5K tokens of tool schema per turn and gives small models a clearer choice. No effect on cloud backends |
| `sidecar.editFile.resultDiffChars`          | number  | `800`                    | After a successful `edit_file`, append a bounded diff (capped at this many chars) of what actually changed, so the model can self-verify the outcome instead of only seeing `File edited: <path>`. Helps weak local models catch wrong-but-applied edits. `0` disables                                               |
| `sidecar.delegateTask.enabled`              | boolean | `true`                   | Expose the `delegate_task` tool to paid backends. The orchestrator can offload read-only research to a local Ollama worker and receive a compact summary. No-op on local-only setups                                                                                                                                 |
| `sidecar.delegateTask.workerModel`          | string  | `""`                     | Ollama model used by the `delegate_task` worker. Empty = reuse the chat model. Recommended: a code-tuned model like `qwen3-coder:30b` or `deepseek-coder:33b`                                                                                                                                                        |
| `sidecar.delegateTask.maxIterations`        | number  | `10`                     | Maximum agent loop iterations for a delegated worker task.                                                                                                                                                                                                                                                           |
| `sidecar.delegateTask.workerBaseUrl`        | string  | `http://localhost:11434` | Base URL of the Ollama instance the worker connects to. Must be local or reachable — not an Anthropic / OpenAI URL                                                                                                                                                                                                   |

**Session spend tracker** is not a setting — it's always on for Anthropic requests when they return usage data. The `$(credit-card) $0.12` status bar item shows up the moment a paid backend incurs cost. Click it for a per-model breakdown. Manage via:

- `SideCar: Show Session Spend` — QuickPick with totals, request counts, and per-model token breakdown
- `SideCar: Reset Session Spend` — clear the tally (does not affect the Anthropic-side totals in their Console)

The price table is a hardcoded best-effort at list prices for Claude Opus 4.6/4.5, Sonnet 4.6/4.5, Haiku 4.5, and the 3.x fallbacks. Enterprise and committed-spend discounts are **not** reflected. Use the Anthropic Console for authoritative monthly totals.

## Inline completions

| Setting                           | Type    | Default | Description                                    |
| --------------------------------- | ------- | ------- | ---------------------------------------------- |
| `sidecar.enableInlineCompletions` | boolean | `false` | Enable Copilot-like autocomplete               |
| `sidecar.completionModel`         | string  | `""`    | Model for completions (empty = use chat model) |
| `sidecar.completionMaxTokens`     | number  | `256`   | Max tokens per completion                      |
| `sidecar.completionDebounceMs`    | number  | `300`   | Minimum ms between completion requests         |

### Speculative decoding (v0.110+)

When enabled, a smaller draft model proposes tokens that the main model verifies in parallel — delivering main-model quality at draft-model latency.

| Setting                                                  | Type    | Default | Description                                                                                                          |
| -------------------------------------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `sidecar.speculativeDecoding.enabled`                    | boolean | `true`  | Enable speculative FIM decoding. Auto-disabled if the backend doesn't support a draft model                          |
| `sidecar.completionDraftModel`                           | string  | `""`    | Draft model (e.g. `qwen2.5-coder:0.5b`). Empty = auto-discover the smallest available model on the active backend    |
| `sidecar.speculativeDecoding.lookahead`                  | number  | `4`     | Draft tokens proposed per cycle. Higher = faster on cache hits, more wasted work on misses. Clamped 1–16             |
| `sidecar.speculativeDecoding.temperature`                | number  | `0.0`   | Draft model temperature (`0` = greedy, fastest)                                                                      |
| `sidecar.speculativeDecoding.minAcceptRateToKeepEnabled` | number  | `0.4`   | If the rolling accept rate drops below this threshold, speculative decoding auto-disables for the session. Range 0–1 |

## Kickstand Advanced Settings (v0.109+)

Settings specific to the [Kickstand](https://github.com/nedonatelli/kickstand) self-hosted backend. Ignored when using Ollama, Anthropic, or other providers.

### RoPE / YaRN long-context scaling

Extend a model's native context window by tuning its positional-encoding parameters at load time.

| Setting                           | Type   | Default | Description                                                                                                                                                                                        |
| --------------------------------- | ------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.kickstand.nCtx`          | number | `32768` | Context window size (`n_ctx`) passed to Kickstand when loading a model. Increase for longer conversations; decrease to reduce VRAM usage. Ignored when using the RoPE/YaRN `yarnOrigCtx` override. |
| `sidecar.kickstand.ropeFreqBase`  | number | `0`     | RoPE base frequency override. `0` = model default. Example: `500000` for Llama 3.1 128K extension                                                                                                  |
| `sidecar.kickstand.ropeFreqScale` | number | `0`     | RoPE frequency scaling factor. `0` = model default. Example: `0.5` for a generic 2× context extension                                                                                              |
| `sidecar.kickstand.yarnExtFactor` | number | `-1`    | YaRN extrapolation factor. `-1` leaves llama.cpp's built-in YaRN default intact                                                                                                                    |
| `sidecar.kickstand.yarnOrigCtx`   | number | `0`     | Original training context length for YaRN scaling. `0` = model default                                                                                                                             |

**Example — Llama 3.1 with 128K context:**

```json
"sidecar.kickstand.ropeFreqBase": 500000
```

### Flash Attention

| Setting                       | Type    | Default | Description                                                                                                           |
| ----------------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `sidecar.kickstand.flashAttn` | boolean | `false` | Enable Flash Attention. 2–4× speedup on long contexts with Metal (macOS) or CUDA. Silently ignored on CPU-only builds |

All Kickstand settings are preserved across Kickstand auto-restarts.

## Adaptive Paste (v0.72+)

When you paste foreign content into a file, SideCar detects the content type and offers a lightbulb code action to transform it to fit the target language. Detection is heuristic (no LLM call until you confirm). Built-in transforms include JSON → TypeScript type, SQL → ORM query, curl → `fetch()`, CSS → Tailwind, Python → TypeScript, shell → `child_process`, `.env` → Zod schema.

| Setting                                | Type    | Default | Description                                                                                                                                          |
| -------------------------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.adaptivePaste.enabled`        | boolean | `true`  | Enable Adaptive Paste. When disabled, no paste tracking or lightbulb actions are registered.                                                         |
| `sidecar.adaptivePaste.autoDetect`     | boolean | `true`  | Automatically detect paste events via document change tracking. When `false`, only the explicit `Transform Paste with SideCar` command is available. |
| `sidecar.adaptivePaste.minPasteLength` | number  | `50`    | Minimum character count for an insertion to be treated as a paste. Prevents the tracker from firing on short typed snippets.                         |
| `sidecar.adaptivePaste.model`          | string  | `""`    | Model override for paste transformations. Empty = use the chat model.                                                                                |

## Next Edit Suggestions (v0.72+)

After you edit a symbol, SideCar walks the symbol graph to find callers and dependents that may also need updating. Candidates appear as ghost-text badge decorations (①②③) at the relevant lines; cross-file hits show in the status bar. Use `Tab` / `Alt+↓` / `Alt+↑` / `Esc` to accept, navigate, and dismiss.

| Setting                              | Type    | Default | Description                                                                                          |
| ------------------------------------ | ------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `sidecar.nextEdit.enabled`           | boolean | `false` | Enable Next Edit Suggestions.                                                                        |
| `sidecar.nextEdit.model`             | string  | `""`    | Model override for next-edit scoring. Empty = use the chat model.                                    |
| `sidecar.nextEdit.debounceMs`        | number  | `600`   | Delay in milliseconds after a document change before the analyser runs.                              |
| `sidecar.nextEdit.crossFileEnabled`  | boolean | `true`  | Include suggestions in files other than the one being edited.                                        |
| `sidecar.nextEdit.maxHops`           | number  | `2`     | Symbol graph hops to walk. `1` = direct callers only; `2` = also files that import the changed file. |
| `sidecar.nextEdit.topK`              | number  | `3`     | Maximum suggestions to surface at once (1–9).                                                        |
| `sidecar.nextEdit.autoTriggerOnSave` | boolean | `false` | Also run the analyser on file save, in addition to debounced keystroke triggers.                     |

## Shell execution

| Setting                                               | Type    | Default           | Description                                                                                                                                                                                                                                                          |
| ----------------------------------------------------- | ------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.shellTimeout`                                | number  | `120`             | Default timeout for shell commands in seconds                                                                                                                                                                                                                        |
| `sidecar.shellMaxOutputMB`                            | number  | `0`               | Hard ceiling on captured shell output, in MB. `0` (default) auto-bounds capture near the model's context budget — the prompt pruner keeps only ~16KB of any tool result, so capturing megabytes just wastes memory. Set a positive value to force a fixed MB ceiling |
| `sidecar.terminalExecution.enabled`                   | boolean | `true`            | Route `run_command` / `run_tests` through VS Code's shell-integration API in a dedicated _SideCar Agent_ terminal. Set to `false` to keep all agent commands on the hidden `ShellSession` path                                                                       |
| `sidecar.terminalExecution.terminalName`              | string  | `"SideCar Agent"` | Display name for the reusable agent terminal                                                                                                                                                                                                                         |
| `sidecar.terminalExecution.fallbackToChildProcess`    | boolean | `true`            | When shell integration is unavailable (bare shell without the init script, older VS Code), fall back to the `ShellSession` / `child_process` path. Set `false` to fail loudly instead                                                                                |
| `sidecar.terminalExecution.shellIntegrationTimeoutMs` | number  | `2000`            | Milliseconds to wait for shell integration to attach to a freshly created terminal before falling back                                                                                                                                                               |

Since v0.59, agent shell commands (`run_command`, `run_tests`) render **live in a reusable _SideCar Agent_ terminal** via VS Code's shell-integration API rather than in a hidden subprocess. Benefits: transparency (you see exactly what the agent runs), SSH / Dev Container / WSL / Codespaces correctness (shell integration inherits VS Code's remote shell session instead of escaping to the host), and proper exit-code capture. If shell integration isn't available on your shell, the `ShellSession` fallback kicks in automatically — it's a **persistent shell session** with environment variables, cwd, and aliases persisting between tool calls. Set a longer timeout for builds and installs. Use `background: true` to start long-running processes and check on them later with `command_id`.

## Shadow Workspaces (v0.59+)

Optional sandbox for agent tasks. When enabled, the agent runs in an ephemeral git worktree at `.sidecar/shadows/<task-id>/` off the current `HEAD` — writes never touch your main working tree until you accept the resulting diff.

| Setting                                          | Type    | Default           | Description                                                                                                                                                                                              |
| ------------------------------------------------ | ------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.shadowWorkspace.mode`                   | enum    | `"off"`           | `off` disabled; `opt-in` only wraps tasks that explicitly opt in; `always` wraps every agent task                                                                                                        |
| `sidecar.shadowWorkspace.autoCleanup`            | boolean | `true`            | Remove the shadow worktree + directory after every task. Set `false` to preserve rejected/failed shadows at `.sidecar/shadows/<task-id>/` for post-mortem inspection                                     |
| `sidecar.shadowWorkspace.sweepStaleOnActivation` | boolean | `true`            | On activation, remove shadow worktrees under `.sidecar/shadows/` that have no corresponding agent session (e.g. from a crashed VS Code). Keeps the worktree list clean without requiring manual cleanup. |
| `sidecar.shadowWorkspace.gateCommand`            | string  | `"npm run check"` | Shell command to run inside the shadow before the accept/reject prompt opens. **Not yet wired in v0.59 — lands in v0.60.** Override for non-JS projects (e.g. `"cargo check && cargo test"`)             |

At task completion, SideCar shows a `showQuickPick` with the diff summary (file count, line count) and an Accept / Reject choice. Accept applies the diff to main as staged changes (so you see them in `git status`). Reject discards the shadow and leaves your main tree untouched. The v0.59 MVP uses an accept-all / reject-all prompt; per-hunk review UI, conflict handling, symlinked build dirs, and `/sandbox <task>` slash command wiring land in v0.60+.

## SIDECAR.md Path-Scoped Section Injection (v0.67+) + Retrieval Mode (v0.92+)

Pre-v0.67, the entire SIDECAR.md body landed in every agent turn's system prompt and got mid-chopped on overflow. v0.67 replaces that with a deterministic, path-aware selector that routes sections by `<!-- @paths: glob -->` sentinels. v0.92 adds a third mode — `retrieval` — for large SIDECAR.md files where path-scoped routing is either unannotated or too coarse.

See [SIDECAR.md](sidecar-md#path-scoped-section-injection-v067) for the sentinel schema.

| Setting                                   | Type     | Default                             | Description                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------- | -------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidecar.sidecarMd.mode`                  | enum     | `"sections"`                        | How SIDECAR.md content is injected. `sections` (default) — path-scoped routing by `@paths` sentinels + active file + mentioned paths. `retrieval` — only `always`-priority sections inject verbatim; all other sections are scored by semantic similarity at query time via the RRF fusion pipeline. Best for files with 20+ sections. `full` — legacy whole-file dump with mid-chop on overflow |
| `sidecar.sidecarMd.alwaysIncludeHeadings` | string[] | `["Build", "Conventions", "Setup"]` | H2 headings that always inject verbatim in every mode. Case-insensitive match                                                                                                                                                                                                                                                                                                                    |
| `sidecar.sidecarMd.lowPriorityHeadings`   | string[] | `["Glossary", "FAQ", "Changelog"]`  | H2 headings demoted to low priority in `sections` mode — included only when budget remains. In `retrieval` mode these are scored like any other section                                                                                                                                                                                                                                          |
| `sidecar.sidecarMd.maxScopedSections`     | number   | `5`                                 | Cap on path-scoped sections per injection in `sections` mode. Clamped 1–50                                                                                                                                                                                                                                                                                                                       |
| `sidecar.sidecarMd.retrieval.topK`        | number   | `5`                                 | Max SIDECAR.md sections surfaced per turn in `retrieval` mode. Clamped 1–20                                                                                                                                                                                                                                                                                                                      |
| `sidecar.sidecarMd.retrieval.minScore`    | number   | `0.3`                               | Cosine-similarity floor for retrieval mode. Sections below this threshold are never injected even if they rank in the top-K. Range 0–1                                                                                                                                                                                                                                                           |

**Retrieval mode detail:** on first use (or after a content change), each section body is embedded with `all-MiniLM-L6-v2` and persisted to `.sidecar/cache/sidecarMd/`. Subsequent turns only re-embed sections whose content changed. The `SidecarMdRetriever` joins the existing RRF fusion pipeline alongside `DocRetriever`, `SemanticRetriever`, etc. — so SIDECAR.md sections compete on the same relevance footing as project knowledge and documentation.

## Fork & Parallel Solve (v0.67+)

Spawns N parallel approaches to the same task in isolated Shadow Workspaces, then picks the winner. See [Slash Commands — Fork](slash-commands#fork--parallel-solve-new-in-v067).

| Setting                      | Type    | Default | Description                                                                                                                                                                                          |
| ---------------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.fork.enabled`       | boolean | `true`  | Master toggle for Fork. When `false`, `/fork` and the palette entry show a one-line info toast instead of dispatching                                                                                |
| `sidecar.fork.defaultCount`  | number  | `3`     | Default number of parallel forks per dispatch. Clamped 2–10; values outside that range degenerate to "agent loop with no comparison"                                                                 |
| `sidecar.fork.maxConcurrent` | number  | `3`     | Max forks running in parallel at once. Clamped 1–10. Higher values finish faster at the cost of more concurrent Shadow Workspaces (disk churn) and more concurrent LLM requests (cost + rate limits) |

Every fork forces `forceShadow: true, deferPrompt: true` regardless of `sidecar.shadowWorkspace.mode` — the user's main tree is untouched during the run and no mid-run quickpicks fire. The aggregated review runs once every fork settles.

## Typed Sub-Agent Facets (v0.66+)

Dispatchable specialists — `general-coder`, `test-author`, `security-reviewer`, `latex-writer`, `signal-processing`, `frontend`, `technical-writer`, `data-engineer`, plus project + user overrides. See [Agent Mode — Typed Sub-Agent Facets](agent-mode#typed-sub-agent-facets-new-in-v066) and [Extending SideCar — Facets](extending-sidecar#facets) for the dispatch flow and schema.

| Setting                        | Type     | Default | Description                                                                                                                                                                                                                         |
| ------------------------------ | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.facets.enabled`       | boolean  | `true`  | Master toggle for the Facets feature. When `false`, the `SideCar: Facets: Dispatch Specialists` command surfaces a one-line info toast instead of the picker                                                                        |
| `sidecar.facets.maxConcurrent` | number   | `3`     | Maximum facets run in parallel within a topological layer. Clamped 1–16. Higher values accelerate wide batches at the cost of more concurrent Shadow Workspaces                                                                     |
| `sidecar.facets.rpcTimeoutMs`  | number   | `30000` | Milliseconds a facet's `rpc.<peerId>.<method>` call waits before the bus resolves the call as `{ ok: false, errorKind: 'timeout' }`. The bus never rejects — timeouts become typed outcomes the caller handles. Clamped 1000–300000 |
| `sidecar.facets.registry`      | string[] | `[]`    | Absolute paths to individual facet markdown files loaded alongside built-ins and `<workspace>/.sidecar/facets/*.md`. Useful for personal or team-shared facets checked into a separate repo                                         |

Built-in facets are embedded in the extension and always available — no disk I/O, no broken-unpack footgun. Disk facets with an `id` matching a built-in override the built-in; duplicate ids across disk sources surface as load errors without aborting the rest of the registry.

## Skills Registry & Sync (v0.112+)

Git-native skill distribution. SideCar clones personal and team skill registries on activation; `SkillLoader` picks up every `.agent.md` inside as a loadable skill. Standard git auth (SSH keys, HTTPS tokens) applies.

| Setting                            | Type    | Default      | Description                                                                                                                               |
| ---------------------------------- | ------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.skills.userRegistry`      | string  | `""`         | Git URL or absolute local folder for your personal skill collection. Cloned/pulled into `~/.sidecar/user-skills/` on activation.          |
| `sidecar.skills.teamRegistries`    | array   | `[]`         | Git URLs for team skill collections, each cloned into `~/.sidecar/team-skills/<slug>/`. Skills Picker tags each skill by origin registry. |
| `sidecar.skills.autoPull`          | string  | `"on-start"` | When to sync registries. `"on-start"` refreshes on every activation; `"manual"` only when you run `SideCar: Sync Skill Registries`.       |
| `sidecar.skills.offline`           | boolean | `false`      | Air-gapped mode — no network calls for sync. The loader reads only from what is already cached.                                           |
| `sidecar.skills.trustedRegistries` | array   | `[]`         | Registry URLs that skip the first-install trust prompt. Per-skill `allowed-tools` and `disable-model-invocation` guardrails still apply.  |

## Auto Mode (v0.73+)

Runs the agent in a loop against a markdown backlog file, processing each unchecked item in order and marking it complete on success. Start with the `SideCar: Start Auto Mode` command; stop with `SideCar: Stop Auto Mode`. Failures are appended to `.sidecar/logs/auto-mode-failures.md`.

| Setting                                     | Type    | Default                 | Description                                                                                        |
| ------------------------------------------- | ------- | ----------------------- | -------------------------------------------------------------------------------------------------- |
| `sidecar.autoMode.backlogPath`              | string  | `".sidecar/backlog.md"` | Path to the backlog file. Relative to workspace root. Each unchecked `- [ ] task` line is a task.  |
| `sidecar.autoMode.maxTasksPerSession`       | number  | `10`                    | Maximum backlog items to attempt in one session.                                                   |
| `sidecar.autoMode.maxRuntimeMinutes`        | number  | `240`                   | Wall-clock time limit in minutes. The session stops when reached even if items remain.             |
| `sidecar.autoMode.haltOnFailure`            | boolean | `false`                 | Stop after the first failed task. When `false`, the failure is logged and the next item runs.      |
| `sidecar.autoMode.autoOpenPR`               | boolean | `true`                  | Automatically open a pull request after all tasks complete successfully.                           |
| `sidecar.autoMode.interTaskCooldownSeconds` | number  | `30`                    | Seconds to wait between tasks — provides a window to stop the session before the next task begins. |

Each task runs through `runAgentLoopInSandbox` with autonomous approval; shadow-workspace isolation applies when `sidecar.shadowWorkspace.mode` is not `"off"`.

## Debugging & reasoning

| Setting                  | Type    | Default | Description                                                         |
| ------------------------ | ------- | ------- | ------------------------------------------------------------------- |
| `sidecar.verboseMode`    | boolean | `true`  | Show system prompt, iteration summaries, and tool selection context |
| `sidecar.expandThinking` | boolean | `false` | Show model reasoning blocks expanded instead of collapsed           |

Since v0.45.0, reasoning is rendered as a **numbered timeline**: each thinking block closes out when a tool call starts, producing discrete steps with purple pills (reasoning) or blue pills (tools) and a duration badge per step. Longer-running steps show elapsed time; sub-500ms steps hide the badge to reduce visual noise.

## Chat UI

Three settings control chat UI density, font size, and accent color. All three update live — changing them in Settings takes effect immediately without a reload.

| Setting                   | Type   | Default  | Description                                                                                                                                                                                                                                |
| ------------------------- | ------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidecar.chatDensity`     | string | `normal` | One of `compact`, `normal`, `comfortable`. Controls message padding and the gap between messages                                                                                                                                           |
| `sidecar.chatFontSize`    | number | `13`     | Chat UI base font size in pixels (10–22)                                                                                                                                                                                                   |
| `sidecar.chatAccentColor` | string | `""`     | Override the chat accent color (user message bubble and step indicator pills). Accepts hex (`#ff6b6b`), `rgb()` / `rgba()`, `hsl()` / `hsla()`, or a small allowlist of named colors. Leave empty to inherit from the active VS Code theme |

Accent color values pass through an allowlist CSS-color validator before being written to the DOM as a custom property, so settings strings can't smuggle additional style declarations into the chat.

## Terminal error interception

SideCar watches the integrated terminal for commands that exit with a non-zero status. When it detects a failure it shows a **Diagnose in chat** notification; accepting injects a synthesized prompt containing the command, exit code, working directory, and the ANSI-stripped tail of the output, then runs the agent against the failure.

| Setting                             | Type    | Default | Description                                                                                |
| ----------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------ |
| `sidecar.terminalErrorInterception` | boolean | `true`  | Enable automatic detection of failed terminal commands. Requires VS Code shell integration |

**Requirements:** VS Code 1.93+ with shell integration active. POSIX shells (bash, zsh, fish) and PowerShell are supported natively; other shells may need manual shell integration setup. When shell integration is unavailable the watcher silently no-ops — the setting itself is harmless.

**Dedup:** Identical command lines within a 30-second cooldown window fire only once, so a retry loop of `npm test` won't spam notifications.

**Ignored terminals:** SideCar's own `SideCar` terminal is always skipped to avoid feedback loops when the agent runs shell commands.

## Semantic Search

SideCar uses ONNX embeddings for semantic file search — queries like "authentication logic" find `src/auth/jwt.ts` even without keyword matches in the file path or conversation history.

| Setting                        | Type    | Default | Description                                                                                                                       |
| ------------------------------ | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.enableSemanticSearch` | boolean | `true`  | Enable ONNX-based semantic file search. The embedding model (~23MB) downloads on first use                                        |
| `sidecar.semanticSearchWeight` | number  | `0.6`   | Blend ratio between semantic and heuristic scoring (0 = keyword only, 1 = embeddings only). Default 0.6 weights embeddings higher |

The embedding model (all-MiniLM-L6-v2, 384-dimensional, quantized) loads in the background after the workspace is indexed. Until it's ready, SideCar falls back to keyword-based scoring. Embeddings are cached in `.sidecar/cache/embeddings.bin` and only recomputed when file content changes.

## Web Search

| Setting                      | Type   | Default        | Description                                                                                                                                                                                                                         |
| ---------------------------- | ------ | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.webSearch.provider` | string | `"duckduckgo"` | Provider for the `web_search` tool. `"duckduckgo"` — HTML scraping, no key required. `"tavily"` — purpose-built LLM search API. `"brave"` — privacy-focused independent index. Tavily and Brave require `sidecar.webSearch.apiKey`. |
| `sidecar.webSearch.apiKey`   | string | `""`           | API key for Tavily or Brave. Not used when provider is `"duckduckgo"`.                                                                                                                                                              |

The `web_search` tool blocks queries containing credential-shaped tokens (AWS keys, GitHub tokens, JWTs) before they reach any provider, regardless of this setting.

## Zen Mode (v0.96+)

| Setting                    | Type    | Default | Description                                                                                                             |
| -------------------------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `sidecar.zenMode.enabled`  | boolean | `false` | Only inject RAG hits scoring at or above `zenMode.minScore`. Reduces retrieval noise for local models on focused tasks. |
| `sidecar.zenMode.minScore` | number  | `0.35`  | Minimum RRF score required for a context hit to be included when Zen Mode is active.                                    |

## Audit Mode settings (v0.60+)

These settings tune the Audit Mode buffer behaviour. See [Agent Mode → Review mode](agent-mode#review-mode--batch-diff-review) for the full Audit Mode flow.

| Setting                          | Type    | Default | Description                                                                                                                                |
| -------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidecar.audit.autoApproveReads` | boolean | `true`  | `read_file` and `list_directory` bypass the audit buffer — reads don't mutate state. Set `false` to require explicit review of every read. |
| `sidecar.audit.bufferGitCommits` | boolean | `true`  | Buffer `git_commit` calls alongside file writes so a rejected flush leaves `HEAD` unchanged. Set `false` to let commits land immediately.  |

## Ollama Settings

| Setting                          | Type    | Default | Description                                                                                                                                                                  |
| -------------------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.ollama.disableThinking` | boolean | `false` | Pass `think: false` with every Ollama request, disabling extended reasoning for models that support it (Qwen3, DeepSeek-R1). Reduces latency at the cost of reasoning depth. |
| `sidecar.ollama.numCtx`          | number  | `null`  | Override the context window size (`num_ctx`). `null` = use the model's Modelfile default. Set to e.g. `32768` or `65536` to force a specific window. Ollama backend only.    |

## Retrieval & Project Knowledge (advanced)

| Setting                                      | Type    | Default  | Description                                                                                                                                                                                                   |
| -------------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.retrieval.queryRewrite`             | string  | `"rule"` | Rewrite the user message before embedding for retrieval. `"off"` = passthrough; `"rule"` = strip preambles, expand camelCase (zero cost); `"llm"` = LLM-reformulated query; `"expand"` = rule + LLM combined. |
| `sidecar.retrieval.graphExpansion.enabled`   | boolean | `true`   | After semantic retrieval, walk the symbol graph's `calls` edges outward to surface dependency-coupled symbols.                                                                                                |
| `sidecar.retrieval.graphExpansion.maxHits`   | number  | `8`      | Cap on symbols added via graph walk per retrieval call.                                                                                                                                                       |
| `sidecar.projectKnowledge.enabled`           | boolean | `true`   | Enable the Project Knowledge Index — semantic symbol search via tree-sitter + MiniLM embeddings. Disable to turn off background indexing entirely.                                                            |
| `sidecar.projectKnowledge.graphWalkDepth`    | number  | `2`      | Hops to walk the symbol graph after a vector hit. `1` = direct callers only; `2` = callers of callers. Higher values surface more context at the cost of more tokens.                                         |
| `sidecar.projectKnowledge.maxGraphHits`      | number  | `10`     | Cap on symbols added via graph walk per `project_knowledge_search` call. Guards against popular symbols drowning results.                                                                                     |
| `sidecar.projectKnowledge.backend`           | string  | `"flat"` | Vector storage backend. `"flat"` = in-memory `Float32Array` (fast up to ~100k symbols). `"lance"` = LanceDB for persistent out-of-memory storage (requires `@lancedb/lancedb`).                               |
| `sidecar.projectKnowledge.maxSymbolsPerFile` | number  | `500`    | Safety cap on embedded symbols per file. Prevents auto-generated files from monopolising the embedder queue.                                                                                                  |
| `sidecar.merkleIndex.enabled`                | boolean | `true`   | Enable content-addressed Merkle tree over the symbol index. Prunes candidate files via embedding descent before scoring leaves — significant speedup on large codebases.                                      |

## Outbound Allowlist

| Setting                     | Type  | Default | Description                                                                                                                                                                                |
| --------------------------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidecar.outboundAllowlist` | array | `[]`    | Hostnames permitted for URL fetching in chat. Supports a leading `*.` wildcard (e.g. `*.github.com`). Empty = allow all public URLs (built-in SSRF and private-IP blocking still applies). |

## Verbose Logs

| Setting               | Type    | Default | Description                                                                                                                                                                 |
| --------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.verboseLogs` | boolean | `false` | Append per-turn API call metadata (`runId`, `model`, `inputTokens`, `outputTokens`, `stopReason`, `timestamp`) to `.sidecar/logs/api.jsonl` for auditing and cost tracking. |

## RAG & Agent Memory

SideCar uses **Retrieval-Augmented Generation (RAG)** to inject relevant documentation into the agent's context, and **persistent memory** to track learned patterns across sessions.

### RAG Configuration

| Setting                            | Type    | Default | Description                                                                        |
| ---------------------------------- | ------- | ------- | ---------------------------------------------------------------------------------- |
| `sidecar.enableDocumentationRAG`   | boolean | `true`  | Enable documentation retrieval for every user message                              |
| `sidecar.ragMaxDocEntries`         | number  | `20`    | Maximum number of documentation entries to inject per message (1-20)               |
| `sidecar.ragUpdateIntervalMinutes` | number  | `60`    | Re-index documentation every N minutes (5-360). Set to `0` to disable auto-refresh |

Documentation is automatically discovered in:

- Project root: `README*`, `ARCHITECTURE*`, `DESIGN*`
- Directories: `docs/**`, `doc/**`, `wiki/**`
- All `.md` files in these locations are indexed and searchable

When a user sends a message, SideCar searches the indexed documentation for relevant sections using keyword matching. Matching entries are injected into the system prompt to improve accuracy.

**Example**: If you ask "how does authentication work?", and there's a `docs/AUTHENTICATION.md` with relevant content, it's automatically included in the context.

### Agent Memory Configuration

| Setting                         | Type    | Default | Description                                                                                          |
| ------------------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------- |
| `sidecar.enableAgentMemory`     | boolean | `true`  | Enable persistent agent memory across sessions                                                       |
| `sidecar.agentMemoryMaxEntries` | number  | `500`   | Maximum number of memory entries to retain (10-500). Older entries are evicted when limit is reached |

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

## Pinned Memory (v0.72+)

| Setting                               | Type    | Default | Description                                                                                                                                                                |
| ------------------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.pinnedMemory.enabled`        | boolean | `true`  | Enable pinned memory. Pinned entries are always injected into the system prompt with always-include semantics — they survive context compaction and are never mid-chopped. |
| `sidecar.pinnedMemory.maxPins`        | number  | `50`    | Maximum number of pinned entries. Higher-boost entries are injected first; entries beyond the cap are dropped from injection.                                              |
| `sidecar.pinnedMemory.maxCharsPerPin` | number  | `5000`  | Maximum characters per pinned entry. Entries exceeding this are truncated with a marker, not dropped.                                                                      |

Entries are persisted to `.sidecar/memory/` and keyed by SHA-256 of path + optional heading list, so re-pinning the same content updates in place. Pin and unpin via `/memories` in chat or the Pinned Memory sidebar.

## PR Defaults (v0.99+)

| Setting                                         | Type    | Default  | Description                                                                                                                                                                                                                    |
| ----------------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidecar.pr.create.draftByDefault`              | boolean | `true`   | Open new PRs as drafts so CI runs without notifying reviewers.                                                                                                                                                                 |
| `sidecar.pr.create.baseBranch`                  | string  | `"auto"` | Base branch for new PRs. `"auto"` resolves the remote's default branch via git, falling back to `main`.                                                                                                                        |
| `sidecar.pr.create.template`                    | string  | `"auto"` | PR template handling. `"auto"` reads `.github/pull_request_template.md` and fills each section; `"ignore"` writes a fresh Summary + Test Plan body regardless. Any other value is treated as a path to a custom template file. |
| `sidecar.pr.branchProtection.enabled`           | boolean | `true`   | Check branch protection rules before `git_push`. If direct pushes are blocked, the push is aborted and the agent is told why. Requires a GitHub token with `repo` scope.                                                       |
| `sidecar.pr.branchProtection.warnEvenIfPassing` | boolean | `false`  | Include branch protection rule summary in `git_push` output even when direct pushes are allowed, so the agent is aware of required status checks before submitting the PR.                                                     |

## CodeLens, DESIGN.md, and Mermaid

| Setting                    | Type    | Default | Description                                                                                                                                                                                                |
| -------------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.codeLens.enabled` | boolean | `true`  | Show SideCar code lenses above function/class declarations (Explain, Fix, Add tests, Refactor) and above TODO/FIXME comments (Fix) for TypeScript, JavaScript, Python, Go, and Rust files.                 |
| `sidecar.designMd.enabled` | boolean | `true`  | Read `DESIGN.md` (or `.sidecar/DESIGN.md`) and inject design tokens into agent context. The compact tokens block is always included; full prose rationale is added only when the active file is a UI file. |
| `sidecar.enableMermaid`    | boolean | `true`  | Render fenced ` ```mermaid ` blocks as diagrams in the chat panel. Disable to skip the mermaid.js runtime load and render them as plain code.                                                              |

## Extensibility

| Setting                  | Type   | Default | Description                                                                   |
| ------------------------ | ------ | ------- | ----------------------------------------------------------------------------- |
| `sidecar.mcpServers`     | object | `{}`    | MCP server connections (stdio, HTTP, SSE). See [MCP Servers](mcp-servers)     |
| `sidecar.hooks`          | object | `{}`    | Pre/post tool execution hooks. See [Hooks](hooks-and-tasks#tool-hooks)        |
| `sidecar.eventHooks`     | object | `{}`    | Event-based hooks (`onSave`, `onCreate`, `onDelete`)                          |
| `sidecar.scheduledTasks` | array  | `[]`    | Recurring agent tasks. See [Scheduled Tasks](hooks-and-tasks#scheduled-tasks) |
| `sidecar.customTools`    | array  | `[]`    | Custom shell command tools. See [Custom Tools](hooks-and-tasks#custom-tools)  |
| `sidecar.customModes`    | array  | `[]`    | Custom agent modes. See [Custom modes](agent-mode#custom-modes)               |

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

## macOS Seatbelt Sandbox (v0.89+)

Wraps agent `run_command` and `run_tests` calls with `/usr/bin/sandbox-exec` on macOS. The deny-default SBPL profile allows reads everywhere, network-outbound, and writes only inside the workspace root, `/tmp`, and common build caches (`~/.npm`, `~/.cargo`, `~/.gradle`, `~/.m2`). Automatically disabled on Linux and Windows where `sandbox-exec` is unavailable.

| Setting                   | Type    | Default | Description                                                                                                                                                 |
| ------------------------- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.sandbox.enabled` | boolean | `true`  | Enable the macOS Seatbelt sandbox for agent shell commands. Disable if a tool you rely on writes outside the allowed paths and you have verified it is safe |

## External Context Providers (v0.89+)

Pull live issue-tracker context into every agent system prompt. At the start of each turn SideCar fetches the configured trackers, injects an `## Active Issues` block, and caches results for 5 minutes. Errors (bad token, network failure) are non-fatal — a `⚠️` line appears in the block but the turn continues.

| Setting                    | Type  | Default | Description                                                                                                                                                                                             |
| -------------------------- | ----- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.contextProviders` | array | `[]`    | List of context provider configs. Each entry has `type` (`github` \| `linear` \| `jira` \| `bitbucket`), `filter`, `maxIssues`, and provider-specific fields (`owner`/`repo`, `apiKey`, `teamId`, etc.) |

**GitHub Issues example:**

```json
"sidecar.contextProviders": [
  {
    "type": "github",
    "filter": "assigned",
    "maxIssues": 5
  }
]
```

The GitHub provider auto-detects `owner/repo` from `git remote get-url origin`. For Linear and Jira supply `apiKey` and optionally `teamId` / `projectKey`.

## RAM/VRAM Monitor (v0.111+)

`MemoryPressureMonitor` polls free RAM every 30 seconds and GPU memory via `nvidia-smi` / `rocm-smi`. A right-side status bar item shows live RAM% and GPU% — colour-coded red when free RAM < 1 GiB, yellow when < 2 GiB. Click it to force a poll, or use the command palette:

- `SideCar: Refresh Memory Status` (`sidecar.memory.refresh`) — force an immediate poll

**Pre-flight checks** run automatically before:

- Loading a model in Kickstand (`SideCar: Load Model`)
- Starting a HuggingFace safetensors install
- Opening an Arena session (`/arena`, `/arena agent`)

At **low** pressure (< 2 GiB free): a warning dialog asks for confirmation before proceeding.  
At **critical** pressure (< 1 GiB free): the operation is blocked with an error message.

After two consecutive pressure readings at the same level, a notification fires — then suppressed for 5 minutes to avoid spam. No settings are required; the monitor activates automatically at extension startup.

## Model Arena (v0.90+)

Side-by-side streaming comparison of 2–4 models on the same prompt, with a local ELO leaderboard. See [Slash Commands — Model Arena](slash-commands#model-arena-new-in-v090) for the full flow.

| Setting                       | Type     | Default | Description                                                                                                                                    |
| ----------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.arena.enabled`       | boolean  | `true`  | Master toggle for Model Arena. When `false`, `/arena` and the palette entries show a one-line info toast                                       |
| `sidecar.arena.defaultModels` | string[] | `[]`    | Pre-populated model list — when non-empty, the QuickPick is skipped and these models are used directly. Example: `["llama3.2:3b", "qwen3:8b"]` |

ELO ratings are persisted to `.sidecar/arena/elo.json` (K=32, multi-way pairwise) and accumulate across both chat and agent arena runs.

## Monorepo Support (v0.97+)

| Setting                    | Type    | Default | Description                                                                                                                                                                                                                                        |
| -------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.monorepo.enabled` | boolean | `true`  | Enable monorepo package discovery. Auto-detects Nx, Turborepo, pnpm workspaces, Yarn workspaces, and Lerna. When detected, the `monorepo_packages` agent tool lists workspace packages with metadata (name, version, path, scripts, dependencies). |

## Database Integration (v0.76+)

Configure database connections for the `db_query`, `db_execute`, `db_migrate_up`, `db_list_tables`, `db_describe_table`, and `db_list_connections` agent tools.

| Setting                            | Type   | Default | Description                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.databases.profiles`       | array  | `[]`    | List of named database connection profiles. Each entry has `name` (identifier shown to the agent), `type` (`"sqlite"` / `"postgres"` / `"mysql"` / `"duckdb"`), and connection-specific fields (`path` for SQLite/DuckDB; `host`, `port`, `database`, `user`, `password` for Postgres/MySQL). |
| `sidecar.databases.queryRowLimit`  | number | `10000` | Maximum rows returned by `db_query`. Results beyond this limit are truncated with a count of omitted rows.                                                                                                                                                                                    |
| `sidecar.databases.queryTimeoutMs` | number | `30000` | Hard timeout in milliseconds for every `db_query` call. Prevents runaway queries from blocking the agent.                                                                                                                                                                                     |

**Example profile (SQLite):**

```json
"sidecar.databases.profiles": [
  { "name": "local", "type": "sqlite", "path": "./data/app.db" }
]
```

Store passwords using environment variables (`"password": "${DB_PASS}"`) rather than plaintext in `settings.json`.

## Dependency Drift Alerts (v0.91+)

Scans `package.json`, `requirements*.txt`, `Cargo.toml`, and `go.mod` for outdated dependencies and known vulnerabilities. Findings appear in the VS Code **Problems panel** (`source: sidecar-deps`) — `Information` for outdated, `Warning` for medium/high vulnerabilities, `Error` for critical. File watchers trigger a debounced (2 s) re-scan on manifest save. See [Security Scanning — Dependency Drift](security-scanning#dependency-drift-alerts) for details.

| Setting                             | Type    | Default | Description                                                                                              |
| ----------------------------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `sidecar.deps.enabled`              | boolean | `true`  | Enable Dependency Drift Alerts, the file watchers, and the `check_dependencies` agent tool               |
| `sidecar.deps.checkVulnerabilities` | boolean | `true`  | Query the [OSV](https://osv.dev) API for CVE/GHSA matches. Disable in offline or air-gapped environments |

Force an immediate workspace-wide scan with `SideCar: Scan Dependencies for Drift & Vulnerabilities` from the Command Palette, or call the `check_dependencies` agent tool directly.

## Code Profiling (v0.93+)

The `profile_code` agent tool auto-detects the project ecosystem and runs the appropriate profiler, returning the top-N CPU hotspots as ranked markdown. Disabled by default to avoid unexpected shell executions.

| Setting                     | Type    | Default | Description                                                                 |
| --------------------------- | ------- | ------- | --------------------------------------------------------------------------- |
| `sidecar.profiling.enabled` | boolean | `false` | Enable the `profile_code` agent tool                                        |
| `sidecar.profiling.topN`    | number  | `10`    | Default number of hotspots to return (1–50). Override per-call with `top_n` |

**Ecosystem detection** (first match wins): `package.json` → Node.js, `requirements.txt`/`pyproject.toml`/`setup.py` → Python, `Cargo.toml` → Rust, `go.mod` → Go. Override with `ecosystem="node|python|go|rust"`.

**Node.js and Python** require a `script` parameter pointing to the entry file (e.g. `profile_code(ecosystem="python", script="src/main.py")`). Go and Rust use their built-in bench runners and need no script.

## Visual Verification (v0.77+)

| Setting                                | Type    | Default                  | Description                                                                                                                                                    |
| -------------------------------------- | ------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.visualVerify.enabled`         | boolean | `false`                  | Enable the visual verification tool suite: `screenshot_page`, `analyze_screenshot`, `open_in_browser`, `run_playwright_code`. Requires a vision-capable model. |
| `sidecar.visualVerify.mode`            | string  | `"warn"`                 | How the agent treats visual verification failures. `"strict"` — blocking error; `"warn"` — surface but continue; `"advisory"` — informational only.            |
| `sidecar.visualVerify.vlm`             | string  | `""`                     | Vision model for `analyze_screenshot`. Empty = auto-detect from the active backend (Claude 3+, GPT-4o, Ollama vision models).                                  |
| `sidecar.visualVerify.maxAttempts`     | number  | `3`                      | Suggested maximum visual-correction attempts. Injected into the system prompt as guidance.                                                                     |
| `sidecar.visualVerify.screenshotsDir`  | string  | `".sidecar/screenshots"` | Directory where `screenshot_page` saves captured PNGs. Relative to workspace root.                                                                             |
| `sidecar.visualVerify.allowedDomains`  | array   | `[]`                     | Domains permitted for `screenshot_page` even when they resolve to loopback or private-network addresses (e.g. `localhost`).                                    |
| `sidecar.visualVerify.cheapChecksOnly` | boolean | `false`                  | Run only heuristic pre-filter checks (blank canvas, edge clipping) and skip the VLM call. Useful on tight local-inference budgets.                             |

`analyze_screenshot` always runs a fast heuristic pre-filter before calling the VLM. `run_playwright_code` always requires user approval regardless of agent mode.

## Voice Input (v0.98+)

| Setting                          | Type    | Default                 | Description                                                                                                                                                                           |
| -------------------------------- | ------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.voice.enabled`          | boolean | `false`                 | Show the microphone button in the chat input. Click to start recording; click again to stop. Transcribed text is injected into the chat box ready to send or edit.                    |
| `sidecar.voice.model`            | string  | `"Xenova/whisper-tiny"` | Whisper model for speech-to-text. HuggingFace hub IDs (containing `/`) run in-process via ONNX — no API key needed. Plain names like `whisper-1` route to the HTTP transcription API. |
| `sidecar.voice.transcriptionUrl` | string  | `""`                    | Override URL for the Whisper transcription endpoint. Leave empty to derive from the active backend's base URL.                                                                        |

Audio is captured directly in the VS Code extension host. Platform paths: Swift/AVFoundation on macOS, `arecord` on Linux, PowerShell + WinMM on Windows. Local models are lazy-loaded and cached for the extension host lifetime.

## LaTeX Agentic Debugging (v0.94+)

The `latex_compile` agent tool compiles a `.tex` document and returns structured errors and warnings with file and line references. Disabled by default.

| Setting                  | Type    | Default     | Description                                                                     |
| ------------------------ | ------- | ----------- | ------------------------------------------------------------------------------- |
| `sidecar.latex.enabled`  | boolean | `false`     | Enable the `latex_compile` agent tool                                           |
| `sidecar.latex.compiler` | string  | `"latexmk"` | Compiler to use: `"latexmk"` (handles multi-pass automatically) or `"pdflatex"` |

The tool auto-detects the main `.tex` file in the workspace root; pass `file="path/to/main.tex"` to target a specific document. `latexmk` is probed at each call and falls back to `pdflatex` if not installed.

## Doc-to-Test Synthesis (v0.79+)

| Setting                                      | Type    | Default             | Description                                                                                                                                     |
| -------------------------------------------- | ------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.docTests.enabled`                   | boolean | `true`              | Enable the `extract_constraints`, `synthesize_tests`, and `classify_test_failure` agent tools.                                                  |
| `sidecar.docTests.extractionModel`           | string  | `""`                | Model override for constraint extraction. Empty = use the active model.                                                                         |
| `sidecar.docTests.floatTolerance`            | number  | `1e-9`              | Default relative tolerance passed to `pytest.approx()` for numeric example constraints.                                                         |
| `sidecar.docTests.outputDir`                 | string  | `"tests/from_docs"` | Directory where synthesized test files are written, relative to workspace root.                                                                 |
| `sidecar.docTests.requireConstraintApproval` | boolean | `true`              | Present the constraint manifest for review before calling `synthesize_tests`. When `false`, tests are synthesized immediately after extraction. |
| `sidecar.docTests.testFramework`             | string  | `"pytest"`          | Test framework to target when synthesizing tests.                                                                                               |

The synthesis loop: `extract_constraints` parses docs into a typed constraint manifest → `synthesize_tests` generates a complete test file from approved constraints → `classify_test_failure` triages failures back to `impl_wrong`, `doc_wrong`, or `extraction_wrong`.

## CI Failure Analysis (v0.99+)

| Setting                           | Type    | Default   | Description                                                                                                                      |
| --------------------------------- | ------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.ci.analysis.enabled`     | boolean | `true`    | Enable the `analyze_ci_failure` agent tool and `SideCar: Analyze CI Failure` command palette entry.                              |
| `sidecar.ci.analysis.jobFilter`   | array   | `["*"]`   | Glob patterns matched against CI job names. `["*"]` = all failed jobs. Narrow to e.g. `["test", "lint"]` to skip unrelated jobs. |
| `sidecar.ci.analysis.maxLogBytes` | number  | `4000000` | Maximum bytes to download per CI job log. Logs larger than this are tailed.                                                      |

Requires a GitHub token with `actions:read` scope configured via `SideCar: Set GitHub Token`.

## Persistent Executive Function (v0.94+)

When enabled, the agent checkpoints its task state to `.sidecar/plans/active.json` after each iteration. If VS Code closes mid-run, the next activation prompts you to resume or discard the interrupted task.

| Setting                             | Type    | Default | Description                                                                                                                                            |
| ----------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidecar.executiveFunction.enabled` | boolean | `true`  | Checkpoint agent task state after each iteration so runs can resume after a VS Code restart or crash. Disable to suppress the resume prompt on startup |

Checkpoints older than 24 hours are automatically discarded on the next activation.

## Agentic Task Delegation via MCP (v0.95+)

Two-direction MCP delegation: the SideCar agent can sub-delegate tasks to external MCP servers (`delegate_to_mcp` tool), and SideCar can expose its own agent loop as a local MCP server for other tools to call.

### `delegate_to_mcp` — agent → MCP server

| Setting                                | Type     | Default | Description                                                                                                             |
| -------------------------------------- | -------- | ------- | ----------------------------------------------------------------------------------------------------------------------- |
| `sidecar.mcpDelegation.enabled`        | boolean  | `false` | Enable the `delegate_to_mcp` tool. When `false` the tool is not registered and does not appear in the model's tool list |
| `sidecar.mcpDelegation.allowedServers` | string[] | `[]`    | Allowlist of MCP server names the tool may target. Empty array = all configured servers are allowed                     |

When enabled, the agent can call `delegate_to_mcp(server="my-server", task="...")` to offload a sub-task. SideCar auto-detects the entry-point tool from the server's catalog (`run_task`, `execute_task`, `task`, `run`, `execute`, `process`, `handle`). Use `sidecar.mcpDelegation.allowedServers` to restrict which servers the agent may reach.

### SideCar as MCP server — inbound calls

| Setting                           | Type    | Default | Description                                                      |
| --------------------------------- | ------- | ------- | ---------------------------------------------------------------- |
| `sidecar.mcpServer.enabled`       | boolean | `false` | Expose SideCar's agent loop as a local MCP server on `127.0.0.1` |
| `sidecar.mcpServer.port`          | number  | `3457`  | Listening port (1024–65535)                                      |
| `sidecar.mcpServer.requireAuth`   | boolean | `true`  | Require a bearer token on inbound requests                       |
| `sidecar.mcpServer.authToken`     | string  | `""`    | Bearer token clients must supply when `requireAuth` is `true`    |
| `sidecar.mcpServer.maxConcurrent` | number  | `1`     | Maximum concurrent agent tasks from inbound calls                |

Exposes one tool: `run_agent_task(task, maxIterations?, approvalMode?)`. Other tools (Claude Code, VS Code extensions, CI scripts) can call SideCar's agent loop via HTTP. The server binds to `127.0.0.1` only — never exposed to the network.

## Notebook Mode (v0.82+)

| Setting                                  | Type    | Default  | Description                                                                                                                                                                                                                                      |
| ---------------------------------------- | ------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidecar.notebookMode.enabled`           | boolean | `false`  | Enable the source-grounded research tool suite: `ingest_source`, `generate_briefing`, `generate_study_guide`, `generate_faq`, `generate_timeline`, `generate_outline`. Each artifact carries per-sentence citations back to the ingested source. |
| `sidecar.notebookMode.requireCitations`  | enum    | `strict` | Citation enforcement for notebook sections: `strict` (re-generate uncited sections), `advisory` (warn only), `off`.                                                                                                                              |
| `sidecar.notebookMode.studyAids.enabled` | boolean | `true`   | Enable `generate_study_guide` and `generate_faq`. Disable to keep only the core ingest, briefing, timeline, and outline pipeline.                                                                                                                |

## Zotero Integration (v0.75+)

| Setting                      | Type    | Default                    | Description                                                                                                           |
| ---------------------------- | ------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `sidecar.zotero.userId`      | string  | `""`                       | Your Zotero user ID (found at zotero.org/settings/keys). Required for `zotero_search` and `zotero_get_item`.          |
| `sidecar.zotero.apiKey`      | string  | `""`                       | Your Zotero API key with read access. Required for `zotero_search` and `zotero_get_item`.                             |
| `sidecar.zotero.baseUrl`     | string  | `"https://api.zotero.org"` | Zotero API base URL. Override for self-hosted Zotero instances.                                                       |
| `sidecar.literature.enabled` | boolean | `false`                    | Include indexed PDF literature from `.sidecar/literature/` in retrieval context. Use `index_pdf` to add papers first. |

## Research Assistant (v0.104+)

Structured project tracking for scientific or engineering research workflows. Projects are stored in `.sidecar/research/` and tracked in git. Eight agent tools plus a sidebar panel and `/research` slash command.

| Setting                          | Type    | Default | Description                                                                                                           |
| -------------------------------- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------- |
| `sidecar.research.enabled`       | boolean | `false` | Enable the Research Assistant and register the 8 research agent tools                                                 |
| `sidecar.research.activeProject` | string  | `""`    | Name of the currently active project. Set automatically by `research_create_project` or the `/research` slash command |

When enabled: `research_create_project`, `research_add_hypothesis`, `research_log_experiment`, `research_add_observation`, `research_update_hypothesis_status`, `research_set_project_status`, `research_list_projects`, and `research_export_report` are available to the agent. The Research sidebar panel provides a live tree view of all projects.

## Completion gates — analysis (v0.115+)

Domain-specific completion gates that block finishing a turn when the agent edited code of a given class without the corresponding verification. Complements the general `sidecar.completionGate.*` settings above. All default off.

| Setting                           | Type    | Default | Description                                                                                                                                                |
| --------------------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.codeGraph.impactGate`    | boolean | `false` | Block completion when the agent edits an exported symbol that has unverified cross-file dependents (uses the symbol graph's import-resolved impact set).   |
| `sidecar.numericalContracts.gate` | boolean | `false` | Block completion when the agent edits a numerical kernel (array/tensor/quantity-typed params or returns) whose shape/dtype/unit contract is unstated.      |
| `sidecar.analyticBounds.gate`     | boolean | `false` | Block completion when the agent edits a kernel that declares an analytic value bound (e.g. `# bounds: 0 <= result <= 1`) without a check proving it holds. |

## Mutation Testing (v0.115+)

Verify-the-verifier tooling: seeds single-point faults into a source file and reports which mutants survive the test suite (surviving mutants = gaps in the tests).

| Setting                          | Type    | Default | Description                                                                                                |
| -------------------------------- | ------- | ------- | ---------------------------------------------------------------------------------------------------------- |
| `sidecar.mutation.enabled`       | boolean | `false` | Enable the `mutation_test` agent tool.                                                                     |
| `sidecar.mutation.maxMutants`    | number  | `25`    | Cap on mutants generated + tested per run (the test command runs once per mutant, so this bounds runtime). |
| `sidecar.mutation.testTimeoutMs` | number  | `60000` | Per-mutant test-run timeout (ms). A mutant whose run times out is counted as errored, not killed.          |

## Scaffolding (keep-best & adaptive)

Loop-safety scaffolding tuning. See also the scaffolding roadmap in `docs/`.

| Setting                                         | Type    | Default | Description                                                                                                                                                                                                        |
| ----------------------------------------------- | ------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sidecar.adaptiveScaffolding.enabled`           | boolean | `true`  | Tune loop-safety scaffolding to the active model's capability tier. Weak models get a larger reprompt/gate budget; strong models get a looser burst cap and compact later. Verification budgets are never reduced. |
| `sidecar.modelLearning.enabled`                 | boolean | `true`  | Learn each model's capability tier from how it performs here, instead of guessing from its name. Demotes on failure; promotes only when a model succeeds without the scaffolding ever firing.                      |
| `sidecar.modelTier`                             | object  | `{}`    | Explicit tier per model, e.g. `{"llama3.2": "weak"}`. Overrides detection entirely — including anything SideCar has learned. Use when the automatic tier is wrong for your hardware or codebase.                   |
| `sidecar.scaffolding.overrides`                 | object  | `{}`    | Pin individual scaffolding triggers regardless of tier, e.g. `{"runLlmCritic": true, "burstCap": 20}`. Applied last, over everything else.                                                                         |
| `sidecar.plan.externalized`                     | boolean | `false` | Externalized planning (S1): `update_plan` tool + per-turn `<plan_state>` re-injection so the plan survives context compression on long tasks.                                                                      |
| `sidecar.scaffolding.keepBest`                  | boolean | `true`  | Pareto-safe keep-best ratchet: snapshot files when scaffolding first drives extra work and revert if the extra work proved no test signal.                                                                         |
| `sidecar.scaffolding.keepBestOverEngineerBytes` | number  | `0`     | Byte growth past which a scaffold-driven patch that improved no test signal is reverted as over-engineered. `0` = any unproven growth reverts.                                                                     |
| `sidecar.scaffolding.cycleDetectionMinRepeats`  | number  | `10`    | Repeats of the same tool + file (content-aware) before the loop bails as a stuck cycle. Higher gives weak models more self-correction attempts.                                                                    |
| `sidecar.recovery.codeAsText`                   | boolean | `true`  | Recovery package for models that print code instead of calling tools (call-expression parsing, fence-write synthesis, literal-escape decode, fused-anchor split). Dormant on capable models; proven on weak ones.  |
| `sidecar.editFile.steerToWrite`                 | boolean | `false` | When `edit_file` keeps failing on one file, steer the model to rewrite it with `write_file`. Manual-use flag — campaigned to a powered null.                                                                       |
| `sidecar.editFile.steerToWriteThreshold`        | number  | `3`     | Consecutive `edit_file` failures on one file before the steer fires.                                                                                                                                               |

## AWS Bedrock

Endpoint selection for the Bedrock backend. Auth is the AWS credential chain (see the Connection section), not an API key.

| Setting                  | Type    | Default       | Description                                                                                                 |
| ------------------------ | ------- | ------------- | ----------------------------------------------------------------------------------------------------------- |
| `sidecar.bedrock.region` | string  | `"us-east-1"` | AWS region for the Bedrock Runtime endpoint (`bedrock-runtime.<region>.amazonaws.com`).                     |
| `sidecar.bedrock.fips`   | boolean | `false`       | Use the Bedrock FIPS endpoint (`bedrock-runtime-fips.<region>.amazonaws.com`) instead of the standard host. |

## Other feature flags

| Setting                               | Type        | Default | Description                                                                                                                         |
| ------------------------------------- | ----------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.injectionGuard.enabled`      | boolean     | `true`  | Prompt-injection guard: scan tool output (files, web search, fetched URLs, shell/CI logs, tickets) for injection attempts and warn. |
| `sidecar.agentSeed`                   | number/null | `null`  | Fixed RNG seed for reproducible generation (benchmarks / ablation). `null` leaves generation unseeded.                              |
| `sidecar.evalHistory.enabled`         | boolean     | `false` | Enable the `query_history` agent tool (read-only SELECT over the local eval-history DB at `.sidecar/history.db`).                   |
| `sidecar.notebookMode.sources.webUrl` | boolean     | `true`  | Allow Notebook Mode to ingest sources from web URLs via `ingest_source`.                                                            |
| `sidecar.whatsNew.enabled`            | boolean     | `true`  | Show a one-time release-notes notification after SideCar updates. The `SideCar: What's New` command works regardless of this flag.  |
