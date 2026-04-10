# SideCar Roadmap

Planned improvements and features for SideCar. Audit findings from v0.34.0 comprehensive review are in the Audit Backlog section. All critical fixes were addressed in v0.35.0.

Last updated: 2026-04-09 (v0.37.0)

---

## Planned Features

### Context & Intelligence

- **Large file & monorepo handling** — streaming reads, lazy indexing, depth-limited traversal, `sidecar.workspaceRoots`
- **RAG over documentation** — embedding-based retrieval over READMEs, wiki, doc comments
- **Agent memory** — persistent per-workspace memory of patterns, conventions, decisions
- **Structured context rules** — `.sidecarrules` with typed constraints (`prefer: functional-components`, `ban: any-type`). Compatible with `.cursorrules`/`.clinerules`
- **Deep codebase indexing** — extend symbol graph with call sites, type hierarchies, cross-file dependency tracking
- **Cross-file reference awareness** — surface callers/dependents when editing a symbol
- **Multi-repo cross-talk** — impact analysis across dependent repositories via cross-repo symbol registry
- **Semantic search for file relevance** — ONNX embeddings instead of keyword-only scoring

### Editing & Code Quality

- **Next edit suggestions (NES)** — predict next logical edit location after a change using symbol graph ripple analysis
- **Streaming diff view** — render file changes as they stream in from the agent
- **Inline edit enhancement** — extend ghost text to `write_file`, batch edits, syntax highlighting
- **Selective regeneration** — "pin and regen" UI: lock good sections, regenerate only unlocked portions
- **Adaptive paste** — intercept paste events and auto-refactor to match local naming, imports, and conventions

### Agent Capabilities

- **Conversation steering** — clarifying questions, next-step suggestions, mid-task redirection
- **Chat threads and branching** — parallel branches, named threads, thread picker, per-thread persistence
- **Custom modes** — user-defined agent modes (Architect, Coder, Debugger) via `sidecar.customModes`
- **Background agent orchestration** — full spawning with independent state, task coordination, agent dashboard
- **Auto mode** — intelligent approval classifier that learns from user patterns
- **Persistent executive function** — multi-day task state in `.sidecar/plans/` tracking progress, decisions, and blockers across sessions

### Multi-Agent

- **Worktree-isolated agents** — each agent in its own git worktree
- **Agent dashboard** — visual panel for running/completed agents
- **Agent diff review & merge** — review agent changes before merging back
- **Multi-agent task coordination** — parallel agents with dependency layer
- **Adversarial critic agent** — parallel red-team agent that attacks changes as they're made
- **Remote headless hand-off** — detach tasks to run on a remote server via `@sidecar/headless` CLI

### User Experience

- **Enhanced agent reasoning visualization** — timeline view with collapsible reasoning blocks
- **Customizable chat UI themes** — built-in presets, custom CSS injection, font/density controls, VS Code theme sync
- **Terminal error interception** — auto-detect errors in VS Code terminal and offer to diagnose in chat
- **Background doc sync** — silently update README/JSDoc/Swagger when function signatures change
- **Zen mode context filtering** — `/focus <module>` to restrict context to one directory
- **Dependency drift alerts** — real-time feedback on bundle size, vulnerabilities, and duplicates when deps change
- **Message list virtualization** — virtual scrolling for 200+ message conversations
- **Incremental markdown parser** — avoid full innerHTML rebuild on each streaming update

### Observability

- **Agent action audit log** — structured JSON log, browsable via `/audit` command
- **Model decision explanations** — "Why?" button on tool calls with on-demand reasoning
- **Conversation pattern analysis** — `/insights` command with usage trends and workflow suggestions
- **Model comparison / Arena mode** — side-by-side prompt comparison with voting
- **Real-time code profiling** — MCP server wrapping language profilers

### Security & Permissions

- **Granular permission controls** — per-category tool permissions, upfront scope requests
- **Enhanced sandboxing** — constrained environments for dangerous tools
- **Customizable code analysis rules** — `sidecar.analysisRules` with regex patterns and severity

