# Changelog

All notable changes to the SideCar extension will be documented in this file.

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
