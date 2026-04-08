# Changelog

All notable changes to the SideCar extension will be documented in this file.

## [0.30.0] - 2026-04-08

### Added
- **LLMManager backend support**: connect to LLMManager inference server on `http://localhost:11435` with automatic token loading from `~/.config/llmmanager/token`. Full streaming, tool use, and fallback support
- **Claude Code skill compatibility**: load and use existing Claude Code skills directly — no format conversion needed. Scans `~/.claude/commands/`, `<workspace>/.claude/commands/`, and `.sidecar/skills/` for markdown skill files. Trigger via `/skill-name` slash command or automatic keyword matching. New `/skills` command lists all loaded skills
- **Backend fallback**: configure a secondary provider via `sidecar.fallbackBaseUrl`, `sidecar.fallbackApiKey`, `sidecar.fallbackModel`. After 2 consecutive failures on the primary, SideCar auto-switches to fallback with a warning. Switches back on success
- **Docs redesign CSS**: extracted design system stylesheet for the docs site (coral/blue/purple palette, code blocks, callouts, mode grid, nav cards)
- **Redesigned landing page**: new standalone landing page with terminal mockup, feature comparison table, stat strip, and quickstart guide

### Fixed
- **Code block button memory leak**: Run/Save/Copy buttons now use event delegation with `data-action` attributes instead of per-button listeners that captured code in closures
- **Repetitive model responses**: added anti-repetition rules to system prompts ("NEVER repeat information", "no lists unless asked", "only add new info after tool calls")
- **Marketplace publish blocking releases**: publish step now uses `continue-on-error` so re-runs can create the GitHub Release even if the VSIX was already published

### Performance
- **parseThinkTags**: index tracking instead of string slicing — eliminates intermediate string allocations
- **parseTextToolCalls**: consolidated 3 sequential regex passes into single combined regex with priority tracking
- **OpenAI backend stream tests**: 6 new tests for SSE parsing, malformed JSON, partial chunks, think tags, error responses

### Tests
- 403 total tests

## [0.29.0] - 2026-04-08

### Added
- **`.sidecar/` project directory**: persistent project storage for cache, logs, sessions, plans, memory, and scratchpad. Auto-generates `.gitignore` for ephemeral subdirs. `SIDECAR.md` is now loaded from `.sidecar/SIDECAR.md` first with fallback to root
- **Agent loop cycle detection**: tracks the last 4 tool call signatures and halts if the model repeats the same call consecutively — prevents infinite loops
- **`sidecar.agentTemperature` setting**: task-specific temperature (default 0.2) applied when tools are present. Lower values produce more deterministic tool selection across all three backends
- **Tool support auto-detection**: runtime tracking of models that fail to use tools. After 3 consecutive failures, tool definitions are no longer sent — saves context and avoids empty responses
- **Smart context for multi-language files**: AST-based extraction now supports Python (`def`/`class`), Rust (`fn`), Go (`func`), Java/Kotlin methods with full body capture via brace/indent tracking
- **`enhanceContextWithSmartElements`**: post-processing pass for glob-based context that applies AST extraction to code files before injection
- **GitHub Actions workflows**: bot-powered GitHub Releases with VSIX artifacts, issue auto-labeling by keywords (12 labels), and PR test result comments — all via SideCarAI-Bot
- **Support & Contact section**: email (sidecarai.vscode@gmail.com) and links in README and package.json

### Fixed
- **Typing indicator persists after response**: `showTypingIndicator()` now removes any existing indicator before creating a new one; `setLoading: false` sent in `finally` block as safety net
- **Resource leaks on extension deactivate**: dispose `sidecarMdWatcher` file watchers, abort running agent loops, clear pending confirmations, shell session SIGTERM → SIGKILL with 3s timeout
- **Inconsistent error messages**: all three backends now prefix errors with service name (Ollama/OpenAI/Anthropic) and use consistent `request failed: {status} {statusText}` format
- **Error classification gaps**: added ENOTFOUND, EADDRNOTAVAIL, EHOSTUNREACH, ECONNRESET to connection error patterns
- **Smart context bugs**: regex `\Z` → `$` (invalid JS), strip code fences before AST parsing, deduplicate identical branches, copy elements instead of mutating scores
- **Dead code**: removed unused `SmartWorkspaceIndex` stub and its imports

### Changed
- **System prompts restructured**: numbered rules for clearer instruction following; positive instructions ("Read files before editing") instead of negative; multi-step task guidance for cloud models
- **Context injection reordered**: pinned files and relevant content come before the workspace tree — high-value context gets priority in limited context windows. Tree is appended last and truncated if budget is tight
- **Race condition fix**: abort previous agent run BEFORE pushing new user message to prevent concurrent reads/writes on the messages array
- **Config validation**: `clampMin()` helper validates all numeric settings; empty model/URL fall back to defaults

