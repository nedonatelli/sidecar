# SideCar Roadmap

Planned improvements and features for SideCar. Audit findings from v0.34.0 comprehensive review are in the Audit Backlog section. All critical fixes were addressed in v0.35.0.

Last updated: 2026-04-12 (v0.46.0)

---

## Recently Completed (v0.45.0)

✅ **Streaming text tool-call interception** (v0.45.0)
- New streaming parser in `streamUtils.ts` normalizes `<function=name>...</function>` and `<tool_call>{...}</tool_call>` blocks into structured `tool_use` events at the Ollama and OpenAI backend boundaries
- qwen3-coder, Hermes, and similar models no longer leak raw XML into chat bubbles
- Handles chunk-boundary partial markers, unknown tool names, and unclosed bodies

✅ **Incremental markdown parser** (v0.45.0)
- `finishAssistantMessage` appends only the unrendered tail instead of wiping and re-parsing the entire assistant message
- Preserves code blocks, lists, and headings built during streaming
- Removes the per-finish O(N) re-parse cost on long replies

✅ **Message list virtualization** (v0.45.0)
- `IntersectionObserver`-based detach/reattach of offscreen text messages in long sessions
- Preserves pixel height via inline style; rehydrates on scroll-back from stored raw markdown
- Rich widgets (audit cards, diffs, mermaid diagrams, confirmation panels) stay fully mounted

✅ **Enhanced reasoning visualization** (v0.45.0)
- Thinking blocks close out when a tool call starts, producing discrete numbered steps
- CSS counter-based step pills (purple for reasoning, blue for tools) with per-step duration badges
- Each reasoning/tool cycle renders as its own timeline segment

✅ **Customizable chat UI themes** (v0.45.0)
- `sidecar.chatDensity` (compact/normal/comfortable), `sidecar.chatFontSize` (10–22), `sidecar.chatAccentColor`
- Applied as CSS custom properties via a new `uiSettings` message, re-pushed on settings change (no reload)
- Accent color values pass through an allowlist CSS-color validator

✅ **Terminal error interception** (v0.45.0)
- `TerminalErrorWatcher` subscribes to `onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`
- Drains output tail, strips ANSI, dedupes within a 30s cooldown window
- On non-zero exit: shows **Diagnose in chat** notification; accepting injects a synthesized prompt with command, exit code, cwd, and output tail
- Skips SideCar's own terminal; silently no-ops when shell integration is unavailable
- Toggle with `sidecar.terminalErrorInterception` (default on)

---

## Recently Completed (v0.42.0)

✅ **Semantic search** (v0.42.0)
- ONNX embedding index using all-MiniLM-L6-v2 (384-dim, ~23MB quantized)
- Cosine similarity search blended with heuristic scoring (configurable weight)
- Binary cache in `.sidecar/cache/embeddings.bin` with content-hash deduplication
- Lazy model loading — extension works immediately, embeddings build in background
- Settings: `sidecar.enableSemanticSearch`, `sidecar.semanticSearchWeight`