### Providers & Integration

- **Bitbucket / Atlassian** — Bitbucket REST API, `GitProvider` interface, auto-detect from remote URL
- **OpenRouter** — dedicated integration with model browsing, cost display, rate limit awareness
- **Browser automation** — Playwright MCP for testing web apps
- **Enhanced MCP support** — UI discovery, one-click install, versioning
- **Extension / plugin API** — `@sidecar/sdk` for custom commands, renderers, tools, hooks
- **MCP marketplace** — discoverable directory with one-click install
- **Voice input** — Web Speech API or local STT model

### Enterprise & Collaboration

- **Centralized policy management** — `.sidecar-policy.json` for org-level enforcement of approval modes, blocked tools, PII redaction, provider restrictions
- **Team knowledge base** — built-in connectors for Confluence, Notion, internal docs
- **Real-time collaboration Phase 1** — VS Code Live Share integration (shared chat, presence, host/guest roles)
- **Real-time collaboration Phase 2** — shared agent control (multi-user approval, message attribution)
- **Real-time collaboration Phase 3** — concurrent editing with CRDT/OT conflict resolution
- **Real-time collaboration Phase 4** — standalone `@sidecar/collab-server` WebSocket package

### Technical Debt

- Config sub-object grouping (30+ fields → sub-objects)
- Real tokenizer integration (`js-tiktoken` for accurate counting)

---

## Audit Backlog (v0.34.0)

Remaining findings from seven comprehensive reviews. Fixed items removed.

### Security

- SVG sanitizer is regex-based (`chat.js:112`), bypassable with `unsafe-eval` CSP
- `@file:` references (`workspace.ts:104`) have no path traversal validation
- CSP allows `unsafe-eval` (required by mermaid.js)
- Event hooks pass unsanitized file paths in env vars (`eventHooks.ts:65`)
- API keys stored in plaintext `settings.json` — consider VS Code `SecretStorage`
- GitHub token requests full `repo` scope — overly broad
- Workspace settings can bypass tool permissions (`executor.ts:52`)
- MCP configs in workspace settings can spawn arbitrary processes
- Default `confirmFn` auto-approves — should default to deny
- Unbounded background command spawning (`shellSession.ts:237`)

### Architecture

- `handleUserMessage` is 500+ lines — needs decomposition
- Parallel `write_file` to same path races — serialize writes
- Module-level singletons (`shellSession`, `symbolGraph`) create hidden coupling
- `messages` array mutated from multiple async paths
- MCP tool errors lose server/call context
- Error classifier missing 429, 5xx, content policy, token limit
- Hook failures silently swallowed — policy hooks don't block
- Custom tool registry rebuilt every call — cache needed
- `executeTool` has 10 positional parameters — use options object

### AI Engineering

- Anthropic backend doesn't use `abortableRead` — stalls can't be cancelled
- Malformed Anthropic tool input silently becomes `{}`
- Token estimation inconsistency: chars/3.5 in loop vs chars/4 in pruner
- Cycle detection only catches exact 2-repetition
- File content cache not invalidated on change (5-min stale window)
- Query matching is path-substring only
- Tool support deny list is static — consider `ollama show` API
- Ollama discards non-`'stop'` done_reason for tool calls
- `autoFixRetries` never resets between file writes
- Sub-agent token usage not tracked in parent's budget
- Timeout promise timers never cleared on success

### Prompt Engineering

- Summarization truncates at 100/150 chars, losing file paths
- Workspace context lacks section delimiter
- `spawn_agent` description too vague for local models
- `run_command` doesn't clarify `command`/`command_id` mutual exclusivity
- Tool descriptions lack inline examples (grep, run_command)
- `git_branch`/`git_stash` action params lack `enum` constraints
- Sub-agent recursion not depth-limited

### UX/UI