### Performance
- **`parseFileContent` language branching**: detect language once, test only relevant regex patterns per line — O(L×P) → O(L×1)
- **Partial sort in `getRelevantContext`**: filter relevant files first, sort only those instead of full O(n log n) sort
- **Pre-built pinned file Set**: O(1) lookups instead of O(p×f) filter per pinned path
- **`pruneHistory` incremental tracking**: compute chars incrementally and flatten once at end instead of O(m²) repeated `.flat()` calls
- **Shared backend utilities**: `parseThinkTags()` and `toFunctionTools()` extracted into `streamUtils.ts`, removing ~80 lines of duplication
- **Scroll handler debounce**: `requestAnimationFrame` with cached element reference instead of raw scroll event
- **O(1) message delete**: `data-msg-index` attribute instead of O(n) `querySelectorAll` + `indexOf`
- **Workspace excludes**: added `coverage/`, `build/`, `.turbo`, `.cache` to prevent generated files in context

### Tests
- 397 total tests (370 → 397)
- New: streamUtils (parseThinkTags, toFunctionTools), config validation (clampMin), agent loop (timeout, normal completion, empty response), pruneHistory aliasing regression, Ollama backend stream errors (malformed JSON, partial chunks, cross-chunk think tags, empty body, unclosed think tags)

## [0.28.1] - 2026-04-07

### Fixed
- **User message dropped by history pruning**: `pruneHistory()` returns the same array reference when short-circuiting (≤2 messages), so the subsequent `chatMessages.length = 0; chatMessages.push(...prunedMessages)` cleared both arrays — silently dropping the user's message. The model received only a system prompt with no question, returning empty content. Fixed by copying the pruned array before clearing
- **Workspace context exceeding model capacity**: the workspace index injected up to 20K chars of file content into the system prompt regardless of the model's context window, causing local models to return empty responses or extreme latency. Added a context cap for local models (8K tokens) and tool overhead reservation (10K chars) to keep total prompt size manageable
- **No request timeout**: agent loop requests had no timeout — if the model hung (loading, oversized prompt, connection stall), SideCar would wait forever. Added per-request timeout using `Promise.race` on each stream event, defaulting to 120 seconds

### Added
- **`sidecar.requestTimeout` setting**: configurable timeout in seconds for each LLM request (default: 120). If no tokens arrive within this window, the request is aborted with a user-friendly message. Set to 0 to disable
- **`abortableRead` stream helper**: races `reader.read()` against the abort signal so stream body reading can be cancelled — `fetch` only controls the initial request, not ongoing body reads

### Changed
- **Local model context cap**: local models now cap at 8K tokens for context budget calculations instead of trusting the model's advertised context length (e.g. qwen3-coder reports 262K but Ollama's actual `num_ctx` is much smaller)
- **Workspace context budget enforcement**: indexed and glob-based workspace context is now truncated to the remaining system prompt budget, preventing it from exceeding `maxSystemChars`

## [0.28.0] - 2026-04-07

### Added
- **OpenAI-compatible API backend**: works with any server exposing `/v1/chat/completions` — LM Studio, vLLM, llama.cpp, text-generation-webui, OpenRouter, and more. SSE streaming, incremental tool call accumulation, `<think>` tag parsing, and `/v1/models` listing. Set `sidecar.baseUrl` to your server and SideCar auto-detects the protocol
- **`sidecar.provider` setting**: explicit provider selection (`auto`, `ollama`, `anthropic`, `openai`) when auto-detection doesn't match your setup
- **Context pinning**: `@pin:path` syntax in chat and `sidecar.pinnedContext` array setting to always include specific files or folders in context regardless of relevance scoring. Supports folder pinning (includes all files under the prefix)
- **Auto-fix on failure**: `sidecar.autoFixOnFailure` checks VS Code diagnostics after agent writes/edits and feeds errors back to the model for self-correction, up to `sidecar.autoFixMaxRetries` attempts
- **Web page context**: paste a URL in chat and SideCar auto-fetches the page, strips HTML, and includes readable content in context. Configurable via `sidecar.fetchUrlContext`. Max 3 URLs per message, 5000 chars per page
- **Onboarding walkthrough**: first-run "Welcome to SideCar" card with feature overview and "Got it" dismiss. Stored in globalState, never shows again after dismissal
- **Reconnect button**: error card shows "Reconnect" with auto-retry (3 attempts with 2s/4s/8s backoff) before prompting. On success, automatically resends the last user message
- **Typing status line**: descriptive status below bouncing dots — "Connecting to model...", "Building context...", "Sending to model...", "Reasoning...", "Running tool: X...", "Agent step N/M..."
- **Wall-clock timer**: elapsed time counter on the typing indicator so users know SideCar isn't stuck
- **Verbose log blocks collapsed**: system prompt and verbose logs now render collapsed by default instead of expanded
- **Troubleshooting docs**: "Slow model loading" section with macOS Launch Agent setup instructions for pre-warming models at startup

