# SideCar Roadmap

This document tracks planned improvements and features for SideCar. Items are grouped by theme and roughly prioritized within each group.

Last updated: 2026-04-06 (v0.22.2)

---

## Diff & Review UX

### Streaming diff view
Render file changes as they stream in from the agent instead of displaying raw text blocks. Show a live diff that builds up as tokens arrive.

### ~~Multi-file change summary~~ (completed in v0.22.0)
~~After an agent run, show a unified changeset review panel listing all modified files with diffs. Allow the user to review, revert individual files, or accept all.~~

---

## Smarter Context

### Context pinning
Allow users to pin specific files or folders to always be included in context regardless of relevance scoring. Add a `@pin:path` syntax or a UI toggle. Pinned files bypass the token budget limit (up to a configurable cap).

### Smart context selection
Use AST or tree-sitter parsing to include relevant functions, classes, and type definitions instead of whole files. Reduces token usage while providing more targeted context. Fall back to full-file inclusion when parsing is unavailable.

### RAG over documentation
Index project documentation (READMEs, wiki pages, doc comments, markdown files) and include relevant sections in context based on the user's query. Use embedding-based similarity search for retrieval.

### Agent memory
Persistent memory across sessions about project patterns, conventions, user preferences, and past decisions. Stored per-workspace, surfaced in context when relevant. Distinct from chat history — captures insights and learned facts rather than raw conversation.

---

## Observability

### Model comparison
Send the same prompt to multiple models side-by-side and compare responses. Useful for evaluating which model works best for different tasks. Render results in parallel columns.

---

## Existing Planned Features

### Vision support
The extension already handles image attachments and sends them to the model. Expand this with:
- Screenshot-to-code: paste a UI mockup, generate HTML/CSS/React
- Visual debugging: paste error screenshots, have the model diagnose
- Design diffing: compare a mockup to current UI code
Requires vision-capable models (Claude, LLaVA on Ollama).

### Conversation steering
Enable smarter, more interactive conversations between the user and the agent:
- **Clarifying questions**: the model asks for missing context before acting (e.g., "Which test framework are you using?" instead of guessing)
- **Next-step suggestions**: after completing a task, suggest logical follow-ups (e.g., "Want me to add tests for this?" or "Should I run the linter?")
- **Mid-task redirection**: allow the user to interrupt a running agent with new instructions without fully aborting — the agent incorporates the feedback and adjusts its approach

Requires system prompt changes, a feedback injection mechanism in the agent loop, and UI support for inline suggestions.

### Chat threads and branching
Support multiple parallel conversation branches from a single chat:
- Branch a conversation at any message to explore alternatives
- Named threads with independent context
- Thread picker in the UI sidebar
- Per-thread history persistence

---

## Modes & Workflows

### Custom modes
User-defined agent modes (e.g., Architect, Coder, Debugger) with different system prompts, tool access, and behaviors per mode. Ship 3 built-in modes and let users create their own via `sidecar.customModes` setting. Inspired by Kilo Code's mode system.

### Background agents
Run agent tasks concurrently in the background while the user continues working. Build on the existing `spawn_agent` tool. Background agents should request permissions upfront, run independently, and surface results when complete.

### Auto mode
An intelligent approval classifier that evaluates each tool call in real-time to decide whether it needs user confirmation. Sits between cautious and autonomous modes — learns from the user's approval patterns to reduce friction without sacrificing safety.

---

## Model & Provider Support

### OpenRouter support
Add OpenRouter as a third backend option alongside Ollama and Anthropic. A single API key gives access to 400+ models (GPT-4, Gemini, Mistral, Llama, etc.). Requires implementing the OpenRouter API format and model listing.

### Arena mode (model comparison)
Send the same prompt to two models side-by-side and compare responses in parallel columns. Users can vote on which response is better. Useful for evaluating which model works best for different tasks. Inspired by Windsurf's Arena Mode.

---

## Browser & Web

### Browser automation
Built-in browser automation powered by Playwright MCP for testing and interacting with web apps. The agent can navigate pages, click elements, fill forms, take screenshots, and verify UI behavior. Ship as an optional built-in MCP server.

