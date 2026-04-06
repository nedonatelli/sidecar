# SideCar Roadmap

This document tracks planned improvements and features for SideCar. Items are grouped by effort level and roughly prioritized within each group.

Last updated: 2026-04-05 (v0.11.0)

---

## Quick Wins

### Migrate deprecated settings getters
Replace the 18 individual deprecated getter functions (`getModel()`, `getBaseUrl()`, `getApiKey()`, etc.) in `src/config/settings.ts` with the consolidated `getConfig()` accessor across all callers: `chatHandlers.ts`, `extension.ts`, `executor.ts`, `eventHooks.ts`.

### Update CHANGELOG for v0.11.0
Document the v0.11.0 release: slash commands, agent progress indicators, actionable error cards, sticky scroll, incremental streaming, workspace indexing, 28 new tests, dependency cleanup.

### Expand test coverage for handlers
Add tests for `src/webview/handlers/chatHandlers.ts` (message handling, context assembly, error classification) and `src/webview/handlers/githubHandlers.ts` (command parsing, GitHub API dispatch).

---

## Medium Effort

### Slash command autocomplete
Show a dropdown/suggestion list as the user types `/` in the chat input. Display available commands with brief descriptions, filter as they type. Frontend-only change in `media/chat.js`.

### Keyboard shortcuts
Add configurable keybindings for common actions:
- `Ctrl+L` / `Cmd+L` — Clear chat (`/reset`)
- `Ctrl+Shift+U` / `Cmd+Shift+U` — Undo all changes (`/undo`)
- `Ctrl+Shift+E` / `Cmd+Shift+E` — Export chat (`/export`)

Register via `package.json` contributes.keybindings and wire to existing commands.

### Conversation-aware workspace index
Enhance `WorkspaceIndex` to track which files the agent reads and writes during a session. Boost relevance scores for recently accessed files so they appear in context on follow-up questions without explicit `@file:` references.

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

### Chat threads and branching
Support multiple parallel conversation branches from a single chat:
- Branch a conversation at any message to explore alternatives
- Named threads with independent context
- Thread picker in the UI sidebar
- Per-thread history persistence

---

## Completed (v0.11.0)

- [x] Slash commands: `/reset`, `/undo`, `/export`, `/model`, `/help`
- [x] Agent progress indicators (step count, elapsed time, token usage)
- [x] Actionable error cards with retry and settings buttons
- [x] Sticky scroll with floating scroll-to-bottom button
- [x] Incremental streaming renderer
- [x] Workspace indexing with relevance scoring
- [x] Test coverage for executor, MCP manager, workspace index
- [x] Remove `@rolldown/binding-darwin-arm64` from production dependencies