### Changed
- **Three-way backend dispatch**: `SideCarClient.createBackend()` now uses `detectProvider()` with Ollama, Anthropic, and OpenAI backends instead of a binary Ollama/Anthropic check. Non-Ollama, non-Anthropic URLs now default to OpenAI-compatible instead of Anthropic
- **Reachability checks**: both `chatHandlers` and `modelHandlers` use provider-aware endpoint checks (`/api/tags` for Ollama, base URL for Anthropic, `/v1/models` for OpenAI)
- **Model listing**: `listInstalledModels()` uses `GET /v1/models` for OpenAI backends; `listLibraryModels()` skips Ollama library suggestions for non-Ollama providers

### Tests
- 370 total tests (287 → 370)
- New test files: metrics, logger, debounce, parser, apply, git, workspace
- Updated: settings (provider, isAnthropic, detectProvider), workspaceIndex (pinning)
- VS Code mock expanded: Position, Range, WorkspaceEdit, StatusBarAlignment

## [0.27.0] - 2026-04-07

### Added
- **Model pre-warm**: on activation, SideCar sends an empty request to Ollama to load the configured model into memory, eliminating the cold-start delay on the first chat message
- **Typing status line**: the typing indicator now shows a descriptive status below the bouncing dots — "Connecting to model...", "Reasoning...", "Generating response...", "Running tool: Read File...", "Agent step 2/10...", etc.
- **Version and links in system prompt**: SideCar now tells the model its own version, GitHub repo URL, and documentation URL so it can answer user questions about itself
- **Roadmap additions**: large file & monorepo handling, agent action audit log, extension/plugin API, agent run debugger/replay

### Fixed
- **Scroll truncation**: added `min-height: 0` to the messages container to fix a flexbox bug where the scrollbar was cut off when scrolling up
- **Streaming renderer stale state**: `startAssistantMessage` now resets `lastRenderedLen`, `renderTimer`, and `streamingSpan` to prevent stale state from a previous message or error breaking the next render
- **Invalid HTML in streaming span**: changed the streaming container from `<span>` to `<div>` — block elements (`<h3>`, `<p>`, `<ol>`) inside inline elements caused browser rendering quirks
- **Error handler cleanup**: the error handler now properly resets all streaming state (`lastRenderedLen`, `renderTimer`, `streamingSpan`) to prevent cascading render failures
- **Markdown post-processing**: added a DOM post-processing pass that catches un-rendered `**bold**` and `` `code` `` in text nodes using simple string splitting as an independent fallback
- **Silent render failures**: `finishAssistantMessage` is now wrapped in try-catch with a plaintext fallback so rendering errors don't silently lose message content

### Changed
- **Assistant message CSS**: `.message.assistant` now uses `white-space: normal` instead of inheriting `pre-wrap` from `.message`, since the markdown renderer handles line breaks via DOM elements. Block elements inside messages get explicit `white-space: normal` and `display: block`
- **Explicit inline markdown styles**: added CSS rules for `.message strong`, `.message em`, `.message del` to ensure bold, italic, and strikethrough render visibly regardless of inherited styles
- **Docs site redesign**: new custom CSS theme matching the SideCar logo gradient palette (coral → peach → sky blue → steel blue), animated hero section with floating logo, feature card grid, and themed tables/code blocks/nav

## [0.26.0] - 2026-04-07

### Fixed
- **Parallel tool call matching**: tool calls executed in parallel (e.g., multiple file reads) now correctly match results to their originating call via unique IDs. Previously a singleton `active-tool` element caused race conditions — results updated the wrong tool or created duplicate entries
- **Markdown rendering during streaming**: pending (in-progress) text now renders with full markdown (bold, lists, headings) instead of raw `textContent`. Numbered and bullet lists separated by blank lines are now parsed as a single list with multi-line item support

### Performance
- **Incremental DOM rendering**: streaming no longer clears `innerHTML` on every 80ms tick. Only the new slice of safe content is appended, reducing render cost from O(total_content) to O(new_chunk)
- **Message history memory bounds**: in-memory history capped at 200 messages / 2MB. Prevents unbounded memory growth in long agent sessions
- **Search result limits**: `grep` and `search_files` results bumped from 50 to 200, so the agent discovers more context in large codebases
- **stripRepeatedContent O(n) rewrite**: replaced nested-loop paragraph matching with a hash set for O(1) lookups instead of O(n²) scanning
- **Dispatch handler map**: converted 41-case `switch` statement to an object map for O(1) command lookup
- **Token estimation**: improved from `chars / 4` to `chars / 3.5` for more accurate budget tracking; removed unnecessary `JSON.stringify` allocations in tool call and content length sizing
- **Config caching**: `getConfig()` now caches results and invalidates only on `workspace.onDidChangeConfiguration`, eliminating 30+ redundant VS Code config reads per message cycle
- **DOM batching**: session list and diff rendering now build in `DocumentFragment` before a single append; session list uses event delegation instead of per-item listeners
- **Workspace indexing progress**: status bar shows spinning indicator during workspace scan, then file count on completion

## [0.25.0] - 2026-04-07

