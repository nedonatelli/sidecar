# SideCar Roadmap

Planned improvements and features for SideCar, organized by priority. Audit findings from v0.34.0 comprehensive review are in the Audit Backlog section. All 13 critical fixes from the v0.34.0 audits were addressed in v0.35.0.

Last updated: 2026-04-09 (v0.35.0)

---

## Planned Features

### Diff & Review UX

- **Streaming diff view** — render file changes as they stream in from the agent
- **Inline edit enhancement** — extend ghost text to `write_file`, batch edits, syntax highlighting

### Smarter Context

- **Smart context enhancement** — full tree-sitter integration beyond current regex-based AST extraction
- **Large file & monorepo handling** — streaming reads, lazy indexing, depth-limited traversal, `sidecar.workspaceRoots`
- **RAG over documentation** — embedding-based retrieval over READMEs, wiki, doc comments
- **Agent memory** — persistent per-workspace memory of patterns, conventions, decisions

### Observability

- **Agent action audit log** — structured JSON log, browsable via `/audit` command
- **Model decision explanations** — "Why?" button on tool calls with on-demand reasoning
- **Conversation pattern analysis** — `/insights` command with tool usage trends, failure modes, workflow suggestions
- **Model comparison / Arena mode** — side-by-side prompt comparison with voting
- **Real-time code profiling** — MCP server wrapping language profilers

### Modes & Workflows

- **Conversation steering** — clarifying questions, next-step suggestions, mid-task redirection
- **Chat threads and branching** — parallel branches, named threads, thread picker, per-thread persistence
- **Custom modes** — user-defined agent modes (Architect, Coder, Debugger) via `sidecar.customModes`
- **Background agent orchestration** — full spawning with independent state, task coordination, agent dashboard
- **Auto mode** — intelligent approval classifier that learns from user patterns

### Model & Provider Support

- **Bitbucket / Atlassian** — Bitbucket REST API, `GitProvider` interface, auto-detect from remote URL
- **OpenRouter** — dedicated integration with model browsing, cost display, rate limit awareness

### Browser & Web

- **Browser automation** — Playwright MCP for testing web apps

### Advanced Context & Intelligence

- **Deep codebase indexing** — symbol graph with imports, exports, call sites, type hierarchies
- **Cross-file reference awareness** — surface callers/dependents when editing a symbol
- **Next edit predictions** — anticipate ripple effects from changes
- **Extension / plugin API** — `@sidecar/sdk` for custom commands, renderers, tools, hooks
- **MCP marketplace** — discoverable directory with one-click install

### Multi-Agent Orchestration

- **Worktree-isolated agents** — each agent in its own git worktree
- **Agent dashboard** — visual panel for running/completed agents
- **Agent diff review & merge** — review agent changes before merging back
- **Multi-agent task coordination** — parallel agents with dependency layer

### Security & Permissions

- **Granular permission controls** — per-category tool permissions, upfront scope requests
- **Enhanced sandboxing** — constrained environments for dangerous tools
- **Customizable code analysis rules** — `sidecar.analysisRules` with regex patterns and severity

### User Experience

- **Enhanced agent reasoning visualization** — timeline view with collapsible reasoning blocks
- **Better error handling** — categorized failures with targeted recovery actions
- **Improved configuration management** — workspace/folder/global scopes, visual inspector, presets
- **Customizable chat UI themes** — built-in presets, custom CSS injection, font/density controls, VS Code theme sync

### Real-time Collaboration

- **Phase 1** — VS Code Live Share integration (shared chat, presence, host/guest roles)
- **Phase 2** — Shared agent control (multi-user approval, message attribution, turn-taking)
- **Phase 3** — Concurrent editing with CRDT/OT conflict resolution
- **Phase 4** — Standalone `@sidecar/collab-server` WebSocket package

### Integration & Performance