✅ **Stub validator** (v0.42.0)
- Post-generation scanner detects 14 placeholder pattern categories in agent-written code
- Auto-reprompts the model to finish incomplete implementations (1 retry)
- Patterns: TODO/FIXME, "real implementation" deferrals, pass-only bodies, "for now" hedging, ellipsis bodies
- False positive filtering for issue tracker references (TODO(#123))

✅ **Streaming diff preview** (v0.42.0)
- File writes in cautious mode open VS Code's diff editor immediately
- Dual accept/reject UI: VS Code notification (in editor) + chat confirmation card — first click wins
- Session-based lifecycle with `update()`/`finalize()`/`dispose()` for incremental content updates

✅ **Structured context rules** (v0.42.0)
- `.sidecarrules` JSON files with glob-pattern matching
- Rule types: `prefer` (boost score), `ban` (exclude), `require` (ensure minimum score)
- Applied during workspace context building alongside heuristic and semantic scoring

✅ **Chat log tmp files** (v0.42.0)
- Every conversation logged as JSONL to `$TMPDIR/sidecar-chatlogs/`
- Records user messages, tool calls, and assistant responses with timestamps

✅ **Message persistence fix** (v0.42.0)
- `serializeContent()` preserves tool_use, tool_result, and thinking blocks during session save
- Messages no longer drop when switching between chats

✅ **Recency bias fixes** (v0.42.0)
- Topic-change detection resets workspace file scores when keyword overlap < 15%
- Agent memory session cap at 2 per search
- Conversation summarizer keeps 2 recent turns (was 4)
- Pending question threshold tightened to 8 words

✅ **Integration test infrastructure** (v0.42.0)
- `@vscode/test-electron` + `@vscode/test-cli` running 32 integration tests inside real VS Code
- Unit test coverage: 50.9% → 62.1% (1003 → 1227 tests)

---

## Previously Completed (v0.41.0)

✅ **Observability suite** (v0.41.0)
- Agent action audit log: structured JSONL in `.sidecar/logs/audit.jsonl`, browsable via `/audit` with filters (`errors`, `tool:name`, `last:N`, `since:date`, `clear`)
- Model decision explanations: "Why?" button on tool call cards with on-demand LLM reasoning
- Conversation pattern analysis: `/insights` command with tool performance stats, sequence analysis, co-occurrence matrix, hourly activity heatmap, error clusters, and suggestions

✅ **MCP capability refinement** (v0.41.0)
- HTTP (Streamable HTTP) and SSE transport support alongside stdio
- `.mcp.json` project-scope config file (Claude Code compatible format)
- Per-tool enable/disable via `tools` config
- Output size limits (`maxResultChars`, default 50K)
- Health monitoring with automatic reconnection (exponential backoff)
- `/mcp` status command showing server status, transport, and tool counts
- `mcp-builder` built-in skill for creating high-quality MCP servers
- Environment variable expansion in HTTP headers (`${VAR}`)

---

## Previously Completed (v0.40.0)

✅ **Deep codebase indexing: call sites & type hierarchies** (v0.40.0)
- Symbol graph extended with `CallEdge` and `TypeEdge` data structures
- Regex parser extracts call sites and extends/implements from JS/TS/JVM files
- New query methods: `getCallers()`, `getSubtypes()`, `getSupertypes()`
- `getSymbolContext()` enriched with caller, supertype, and subtype information
- Graph persistence bumped to version 2

✅ **Conversation steering** (v0.40.0)
- Next-step suggestions after agent loop (clickable buttons in webview)
- Progress summaries every 5 iterations with token/time stats
- Checkpoint prompt at 60% of max iterations — user can stop or continue

✅ **Enhanced agent memory** (v0.40.0)
- Tool chain tracking: records sequences, stores chains of 3+, deduplicates
- Failure learning: tool failures recorded as `failure` type memories
- `recordUse()` auto-called on search retrieval — use counts reflect real usage
- Co-occurrence scoring: `getToolCooccurrences()` and `suggestNextTools()`

---

## Previously Completed (v0.38.0)

✅ **Large file & monorepo handling** (v0.38.0)
- Streaming file reader with configurable threshold (default 50KB)
- Files above threshold use head+tail summary instead of full content
- Lazy indexing for large directories with progress tracking
- Depth-limited traversal (configurable, default unlimited)
- Multi-root workspace support via `sidecar.workspaceRoots` setting
- Prevents context bloat while maintaining code understanding

✅ **RAG over documentation** (v0.38.0)
- Automatic discovery in README*, docs/**, wiki/** folders
- Keyword-based search with title/body scoring (title 3x higher weight)
- Per-message retrieval injected after skills, before workspace context
- Respects remaining context budget (gracefully truncates if needed)
- Configurable via `sidecar.enableDocumentationRAG`, `sidecar.ragMaxDocEntries`, `sidecar.ragUpdateIntervalMinutes`

✅ **Agent memory (persistent learning)** (v0.38.0)
- JSON-based storage in `.sidecar/memory/agent-memories.json`
- Tracks patterns (tool uses), decisions, and conventions
- Use-count tracking and relevance scoring
- Per-message search injected alongside RAG results
- Automatic recording of successful tool executions
- LRU eviction when limit reached (default 500 entries, max 500)
- Configurable via `sidecar.enableAgentMemory`, `sidecar.agentMemoryMaxEntries`
- Auto-loads on startup, persists on every change

---

## Planned Features

### Context & Intelligence

- **Multi-repo cross-talk** — impact analysis across dependent repositories via cross-repo symbol registry

### Editing & Code Quality

- **Next edit suggestions (NES)** — predict next logical edit location after a change using symbol graph ripple analysis
- **Inline edit enhancement** — extend ghost text to `write_file`, batch edits, syntax highlighting
- **Selective regeneration** — "pin and regen" UI: lock good sections, regenerate only unlocked portions
- **Adaptive paste** — intercept paste events and auto-refactor to match local naming, imports, and conventions

### Agent Capabilities

- **Chat threads and branching** — parallel branches, named threads, thread picker, per-thread persistence
- ~~**Custom modes** — user-defined agent modes (Architect, Coder, Debugger) via `sidecar.customModes`~~ → shipped with system prompts, approval behavior, per-tool permissions, and dropdown integration
- ~~**Background agent orchestration** — full spawning with independent state, task coordination, agent dashboard~~ → `/bg` command, BackgroundAgentManager with queue + concurrency limits, dashboard panel with live output
- **Auto mode** — intelligent approval classifier that learns from user patterns
- **Persistent executive function** — multi-day task state in `.sidecar/plans/` tracking progress, decisions, and blockers across sessions

### Multi-Agent

- **Worktree-isolated agents** — each agent in its own git worktree
- **Agent dashboard** — visual panel for running/completed agents
- ~~**Agent diff review & merge** — review agent changes before merging back~~ → new `review` approval mode buffers every `write_file` / `edit_file` into a `PendingEditStore` shadow, surfaces pending changes in a dedicated [Pending Agent Changes TreeView](src/agent/reviewPanel.ts) with accept/discard per-file and all-at-once, opens VS Code's native diff editor for each file, and keeps reads consistent by serving pending content to the agent's own `read_file` calls (v0.46.0)
- **Multi-agent task coordination** — parallel agents with dependency layer
- **Adversarial critic agent** — parallel red-team agent that attacks changes as they're made
- **Remote headless hand-off** — detach tasks to run on a remote server via `@sidecar/headless` CLI

### User Experience

- ~~**Enhanced agent reasoning visualization** — timeline view with collapsible reasoning blocks~~ → numbered step pills, per-step duration badges, and thinking-segment close-on-tool-call (v0.45.0)
- ~~**Customizable chat UI themes** — built-in presets, custom CSS injection, font/density controls, VS Code theme sync~~ → `chatDensity`, `chatFontSize`, `chatAccentColor` with live CSS-variable updates and allowlist validation (v0.45.0)
- ~~**Terminal error interception** — auto-detect errors in VS Code terminal and offer to diagnose in chat~~ → `TerminalErrorWatcher` with dedup, ANSI stripping, and `Diagnose in chat` handoff (v0.45.0)
- **Background doc sync** — silently update README/JSDoc/Swagger when function signatures change *(2/3 shipped: [JSDoc staleness diagnostics](src/docs/jsDocSync.ts) flag orphan/missing `@param` tags with quick fixes; [README sync](src/docs/readmeSync.ts) flags stale call arity in fenced code blocks with rewrite quick fixes. Swagger deferred — framework-specific, no in-repo OpenAPI spec to dogfood against; will revisit when a real use case lands.)*
- **Zen mode context filtering** — `/focus <module>` to restrict context to one directory
- **Dependency drift alerts** — real-time feedback on bundle size, vulnerabilities, and duplicates when deps change
- ~~**Message list virtualization** — virtual scrolling for 200+ message conversations~~ → `IntersectionObserver`-based detach/reattach (v0.45.0)
- ~~**Incremental markdown parser** — avoid full innerHTML rebuild on each streaming update~~ → `finishAssistantMessage` appends only the unrendered tail (v0.45.0)

### Observability

- ~~**Agent action audit log** — structured JSON log, browsable via `/audit` command~~ (v0.41.0)
- ~~**Model decision explanations** — "Why?" button on tool calls with on-demand reasoning~~ (v0.41.0)
- ~~**Conversation pattern analysis** — `/insights` command with usage trends and workflow suggestions~~ (v0.41.0)
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
- ~~**Enhanced MCP support** — UI discovery, one-click install, versioning~~ → HTTP/SSE transport, `.mcp.json` project config, per-tool enable/disable, `/mcp` status, health monitoring (v0.41.0)
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

- ~~SVG sanitizer is regex-based (`chat.js:112`), bypassable with `unsafe-eval` CSP~~ → replaced with DOMParser + allowlist
- ~~`@file:` references (`workspace.ts:104`) have no path traversal validation~~ → path.resolve + startsWith guard
- ~~CSP allows `unsafe-eval` (required by mermaid.js)~~ → documented why, tightened connect-src to specific ports
- ~~Event hooks pass unsanitized file paths in env vars (`eventHooks.ts:65`)~~ → control character stripping
- ~~API keys stored in plaintext `settings.json` — consider VS Code `SecretStorage`~~ → migrated to SecretStorage with auto-migration on activation and `SideCar: Set API Key` command
- ~~GitHub token requests full `repo` scope — overly broad~~ → documented why, added createIfNone:false first
- ~~Workspace settings can bypass tool permissions (`executor.ts:52`)~~ → workspace trust warning added
- ~~MCP configs in workspace settings can spawn arbitrary processes~~ → workspace trust warning added
- ~~Default `confirmFn` auto-approves — should default to deny~~ → defaults to 'Deny'
- ~~Unbounded background command spawning (`shellSession.ts:237`)~~ → 10-process limit with auto-cleanup

### Architecture

- `handleUserMessage` is 500+ lines — needs decomposition
- Parallel `write_file` to same path races — serialize writes
- Module-level singletons (`shellSession`, `symbolGraph`) create hidden coupling
- `messages` array mutated from multiple async paths
- ~~MCP tool errors lose server/call context~~ → wrapped callTool() in try/catch, errors include server name + tool name + input
- ~~Error classifier missing 429, 5xx, content policy, token limit~~ → 4 new error types added: rate_limit, server_error, content_policy, token_limit
- ~~Hook failures silently swallowed — policy hooks don't block~~ → runHook() returns error string; pre-hook failures block tool execution
- ~~Custom tool registry rebuilt every call — cache needed~~ → cached with JSON snapshot key, rebuilds only on config change
- ~~`executeTool` has 10 positional parameters — use options object~~ → ExecuteToolOptions interface, function signature is now (toolUse, opts)

### AI Engineering

- Anthropic backend doesn't use `abortableRead` — stalls can't be cancelled
- Malformed Anthropic tool input silently becomes `{}`
- Token estimation inconsistency: chars/3.5 in loop vs chars/4 in pruner
- ~~Cycle detection only catches exact 2-repetition~~ → detects cycles of length 1..4 with 8-entry window
- ~~File content cache not invalidated on change (5-min stale window)~~ → invalidate on watcher change/delete events
- ~~Query matching is path-substring only~~ → tokenize() splits camelCase/snake_case/paths and matches against query words
- ~~Tool support deny list is static — consider `ollama show` API~~ → replaced with dynamic `/api/show` capabilities probe
- ~~Ollama discards non-`'stop'` done_reason for tool calls~~ → emit `tool_use` stop reason whenever tool calls were yielded
- ~~`autoFixRetries` never resets between file writes~~ → per-file Map<path, retries> tracking
- ~~Sub-agent token usage not tracked in parent's budget~~ → onCharsConsumed callback + SubAgentResult.charsConsumed propagation
- ~~Timeout promise timers never cleared on success~~ → clearTimeout in finally after Promise.race

### Prompt Engineering

- ~~Summarization truncates at 100/150 chars, losing file paths~~ → 200/300 chars with word-boundary smartTruncate
- ~~Workspace context lacks section delimiter~~ → `## Project Documentation`, `## Agent Memory`, `## Workspace Context` headers
- ~~`spawn_agent` description too vague for local models~~ → good/bad use cases, iteration/depth limits documented
- ~~`run_command` doesn't clarify `command`/`command_id` mutual exclusivity~~ → explicit in description + required changed to []
- ~~Tool descriptions lack inline examples (grep, run_command)~~ → examples added to search_files, grep, run_command
- ~~`git_branch`/`git_stash` action params lack `enum` constraints~~ → enum arrays added
- ~~Sub-agent recursion not depth-limited~~ → MAX_AGENT_DEPTH=3 enforced in spawnSubAgent

### UX/UI

- ~~Touch targets too small: scroll-to-bottom 28px, header buttons ~24px, image remove 16px~~ → enlarged to 36px/32px min/24px
- ~~Spacing not on 8pt grid — mix of 2/4/6/8/10/12/14/16/20px values~~ → ~25 off-grid values normalized
- ~~Font size scale ad hoc (10px below minimum readable)~~ → all 10px bumped to 11px
- ~~Panel overlays hardcode `top: 42px`~~ → header-wrapper with `position: relative` + `top: 100%`
- ~~Close panel buttons have no padding (~12x18px click target)~~ → padding + hover background added
- ~~Model list lacks search/filter~~ → search input with auto-focus on open

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

- [x] Spending budgets & cost tracking, token compaction fixes, Kickstand discovery
- [x] HuggingFace model install, GitHub release management, mermaid rendering fix

### v0.30.0–v0.33.0 (2026-04-08–09)

- [x] Context management & tool hardening, Mermaid diagrams, Kickstand backend
- [x] Claude Code skill compatibility, backend fallback, dual-stage context compression

### v0.20.0–v0.28.1

- [x] Auto-fix, cost tracking, web page context, onboarding, multi-file change summary
- [x] Smart context, context pinning, OpenAI-compatible backend, vision support
- [x] Auto-commit, agent debugger, codebase map, multi-model routing, AI code review

### Core (v0.11.0–v0.19.0)

- [x] Agent loop, system prompts, `.sidecar/` directory, error handling, persistent shell
- [x] Context management, UI (slash commands, autocomplete, markdown, activity bar)
- [x] Security scanning, git toolset, inline chat, FIM completions, 848 tests
