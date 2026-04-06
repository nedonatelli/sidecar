# SideCar Roadmap

This document tracks planned improvements and features for SideCar. Items are grouped by effort level and roughly prioritized within each group.

Last updated: 2026-04-05 (v0.13.0)

---

## Bigger Features

### Vision support
The extension already handles image attachments and sends them to the model. Expand this with:
- Screenshot-to-code: paste a UI mockup, generate HTML/CSS/React
- Visual debugging: paste error screenshots, have the model diagnose
- Design diffing: compare a mockup to current UI code
Requires vision-capable models (Claude, LLaVA on Ollama).

### Prompt caching
Cache the system prompt and workspace context between messages to reduce latency and token cost on repeated queries. Track cache invalidation on file changes and settings updates. Particularly valuable for Anthropic API where prompt caching reduces input token costs.

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