- **Enhanced MCP support** — UI discovery, one-click install, versioning
- **VS Code extension API** — third-party hooks into SideCar workflows
- **Provider-specific optimizations** — prompt tuning per provider, fallback chains
- **Tool result caching** — configurable TTL for expensive operations
- **Importance-based context** — sliding window with importance sampling
- **Parallel tool execution** — concurrent independent tool calls
- **Voice input** — Web Speech API or local STT model

### Technical Debt (existing)

- **LOW** — Config sub-object grouping (30+ fields → sub-objects)
- **LOW** — Real tokenizer integration (`js-tiktoken` for accurate counting)
- **LOW** — Incremental markdown parser (avoid full innerHTML rebuild)
- **LOW** — Message list virtualization (200+ messages → virtual scrolling)
- **LOW** — Semantic search for file relevance (ONNX embeddings)

---

## Audit Backlog (v0.34.0)

Detailed findings from seven comprehensive reviews. Items above in "Critical Fixes" are not repeated here.

### Security (remaining after critical fixes)

- SSRF: `workspace.ts:214-247` fetches any URL without blocking private IPs (169.254.x, 10.x, 192.168.x)
- SVG sanitizer is regex-based (`chat.js:112-119`), bypassable. Combined with CSP `unsafe-eval`, leads to XSS
- `@file:` references (`workspace.ts:104-115`) have no path traversal validation
- CSP allows `unsafe-eval` (`chatWebview.ts:168`) — required by mermaid.js but weakens XSS protection
- Event hooks (`eventHooks.ts:65`) pass unsanitized file paths in env vars
- API keys stored in plaintext `settings.json` — consider VS Code `SecretStorage`
- GitHub token requests full `repo` scope (`auth.ts:4`) — overly broad
- Workspace `.vscode/settings.json` can bypass tool permissions (`executor.ts:52-68`)
- MCP server configs in workspace settings can spawn arbitrary processes
- Default `confirmFn` (`executor.ts:162`) auto-approves — should default to deny
- Unbounded background command spawning (`shellSession.ts:237`)

### Architecture

- `handleUserMessage` is 500+ lines (`chatHandlers.ts:131-636`) — needs decomposition
- Parallel `write_file` to same path races (`loop.ts:321`) — serialize writes
- Module-level singletons (`tools.ts:20-34`) create hidden coupling
- `messages` array mutated from multiple async paths (`chatState.ts:29`)
- MCP tool errors lose context (`mcpManager.ts:46-59`) — generic "Internal error"
- Error classifier missing 429, 5xx, content policy, token limit (`chatHandlers.ts:97-129`)
- Hook failures silently swallowed (`executor.ts:246-248`) — policy hooks don't block
- Custom tool registry rebuilt every call (`tools.ts:883-904`) — cache needed
- `executeTool` has 10 positional parameters (`executor.ts:27-38`) — use options object

### AI Engineering

- Anthropic `max_tokens` hardcoded to 4096 (`anthropicBackend.ts:63`) — Claude supports 8192
- Anthropic backend doesn't use `abortableRead` (`anthropicBackend.ts:106`) — stalls can't be cancelled
- Malformed Anthropic tool input silently becomes `{}` (`anthropicBackend.ts:154-157`)
- OpenAI tool call ID collision (`openaiBackend.ts:219`) — `Date.now()` in same millisecond
- Token estimation inconsistency: chars/3.5 in loop vs chars/4 in pruner
- Cycle detection only catches exact 2-repetition (`loop.ts:291-297`)
- File content cache not invalidated on change (`workspaceIndex.ts:38,125`) — 5-min stale window
- Query matching is path-substring only (`workspaceIndex.ts:326-327`)
- Tool support deny list is static (`ollamaBackend.ts:12-22`) — consider `ollama show` API
- Ollama discards non-`'stop'` done_reason for tool calls (`ollamaBackend.ts:281`)
- `autoFixRetries` never resets between file writes (`loop.ts:79`)
- Sub-agent token usage not tracked in parent's budget
- Timeout promise timers never cleared on success (`loop.ts:186-189`)

### Prompt Engineering

