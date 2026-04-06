# SideCar Roadmap

This document tracks planned improvements and features for SideCar. Items are grouped by theme and roughly prioritized within each group.

Last updated: 2026-04-05 (v0.15.0)

---

## Diff & Review UX

### Diff preview before apply
Show proposed changes as a side-by-side diff before writing to disk. Let the user accept or reject changes per-file. Use VS Code's built-in diff editor via the existing `sidecar-proposed` content provider.

### Streaming diff view
Render file changes as they stream in from the agent instead of displaying raw text blocks. Show a live diff that builds up as tokens arrive.

### Multi-file change summary
After an agent run, show a unified changeset review panel listing all modified files with diffs. Allow the user to review, revert individual files, or accept all.

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

## Developer Workflow

### Automated test generation
First-class `/test` command that generates tests for the current file or selection. Auto-detects the test framework (Vitest, Jest, pytest, Go test, etc.), generates test cases, and runs them to verify they pass.

### Lint-fix integration
Auto-run the project's linter after agent edits. Feed lint errors back to the model for automatic fixing. Configurable via `sidecar.lintCommand` setting. Loop until clean or max attempts reached.

### Dependency analysis
Visualize import graphs, find unused dependencies, identify circular imports, and suggest cleanup. Surface as a `/deps` command or integrate into the workspace index.

### Code generation templates
Scaffolding for common patterns — React components, API endpoints, test suites, database models, CLI commands. User-configurable templates stored in `.sidecar/templates/`. Invoked via `/scaffold <template>`.

---

## Observability

### Context window visualization
Show what's currently in the context window: system prompt, workspace files, conversation history, tool results. Display token counts per section and highlight what got truncated. Render as a collapsible panel in the chat UI.

### Token usage & cost dashboard
Track token consumption over time with per-session and cumulative stats. Show input vs output tokens, estimated cost for Anthropic API, and model-specific breakdowns. Surface via `/usage` command or a dedicated panel.

### Model comparison
Send the same prompt to multiple models side-by-side and compare responses. Useful for evaluating which model works best for different tasks. Render results in parallel columns.

---

## Security


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

## Completed (v0.11.0–v0.13.0)

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