- Touch targets too small: scroll-to-bottom 28px, header buttons ~24px, image remove 16px
- Spacing not on 8pt grid — mix of 2/4/6/8/10/12/14/16/20px values
- Font size scale ad hoc (10px below minimum readable)
- Panel overlays hardcode `top: 42px`
- Close panel buttons have no padding (~12x18px click target)
- Model list lacks search/filter

### Code Quality

- `loop.ts:91` — hand-rolled char counting duplicates `getContentLength()`
- `chat.js:527` — 6 card rendering branches repeat identical DOM construction
- `chatHandlers.ts:624` — bracket-notation private field access
- Duplicated `isReachable`/`ensureReachable` with divergent provider coverage
- `deleteRelease()` bypasses shared `request()` helper
- `api.ts` responses typed as `Record<string, unknown>` with manual casting
- Stringly-typed GitHub actions — define `GitHubAction` union type
- Magic number `0.7` for input/output ratio duplicated
- Double workspace state deserialization in budget check
- `chat.js` — 800+ lines with `@ts-nocheck`, unminified, no code splitting
- 5.2MB mermaid.min.js — consider lighter alternative or web worker

---

## Completed Items

### v0.36.0 (2026-04-09)

- [x] **Tree-sitter AST parsing** — 6 languages (TS, TSX, JS, Python, Rust, Go) with CodeAnalyzer interface
- [x] **Built-in web search** — `web_search` tool via DuckDuckGo with offline detection
- [x] **Streaming diff preview** — live diff editor with session-based accept/reject flow
- [x] **Plan mode** — `/plan` command with structured plan output, Execute/Revise/Reject buttons
- [x] **Context compaction button** — `/compact` command and ✂ header button for manual compaction
- [x] **Message copy button** — copies raw markdown (not HTML) to clipboard
- [x] **Attach menu with skills browser** — 📎 button shows file attach + all available skills
- [x] **Skills autocomplete** — loaded skills appear in slash command autocomplete dropdown
- [x] **7 built-in skills** — create-skill, review-code, explain-code, refactor, debug, write-tests, break-this
- [x] **Persistent codebase indexing** — workspace index cached to `.sidecar/cache/` for instant startup
- [x] **`.sidecarignore` support** — custom exclude patterns merged with built-in defaults
- [x] **SSRF protection** — private IP blocklist in URL fetching
- [x] **Anthropic max_tokens** — raised from 4096 to 8192
- [x] **OpenAI tool call ID fix** — monotonic counter prevents collision
- [x] **edit_file docs** — search uniqueness and first-match behavior specified

### v0.35.0 (2026-04-09)

- [x] 4 security fixes (readFile path validation, sensitive file blocklist, workspace hook warning, prompt injection sandbox)
- [x] 5 reliability fixes (few-shot tool examples, MCPManager disposal, summary message sequence, sub-agent isolation, concurrent message race)
- [x] 4 accessibility fixes (focus-visible styles, model button semantics, ARIA roles, theme-safe colors)

### v0.34.0 (2026-04-09)

- [x] Spending budgets & cost tracking, token compaction fixes, LLMManager discovery
- [x] HuggingFace model install, GitHub release management, mermaid rendering fix

### v0.30.0–v0.33.0 (2026-04-08–09)

- [x] Context management & tool hardening, Mermaid diagrams, LLMManager backend
- [x] Claude Code skill compatibility, backend fallback, dual-stage context compression

### v0.20.0–v0.28.1

- [x] Auto-fix, cost tracking, web page context, onboarding, multi-file change summary
- [x] Smart context, context pinning, OpenAI-compatible backend, vision support
- [x] Auto-commit, agent debugger, codebase map, multi-model routing, AI code review

### Core (v0.11.0–v0.19.0)

- [x] Agent loop, system prompts, `.sidecar/` directory, error handling, persistent shell
- [x] Context management, UI (slash commands, autocomplete, markdown, activity bar)
- [x] Security scanning, git toolset, inline chat, FIM completions, 506 tests