- `edit_file` search param doesn't specify uniqueness (`tools.ts:98`) — silent wrong-location edits
- Summarization truncates at 100/150 chars, losing file paths (`conversationSummarizer.ts:192-200`)
- Sub-agents have no system prompt (`subagent.ts:30-35`)
- Workspace context lacks section delimiter (`chatHandlers.ts:347-353`)
- Skill injection lacks isolation instruction (`chatHandlers.ts:319-323`)
- `spawn_agent` description too vague (`tools.ts:869-881`)
- `run_command` doesn't clarify `command`/`command_id` mutual exclusivity (`tools.ts:130-151`)
- No role boundary in system prompt (`chatHandlers.ts:244-245`)
- Summary injected as `role: 'user'` may be treated as request (`conversationSummarizer.ts:119`)
- Tool descriptions lack inline examples (grep, edit_file, run_command)
- `git_branch`/`git_stash` action params lack `enum` constraints (`tools.ts:625,665`)
- Sub-agent recursion not depth-limited

### UX/UI

- Touch targets too small: scroll-to-bottom 28px, header buttons ~24px, image remove 16px
- Spacing not on 8pt grid — mix of 2/4/6/8/10/12/14/16/20px values
- Font size scale ad hoc — 10 distinct values, 10px below minimum readable
- Panel overlays hardcode `top: 42px` — breaks if header height changes
- Close panel buttons have no padding — ~12x18px click target
- No `role="log"` or `aria-live="polite"` on `#messages` container
- No `aria-label` on `#agent-mode-select`
- Autocomplete selection not screen-reader announced
- Model list lacks search/filter for many installed models
- Plan revision uses `window.prompt()` — breaks VS Code UX
- Escape key doesn't close panels

### Code Quality

- `loop.ts:91-102` — hand-rolled char counting duplicates `getContentLength()`
- `chat.js:527-803` — 6 card rendering branches repeat identical DOM construction
- `chatHandlers.ts:624` — bracket-notation private field access on `metricsCollector`
- Duplicated `isReachable`/`ensureReachable` with divergent provider coverage
- `deleteRelease()` bypasses shared `request()` helper (`api.ts:228-237`)
- `api.ts` — all responses typed as `Record<string, unknown>` with manual casting
- Stringly-typed GitHub actions — define `GitHubAction` union type
- Redundant URL regex in `huggingface.ts:42-53`
- Magic number `0.7` for input/output ratio duplicated in two files
- Release badges reuse wrong CSS classes (`chat.js:714,721`)
- HF URL regex drift between `chat.js` and `huggingface.ts`
- Double workspace state deserialization in budget check (`metrics.ts`)
- `getRelease()` guaranteed 404 for numeric IDs (`api.ts:183-192`)
- No loading indicator during HF API fetch (`modelHandlers.ts:54`)

### Frontend Performance

- `media/chat.js` — 800+ lines with `@ts-nocheck` and `eslint-disable`, unminified
- No message list virtualization for 200+ conversations
- Multiple `innerHTML` usages in card rendering
- 5.2MB `mermaid.min.js` bundled — consider lighter alternative or web worker
- Per-item event listeners instead of event delegation

---

## Completed Items

All completed features, grouped by version.

### v0.35.0 (2026-04-09)