### Added
- **Persistent shell session**: `run_command` and `run_tests` now use a long-lived shell process. Environment variables, working directory, and shell state persist between commands — just like a real terminal. Supports configurable timeouts (`sidecar.shellTimeout`, default 120s), background commands (`background: true` + `command_id` to check later), and up to 10MB output (`sidecar.shellMaxOutputMB`)
- **Streaming tool output**: shell command output streams to the UI in real-time as it arrives, instead of waiting for the command to finish. The active tool call card auto-opens and shows live output
- **Between-turn context pruning**: conversation history is now automatically compressed before each agent turn. Older turns get progressively heavier compression (tool results truncated, thinking blocks stripped, text summarized). Prevents local models from choking on accumulated context from prior turns
- **Clean tool display**: tool calls now show as `📖 Read src/foo.ts` with icons and spinners instead of raw `read_file(path: src/foo.ts)`. Successful results fold into the tool call card; errors show separately. Matches the polish of Claude Code and Copilot
- **Streaming markdown renderer**: replaced the per-token full re-render with boundary-aware incremental rendering. Only completed markdown blocks are rendered; in-progress text shows with a blinking cursor. Renders debounced at 80ms to reduce DOM thrashing
- **Compact system prompt for local models**: local Ollama models get a ~60% shorter system prompt, saving precious context window for conversation and tool results

### Fixed
- **`getRootUri()` null crash**: now throws a clear error when no workspace folder is open instead of crashing with a null reference
- **`Promise.all` tool execution crash**: one tool failure no longer aborts all parallel tool executions. Uses `Promise.allSettled` and converts rejected promises into error tool results
- **Grep command injection**: user-provided search patterns were interpolated into a shell string. Now uses `execFile` with an args array to prevent shell metacharacter injection
- **MCP async dispose**: `dispose()` was dropping the async `disconnect()` promise. Now catches and logs errors
- **File watcher thrashing**: rapid file creation/deletion triggered `rebuildTree()` on every event. Now debounced to 300ms
- **Unbounded retry backoff**: exponential backoff had no ceiling. Added `maxDelayMs` (default 30s) to cap delay between retries
- **Within-loop compression too conservative**: old `compressMessages()` used a flat 100-char truncation. Now uses distance-based tiers (1000 chars for recent, 200 chars for old) and drops old thinking blocks

### Changed
- `run_command` tool description updated to document persistent session, timeout, and background parameters
- `ToolExecutor` interface now accepts optional `ToolExecutorContext` for streaming callbacks and abort signals
- Agent loop `onToolOutput` callback added to `AgentCallbacks` for streaming tool output to the UI

## [0.24.2] - 2026-04-07

### Added
- **LimitedCache utility**: TTL-based cache with size limits for workspace and AST caches, replacing unbounded `Map` instances that could grow without limit

