# Changelog

All notable changes to the SideCar extension will be documented in this file.

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