---

## Advanced Context & Intelligence

### Deep codebase indexing
Build a symbol graph with component connections, data models, and dependency tracking. Go beyond file-level context to understand how the codebase fits together — imports, exports, call sites, type hierarchies. Major upgrade to context quality.

### Next edit predictions
After the user makes a change, anticipate ripple effects and suggest connected edits across the codebase (e.g., updating imports, renaming references, fixing type mismatches). Requires deep codebase indexing as a foundation.

### MCP marketplace
A discoverable directory of MCP servers that users can browse and install from within SideCar. Show descriptions, install counts, and one-click setup. Could pull from a curated list or a community registry.

---

## Multi-Agent Orchestration

### Worktree-isolated agents
Each background agent gets its own git worktree — a full isolated copy of the codebase. Multiple agents can edit files simultaneously without conflicts. Worktrees are created on agent start and cleaned up or merged on completion. Config files (`.env`, etc.) are synced to new worktrees automatically. Inspired by Code Squad and Claude Code's agent teams.

### Agent dashboard
A visual panel showing all running and completed agent threads. Displays status (running/done/failed), elapsed time, token usage, and a summary of changes per agent. Supports keyboard navigation to inspect, pause, or cancel individual agents.

### Agent diff review & merge
After a background agent completes, review its changes independently in a diff view scoped to that agent's worktree. Accept, reject, or cherry-pick individual file changes before merging back into the main branch. Prevents unwanted changes from landing automatically.

### Multi-agent task coordination
Coordinate multiple agents working on related tasks from a single prompt. For example: "Agent 1: write the API endpoints, Agent 2: write the tests, Agent 3: write the documentation." Agents run in parallel in isolated worktrees, with a coordination layer to handle dependencies and sequencing.

---

## Quality & Review

### AI code review agent
Multi-agent PR review with specialized sub-agents for bug detection, security analysis, code quality, and test coverage gaps. Review uncommitted changes or full PRs in-editor with inline annotations. Inspired by CodeRabbit and Qodo's multi-agent review architecture.

### Auto-fix on lint/test failure
When linter or tests fail after agent edits, automatically feed errors back to the model and iterate without user intervention. Tighter feedback loop than the current test-driven agent loop — no manual re-prompting needed.

### Test coverage analysis
Show coverage gaps after agent changes, suggest which tests to add, and auto-generate tests targeting uncovered code paths. Integrate with existing coverage tools (c8, istanbul, coverage.py, go test -cover).

---

## Input & Accessibility

### Voice input
Hold a key and speak prompts instead of typing. Use the Web Speech API or a local speech-to-text model for transcription. Approximately 3x faster than typing for natural language instructions. Claude Code and Codex both shipped voice input in early 2026.

### Web page context
Paste a URL in chat and SideCar fetches the page content (docs, Stack Overflow answers, API references) and includes it in context. Useful for referencing external documentation without copy-pasting.

---

## Developer Experience

### Codebase map
Generate a visual or textual overview of the entire codebase structure — files, modules, dependencies, entry points. Helps the model orient in large projects and gives users a bird's-eye view. Could render as a tree, graph, or markdown summary.

### Auto-commit with smart messages
Automatically commit after each successful agent edit with generated conventional commit messages. Opt-in via a setting (`sidecar.autoCommit`). Each commit is atomic and revertable. Inspired by Aider's auto-commit behavior.

### Multi-model routing
Route different task types to different models automatically. For example: fast/small model for completions, strong/large model for complex multi-file edits, cheap model for code review. Configurable via a routing table in settings.

### Cost tracking & budgets
Real-time cost display per message and per agent run. Daily and weekly spending caps with alerts. Budget limits that pause the agent when exceeded. Critical for Anthropic API users managing costs.

### Onboarding walkthrough
Interactive first-run tutorial that guides new users through key features — chat, agent mode, tools, slash commands, SIDECAR.md. Reduces time-to-value for new installs. Shows a "Getting Started" card on first launch.

---

## Enterprise & Team