- [x] **Security: readFile path validation** — `validateFilePath()` now called on `read_file`, blocking path traversal (`../../.ssh/id_rsa`)
- [x] **Security: sensitive file blocklist** — `.env`, `.pem`, `credentials.json` and 12 other patterns blocked from LLM context
- [x] **Security: workspace hook warning** — warns once per session when hooks come from workspace-level settings (supply-chain protection)
- [x] **Security: prompt injection sandbox** — SIDECAR.md, user system prompt, and skill content now wrapped with boundary instruction preventing override of core rules
- [x] **Reliability: few-shot tool examples** — local model system prompt now includes a 4-step example workflow (read → edit → diagnostics → fix)
- [x] **Reliability: MCPManager disposal** — added to `context.subscriptions` so MCP server child processes are cleaned up on deactivate
- [x] **Reliability: summary message sequence** — assistant acknowledgment inserted after summary to prevent consecutive user messages (Anthropic API rejection)
- [x] **Reliability: sub-agent client isolation** — parent system prompt saved/restored in `finally` block; sub-agents get dedicated role instruction
- [x] **Reliability: concurrent message race** — `chatGeneration` bumped on abort so stale post-loop merge is discarded
- [x] **Accessibility: focus-visible styles** — global `:focus-visible` outline for keyboard navigation
- [x] **Accessibility: model button** — changed from `<span>` to `<button>` with `aria-haspopup`, `aria-expanded`, `aria-label`
- [x] **Accessibility: ARIA roles** — model panel (`dialog`), sessions panel (`dialog`), messages (`log` + `aria-live`), autocomplete (`listbox`), agent mode (`aria-label`)
- [x] **Accessibility: theme-safe colors** — hardcoded `rgba` replaced with `var(--vscode-toolbar-hoverBackground)` and `var(--vscode-diffEditor-*)` theme variables

### v0.34.0 (2026-04-09)

- [x] **Spending budgets & cost tracking**: `sidecar.dailyBudget`/`sidecar.weeklyBudget` with enforcement and `/usage` dashboard
- [x] **Token compaction fixes**: `totalChars` initialized from history; post-loop merge no longer re-adds pruned messages
- [x] **LLMManager provider & model discovery**: configurable URLs, startup skip for remote providers
- [x] **HuggingFace model install**: HF URL → GGUF picker → Ollama `hf.co/` pull
- [x] **GitHub release management**: `/releases`, `/release`, `/release create`, `/release delete`
- [x] **Mermaid rendering fix**: dedup guard, preload on fence open, detach check
- [x] **TypeScript type errors**: zero errors (added missing imports)
- [x] **Lint-staged tsc fix**: `bash -c 'tsc --noEmit'` wrapper

### v0.32.0–v0.33.0 (2026-04-08–09)

- [x] Context management & tool hardening (16K cap, `num_ctx` detection, adaptive pruning, path validation, SVG sanitization)
- [x] `display_diagram` tool, Mermaid diagram rendering
- [x] Roadmap cleanup and expansion

### v0.30.0–v0.30.1 (2026-04-08)

- [x] LLMManager backend, Claude Code skill compatibility, backend fallback
- [x] Configurable message ceiling, dual-stage context compression
- [x] Memory leak fixes (event delegation), stream error tests (26 new)

### v0.20.0–v0.28.1

- [x] Auto-fix on failure, cost tracking dashboard, web page context, onboarding walkthrough
- [x] Multi-file change summary, smart context selection, context pinning, OpenAI-compatible backend
- [x] Vision support, auto-commit, agent debugger/replay, codebase map, multi-model routing
- [x] AI code review, test coverage analysis, CI/CD integrations, project management integrations
- [x] Debugging capabilities, collaboration features, team config sharing, telemetry-free guarantee

### Core infrastructure (v0.11.0–v0.19.0)

- [x] Agent loop (cycle detection, temperature, tool auto-detection, iteration limits)
- [x] System prompts (optimized, compact for local, constraint ordering)
- [x] `.sidecar/` project directory, shared backend utilities, config validation
- [x] Error handling (classification, standardized messages, actionable cards)
- [x] Shell (persistent session, streaming output, background commands, timeouts)
- [x] Context (injection reordering, pruning, workspace indexing, pinning, budget enforcement)
- [x] UI (slash commands with autocomplete, keyboard shortcuts, sticky scroll, stop button, activity bar, agent mode dropdown, inline confirmation cards, markdown rendering)
- [x] Security (secrets scanning, pre-commit gate, diff preview, path validation)
- [x] Integrations (git toolset, GitHub Pages docs, Marketplace, CI/CD workflows)
- [x] Completions (inline chat, FIM autocomplete, conversation history panel)
- [x] Models (chat-only support, tool detection, model pre-warm, `<think>` parsing)
- [x] 506 total tests
