# Changelog

All notable changes to the SideCar extension will be documented in this file.

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