### Team configuration sharing
Share SIDECAR.md, custom modes, MCP server configs, and tool permissions across a team via a shared config directory or settings sync. Teams define conventions once and every member gets the same agent behavior.

### Telemetry-free guarantee
Explicit privacy mode with zero telemetry, zero usage data collection, and no network calls except to the configured LLM endpoint. Verifiable via source code (already open-source). Key selling point for enterprise and compliance-sensitive environments.

---

## Completed (v0.11.0–v0.22.0)

- [x] Slash commands: `/reset`, `/undo`, `/export`, `/model`, `/help`
- [x] Agent progress indicators (step count, elapsed time, token usage)
- [x] Actionable error cards with retry and settings buttons
- [x] Sticky scroll with floating scroll-to-bottom button
- [x] Incremental streaming renderer
- [x] Workspace indexing with relevance scoring
- [x] Test coverage for executor, MCP manager, workspace index
- [x] Remove `@rolldown/binding-darwin-arm64` from production dependencies
- [x] Stop button (Send toggles to red Stop while processing)
- [x] Activity bar, agent progress pulse, tool execution animation
- [x] Agent mode dropdown (cautious/autonomous/manual) in header
- [x] Migrate `executor.ts`, `extension.ts`, `chatHandlers.ts` to `getConfig()`
- [x] Filter stale `[message with images]` from persisted history
- [x] Handler tests: chatHandlers (25), githubHandlers (11), sessionHandlers (9) — 170 total
- [x] Remove all 18 deprecated settings getters, migrate all callers to `getConfig()`
- [x] Slash command autocomplete dropdown with filtering and keyboard navigation
- [x] Keyboard shortcuts: Cmd+L (clear), Cmd+Shift+U (undo), Cmd+Shift+E (export)
- [x] Conversation-aware workspace index (track agent file reads/writes, decay over time)
- [x] Inline confirmation cards (replace system modal dialogs)
- [x] Prompt caching: Anthropic API cache_control on stable prefix, local SIDECAR.md cache with file watcher
- [x] Security scanning: secrets detection + vulnerability patterns, integrated into executor and diagnostics
- [x] Pre-commit secrets gate: `/scan` command and `sidecar.scanStaged` to scan staged files before commit
- [x] Diff preview before apply: VS Code diff editor for write_file/edit_file in cautious mode
- [x] Token usage & cost dashboard: `/usage` command with per-run history and tool breakdown
- [x] Context window visualization: `/context` command with token counts per section
- [x] Automated test generation: `/test` with framework auto-detection
- [x] Lint-fix integration: `/lint` with linter auto-detection
- [x] Dependency analysis: `/deps` with unused/outdated checks
- [x] Code generation templates: `/scaffold` with 8 built-in template types
- [x] Conversation history panel: browse, load, delete saved conversations with auto-save persistence
- [x] SideCar co-author attribution: commits include `Co-Authored-By: SideCar` trailer
- [x] Unified git toolset: 8 dedicated agent tools (git_status, git_stage, git_commit, git_log, git_push, git_pull, git_branch, git_stash) backed by GitCLI
- [x] `/commit` slash command: generate commit message, stage changes, and commit from chat
- [x] Chat-only model support: graceful handling of models without function calling (gemma2, llama2, mistral, etc.)
- [x] Tool support detection: automatic model categorization as Full Features (Tools) or Chat-Only
- [x] Model dropdown UI organization: separate sections for tool-capable and chat-only models
- [x] Chat-only badge: header indicator with interactive tooltip listing available tools
- [x] Code block webview rendering: chat-only models show code blocks for saving; tool-enabled models create files silently
- [x] Inline markdown rendering: bold, italic, strikethrough, inline code, and links rendered in assistant messages (XSS-safe DOM construction)
- [x] "Why SideCar?" competitive comparison section in README
- [x] Multi-file change summary: collapsible panel with inline diffs, per-file Revert, and Accept All after agent runs
- [x] Line-based unified diff engine (no external dependencies)
- [x] GitHub Pages documentation site (12 pages)
- [x] VS Code Marketplace listing and auto-publish workflow