### Fixed
- **Block markdown infinite loop**: lines with `\r\n` endings caused `appendBlockMarkdown` to loop forever — heading regex failed (JS `.` doesn't match `\r`) but the line was still excluded from paragraph collection, so `i` never advanced. Fixed by normalizing `\r\n` → `\n` before parsing and adding a fallback that always advances the line index
- **Unbounded cache growth in workspace index**: file content and parsed AST caches used plain `Map` with no eviction — replaced with `LimitedCache` (100 entries, 5-minute TTL)
- **Unbounded cache in SmartWorkspaceIndex**: parsed file cache had no size or TTL limits — replaced with `LimitedCache` (50 entries, 5-minute TTL)

## [0.24.0] - 2026-04-07

### Added
- **Block-level markdown rendering**: assistant messages now render headings (`#`–`####`), bullet lists, numbered lists, blockquotes, and horizontal rules. Previously only inline markdown (bold, italic, code, links) was supported
- **Smart context selection**: AST-based code element extraction for JS/TS files in workspace context. Parses functions, classes, imports, and exports, scores them by query relevance, and includes targeted code snippets instead of whole files

### Fixed
- **Autonomous mode ignored pending confirmations**: switching to autonomous mode while the agent was blocked on a confirmation prompt left it stuck. Now auto-resolves all pending confirmations and dismisses the UI cards
- **Agent mode setting not persisted before next message**: `agentMode` config update was fire-and-forget (not awaited), so the next `getConfig()` call could read the stale value
- **Duplicate file parsing in workspace index**: JS/TS files were parsed twice per context request — the first pass was dead code from an earlier stub. Removed the duplicate
- **Redundant string split in extractRelevantContent**: `content.split('\n')` was called inside a loop for every element instead of once. Hoisted above the loop

### Changed
- **`expandThinking` setting description**: clarified wording from "expanded by default" to "expanded instead of collapsed" to avoid implying the setting is enabled by default

## [0.23.0] - 2026-04-06

### Added
- **`<think>` tag parsing**: Ollama reasoning models (qwen3, deepseek-r1) now route `<think>...</think>` content to collapsible "Reasoning" blocks instead of showing raw tags
- **Verbose mode** (`sidecar.verboseMode`): shows system prompt, per-iteration summaries, and tool selection context during agent runs
- **`/verbose` slash command**: toggle verbose mode from the chat
- **`/prompt` slash command**: inspect the full assembled system prompt
- **Expand thinking setting** (`sidecar.expandThinking`): show reasoning blocks expanded by default instead of collapsed

### Fixed
- **Agent used tools on every message**: system prompt told the model to always use tools. Now only uses tools when the user asks for an action — questions get direct text responses
- **Lost messages on concurrent runs**: if user sent a message while the agent was running, it was overwritten. Now merges messages and aborts the previous run
- **Token budget exceeded by 30-50%**: tool call names, inputs, and results weren't counted. Now included in budget tracking
- **Context overflow on large projects**: SIDECAR.md and user system prompt are now capped at 50% of model context with truncation warnings
- **Infinite loop on stripped content**: agent loop could spin when `stripRepeatedContent` emptied the response. Now breaks cleanly
- **Metrics not ended on error**: `metricsCollector.endRun()` moved to `finally` block so it always fires
- **System prompt ordering**: constraints ("only use tools when asked") now appear before tool descriptions so models weight them properly
- **Unclosed `<think>` tags**: stream ending mid-think-tag now emits a closing marker
- **stripRepeatedContent false positives**: threshold raised from 100 to 200 chars; code blocks are now excluded from stripping

## [0.22.2] - 2026-04-06

### Fixed
- **CI publish workflow**: added missing build step before marketplace publish

## [0.22.1] - 2026-04-06

### Fixed
- **Repeated content in model output**: automatically strips verbatim blocks (100+ chars) that the model echoes from earlier assistant messages in the conversation history
- **Per-message delete**: hover-visible delete button on each message for manual cleanup of stuck or unwanted messages

## [0.22.0] - 2026-04-06

### Added
- **Multi-file change summary**: after an agent run, a collapsible panel lists all modified files with inline unified diffs, per-file Revert buttons, and an Accept All button
- **Line-based diff engine**: new `src/agent/diff.ts` computes unified diffs (LCS algorithm) with no external dependencies, truncates at 500 lines
- **GitHub Pages documentation site**: comprehensive docs at `docs/` with 12 pages covering getting started, agent mode, configuration, MCP servers, slash commands, security scanning, SIDECAR.md, hooks, inline chat, GitHub integration, and troubleshooting
- **VS Code Marketplace badge**: README links to the published extension
- **GitHub repo homepage**: repo description and homepage URL point to the marketplace listing

### Changed
- **Package name**: `sidecar` renamed to `sidecar-ai` to avoid VS Code Marketplace naming conflict (display name remains "SideCar")
- **Auto-publish workflow**: GitHub Actions workflow publishes to the marketplace on version tags (`v*`)

## [0.21.0] - 2026-04-06

### Added
- **Inline markdown rendering**: assistant messages now render **bold**, *italic*, ~~strikethrough~~, `inline code`, and [links](url) instead of showing raw markdown syntax
- **Competitive comparison in README**: "Why SideCar?" section with feature comparison table vs Continue, Llama Coder, Twinny, and Copilot

### Fixed
- **Raw markdown in chat**: `**bold**` and other inline markdown was displayed as literal text instead of rendered formatting

### Security
- **XSS-safe markdown renderer**: uses DOM node construction (`createElement` + `textContent`) instead of `innerHTML` — no injection vectors
- **Link URL validation**: only `https://` and `http://` links are rendered as clickable; `javascript:`, `data:`, and other dangerous URIs are displayed as plain text

## [0.20.0] - 2026-04-06

### Added
- **Chat-only model support**: models like gemma2, llama2, and mistral that don't support function calling now work gracefully in chat-only mode
- **Tool support detection**: models are automatically classified as "Full Features" (tool-capable) or "Chat-Only" in the model dropdown
- **Model categorization UI**: model list organized into two sections with dedicated headers and tooltips explaining capabilities
- **Chat-only badge**: `ℹ️ Chat-Only` indicator in the header when using a non-tool-capable model, with interactive tooltip listing available tools
- **Tool calling warning**: warning message displayed when attempting to use tools with unsupported models
- **Code block webview rendering**: code blocks are shown in the webview for chat-only models (with Save/Run buttons) while tool-enabled models silently create files

### Changed
- **Tool support status**: OpenAI backend always supports tools; Ollama backend filters unsupported models (gemma, gemma2, llama2, mistral, neural-chat, starling-lm)
- **Stream event handling**: agent loop now handles warning events from streaming backends

## [0.19.1] - 2026-04-06

### Fixed
- **Webview crash on `/commit` command**: resolved crash when receiving `/commit` or error messages in the webview

## [0.19.0] - 2026-04-06

### Added
- **Conversation history panel**: browse, load, and delete saved conversations from a visual panel. Click the hamburger button or type `/sessions` to open. Conversations auto-save after each assistant response, on new chat, and when VS Code closes
- **Git toolset**: 8 dedicated agent tools (`git_status`, `git_stage`, `git_commit`, `git_log`, `git_push`, `git_pull`, `git_branch`, `git_stash`) backed by a unified `GitCLI` class — replaces ad-hoc `run_command` usage for git operations
- **`/commit` slash command**: generates a commit message from the current diff, stages all changes, and commits — all from the chat input
- **SideCar co-author attribution**: commits made by SideCar automatically include a `Co-Authored-By: SideCar` trailer

### Fixed
- **Abort button**: properly interrupts streaming and batch operations. Extension now sends `done`/`setLoading` on abort so the webview finalizes partial responses and cleans up progress indicators
- **Batch abort handling**: `runBatch` wrapped in try/catch to handle `AbortError` gracefully instead of throwing uncaught
- **Duplicate `updateConnection`** method removed from `SideCarClient`

### Changed
- **`get_git_diff` renamed to `git_diff`** for consistency with the new git tool family
- **Git tools consolidated**: agent tools and slash command handlers now share the `GitCLI` class — no more duplicate implementations
- **Auto-save sessions**: conversations persist automatically to global state. Named from the first user message. Updated in place on subsequent saves

## [0.17.0] - 2026-04-05

### Added
- **Automated test generation**: `/test` command generates tests for the active file or selection. Auto-detects framework (Vitest, Jest, pytest, Go test, JUnit) and creates a properly named test file via code block
- **Lint-fix integration**: `/lint` command auto-detects the project's linter (ESLint, Ruff, golangci-lint) from config files and runs it. Optionally pass a custom command: `/lint npx eslint --fix .`
- **Dependency analysis**: `/deps` command analyzes project dependencies — shows counts, lists, checks for unused packages (Node.js), outdated versions, with Python and Go support
- **Code generation templates**: `/scaffold <type>` generates boilerplate for common patterns (component, api, test, model, cli, hook, middleware, service). Run `/scaffold` with no args to see available templates

## [0.16.0] - 2026-04-05

### Added
- **Diff preview before apply**: in cautious mode, `write_file` and `edit_file` open VS Code's built-in diff editor showing proposed changes before writing to disk. User accepts or rejects via inline confirmation card
- **Token usage & cost dashboard**: `/usage` command shows cumulative token consumption, estimated Anthropic API cost, per-run history, and tool usage breakdown
- **Context window visualization**: `/context` command shows what's in the context window — system prompt, SIDECAR.md, workspace files, conversation history — with token counts per section and a visual usage bar

## [0.15.0] - 2026-04-05

### Added
- **Security scanning**: automatic secrets detection and vulnerability scanning on files written/edited by the agent. Detects AWS keys, GitHub tokens, API keys, private keys, JWTs, connection strings, and more. Flags SQL injection, command injection, XSS (innerHTML), eval usage, and insecure HTTP URLs
- **Diagnostics integration**: `get_diagnostics` tool now includes security scan results alongside compiler errors and warnings
- **Pre-commit secrets gate**: `/scan` slash command and `sidecar.scanStaged` command scan staged git files for secrets before committing. Reads the staged version via `git show` and reports findings in a markdown panel
- **27 new tests** (204 total)

## [0.14.0] - 2026-04-05

### Added
- **Prompt caching (Anthropic API)**: stable system prompt prefix (base + SIDECAR.md + user config) marked with `cache_control: { type: 'ephemeral' }` for server-side caching — ~90% input token cost reduction on cache hits
- **Local SIDECAR.md cache**: file content cached in memory with `FileSystemWatcher` invalidation, eliminates redundant reads per message
- **Inline confirmation cards**: tool approvals, file overwrites, command execution, and undo confirmations now render as styled cards in the chat UI instead of system modal pop-ups

## [0.13.0] - 2026-04-05

### Added
- **Slash command autocomplete**: dropdown appears as you type `/` in the chat input, with command descriptions, arrow key navigation, Tab/Enter to select, Escape to dismiss
- **Keyboard shortcuts**: `Cmd+L` / `Ctrl+L` to clear chat, `Cmd+Shift+U` / `Ctrl+Shift+U` to undo changes, `Cmd+Shift+E` / `Ctrl+Shift+E` to export chat
- **Conversation-aware workspace index**: agent file access (read_file, write_file, edit_file) is tracked and used to boost relevance scores — files the agent touches rank higher in subsequent context. Write access boosts more than read. Relevance decays over time so stale accesses fade

## [0.12.0] - 2026-04-05

### Added
- **Stop button**: Send button toggles to red Stop button during processing to abort the agent loop
- **Activity bar**: animated progress bar below header showing SideCar is actively working
- **Tool execution animation**: pulsing indicator on tool calls while they're running
- **Agent mode dropdown**: header badge replaced with a dropdown to switch between cautious/autonomous/manual modes directly from the UI
- **42 new handler tests**: chatHandlers, githubHandlers, sessionHandlers (170 total)

### Changed
- **Settings cleanup**: removed all 18 deprecated individual settings getters, migrated all callers to `getConfig()`
- Stale `[message with images]` entries filtered from persisted history

## [0.11.0] - 2026-04-05

### Added
- **Slash commands**: `/reset`, `/undo`, `/export`, `/model <name>`, `/help` in chat input
- **Agent progress indicators**: step count, elapsed time, and token usage shown during agent runs
- **Actionable error cards**: classified errors (connection, auth, model, timeout) with retry and settings buttons
- **Stop button**: Send button toggles to red Stop button during processing to abort the agent loop
- **Activity bar**: animated progress bar below header showing SideCar is actively working
- **Tool execution animation**: pulsing indicator on tool calls while they're running
- **Workspace indexing**: persistent in-memory file index with relevance scoring, replaces per-message glob scan. Uses `FileSystemWatcher` for incremental updates
- **Agent mode dropdown**: header badge replaced with a dropdown to switch between cautious/autonomous/manual modes directly from the UI
- **70 new tests**: executor, MCP manager, workspace index, chatHandlers, githubHandlers, sessionHandlers (170 total)

### Changed
- **Sticky scroll**: auto-scroll stops when user scrolls up, floating scroll-to-bottom button appears
- **Incremental streaming**: only re-renders full DOM when code blocks change; plain text updates the trailing span
- **Agent progress pulse**: progress bar and tool calls animate to show SideCar is alive during intensive tasks
- **Settings migration**: all callers migrated from 18 deprecated individual getters to consolidated `getConfig()`, deprecated functions removed from `settings.ts`

### Fixed
- Messages with image content showing `[message with images]` placeholder instead of actual text
- Stale `[message with images]` entries in persisted history from pre-v0.11.0 sessions filtered on load
- Removed `@rolldown/binding-darwin-arm64` from production dependencies (platform-specific dev dep)

## [0.10.0] - 2026-04-05

### Added
- **Dual API backend**: local Ollama models now use native `/api/chat` endpoint with NDJSON streaming and native tool calls; Anthropic API uses `/v1/messages` — backend selected automatically based on URL
- **Text tool call fallback**: models that output tool calls as text (`<function=...>`, `<tool_call>`, JSON fences) are parsed and executed automatically
- **Retry with backoff**: API calls retry on 429/5xx with exponential backoff and Retry-After header support
- **Code quality infrastructure**: Vitest (87+ tests), ESLint, Prettier, husky pre-commit hooks, GitHub Actions CI

### Changed
- **Unified file attachment**: paperclip button now handles both files and images (camera button removed)
- **ChatViewProvider refactored**: split from 1,099-line god class into thin dispatcher (210 lines) + 5 handler modules + ChatState
- **Webview JS extracted**: inline script moved from chatWebview.ts (1,120 lines) to external media/chat.js (163-line template remains)
- **Config consolidated**: typed `SideCarConfig` interface with single `getConfig()` accessor
- **Client factory**: `createClient()` replaces 5 duplicate `new SideCarClient(...)` calls
- **isLocalOllama**: shared helper replaces 3 inline URL checks

### Fixed
- Stale `pendingPlan` state not cleared on new chat
- Hidden file input (`<input type="file">`) rendering visibly due to missing CSS rule
- 6 pre-existing lint warnings (unused imports, let vs const)

## [0.9.0] - 2026-04-05

### Added
- **@ references**: `@file:path`, `@folder:path`, `@symbol:name` syntax in chat messages for precise context inclusion
- **Status bar integration**: shows current model and provider (Ollama/Anthropic), click to toggle chat panel, updates on model/config changes
- **Documentation generation**: `/doc` command generates JSDoc/docstrings for active file or selection
- **Multi-model mid-chat switching**: changing models preserves conversation, updates status bar and config

## [0.8.0] - 2026-04-05

### Added
- **Spec-driven development**: `/spec` command generates structured requirements (EARS notation), design, and dependency-sequenced tasks. Specs saved to `.sidecar/specs/`
- **Event-based hooks**: trigger shell commands on file save, create, or delete events via `sidecar.eventHooks` setting
- **Git commit message generation**: `sidecar.generateCommitMessage` command generates conventional commit messages from staged/unstaged changes
- **Per-prompt cost estimation**: `estimateCost()` utility for Anthropic models (Claude Opus/Sonnet/Haiku pricing)

## [0.7.0] - 2026-04-05

### Added
- **Plan Mode**: generate a plan for review before executing tools (`sidecar.planMode` setting)
- **Danger Mode UX**: autonomous mode shows "Danger Mode" badge, autonomous tool calls audit-logged
- **Batch Processing**: `/batch` command for running multiple tasks sequentially or in parallel (`--parallel`)
- **Session Management**: `/save name` and `/sessions` commands, save/load/delete named sessions across workspaces
- **Custom Skills**: user-defined tools via `sidecar.customTools` setting — shell commands registered as agent tools
- **Insight Reports**: `/insight` command generates activity analytics (tool usage, error rates, token stats)
- **PR Summaries**: `sidecar.summarizePR` command generates PR description from git diff
- **Metrics Collector**: tracks tool calls, durations, tokens, and errors per agent run
- `.vscodeignore` for cleaner extension packaging

## [0.6.0] - 2026-04-05

### Added
- **Per-tool permissions**: allow, deny, or force-ask per tool via `sidecar.toolPermissions`
- **Pre/post execution hooks**: run shell commands before/after tool execution via `sidecar.hooks`. Passes tool name, input, and output as env vars
- **Scheduled tasks**: recurring agent runs on interval via `sidecar.scheduledTasks`. Runs autonomously with output channel logging

## [0.5.0] - 2026-04-05

### Added
- **MCP (Model Context Protocol) client**: connect to any MCP server for external tools
- `sidecar.mcpServers` setting for configuring MCP server connections (stdio transport)
- MCP tools appear transparently alongside built-in tools in the agent loop
- Auto-reconnect when MCP server settings change
- MCP tool calls go through the existing approval flow
- **SIDECAR.md** project instructions: create a `SIDECAR.md` in your project root for persistent project-specific context (like CLAUDE.md for Claude Code)

## [0.4.0] - 2026-04-05

### Added
- **Inline chat** (Cmd+I / Ctrl+I): edit code in place or insert at cursor
- **Enhanced completions**: better FIM prompts, next-edit prediction from recent edits, configurable debounce
- **Extended thinking**: collapsible "Reasoning" blocks from models that support thinking
- **Context compression**: auto-truncates old tool results at 70% of token budget
- **Code review**: `sidecar.reviewChanges` command — AI reviews git diff, opens results as markdown
- `get_git_diff` tool for agent access to git changes
- **Sub-agents**: `spawn_agent` tool lets the model spawn parallel workers for complex tasks
- `sidecar.completionDebounceMs` setting

### Changed
- Completion provider tracks recent edits for next-edit prediction context
- Prefix/suffix limits (8K/2K) for completions to avoid context overflow

## [0.3.0] - 2026-04-04

### Added
- **Agent mode settings**: cautious, autonomous, manual approval modes
- **Safety guardrails**: configurable max iterations (default 25) and token budget (default 100K)
- **Agent mode indicator** in webview header (color-coded badge)
- **Inline chat** (Cmd+I / Ctrl+I): edit code in place or insert at cursor
- `get_diagnostics` tool: read compiler errors and warnings from VS Code
- `run_tests` tool: run test suites with auto-detection (npm, pytest, cargo, go, gradle)
- **Undo/rollback**: revert all AI-made file changes with one click
- ChangeLog tracks file snapshots before modifications

## [0.2.0] - 2026-04-04

### Added
- **Tool use foundation**: structured tool calls via Anthropic Messages API
- **Agent loop**: autonomous multi-step execution (read, edit, test, fix)
- 7 built-in tools: read_file, write_file, edit_file, search_files, grep, run_command, list_directory
- **Tool executor** with approval flow (auto for reads, confirm for writes)
- **Observability**: AgentLogger with VS Code Output Channel ("SideCar Agent")
- **Collapsible tool calls** in chat UI with expandable details

### Changed
- Client streaming overhauled: yields StreamEvent (text + tool_use + stop) instead of raw strings
- Replaced regex-based action detection with proper tool use
- System prompt simplified (tools are self-describing)

## [0.1.0] - 2026-04-04

### Added
- **Anthropic Messages API**: switched from Ollama /api/chat to /v1/messages for dual-provider support
- **Dual backend**: works with local Ollama or Anthropic API (Claude)
- New settings: sidecar.baseUrl, sidecar.apiKey
- **Inline code completions** (Copilot-like, opt-in) with FIM for Ollama
- **File editing**: search/replace format with diff preview
- **Multi-file edits**: atomic WorkspaceEdit application
- **Terminal integration**: commands run in VS Code terminal with output capture
- **Diff preview**: virtual URI scheme with VS Code's built-in diff viewer
- **Chat history persistence** via workspaceState (per-workspace)
- **Active file context**: auto-includes current file and cursor position
- **Context-aware file reading**: detects file paths in messages
- **Code actions**: right-click Explain, Fix, Refactor with SideCar
- **Image support**: paste or attach images for vision models
- **Keyboard shortcut**: Cmd+Shift+I to toggle SideCar panel
- **Streaming indicator**: token count and tok/s display
- **Conversation management**: New Chat (+) and Export as Markdown buttons
- Broadened default file patterns (25+ languages)
- Context window warning for small models

### Changed
- Renamed all IDs from ollama.* to sidecar.*
- Default model changed to qwen3-coder:30b
- Workspace context moved to system field for better model compliance

## [0.0.1] - 2026-04-03

### Added
- Interactive AI chat sidebar with streaming responses from Ollama
- Model selection, switching, and on-demand installation
- Workspace context injection
- File attachment from active editor or file picker
- Code block rendering with Save button
- File move/rename via chat commands
- GitHub integration (clone, PRs, issues, commits, diffs, push/pull, browse)
- Auto-start Ollama when not running
- VS Code theme-aware styling
