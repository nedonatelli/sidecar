# SideCar Roadmap

This document tracks planned improvements and features for SideCar. Items are grouped by theme and roughly prioritized within each group. Only unfinished work appears in the planned sections — completed items are consolidated at the bottom.

Last updated: 2026-04-09 (v0.34.0)

---

## Technical Debt & Performance

### LOW — Config interface sub-object grouping
`SideCarConfig` has 30+ fields. Group into sub-objects (`AgentConfig`, `CompletionConfig`, `ShellConfig`, `ContextConfig`) to improve maintainability. Requires updating all downstream call sites.

### LOW — Real tokenizer integration
Token counting uses character estimation (3.5–4 chars/token) which varies by model. Integrate `js-tiktoken` for OpenAI models and community tokenizers for others. Fall back to character estimation when no tokenizer is available.

### LOW — Incremental markdown parser for streaming
During streaming, the renderer clears `innerHTML` and rebuilds from parsed markdown on each debounced update (~12x/sec). An incremental parser that tracks completed blocks and only renders new content would reduce DOM churn and GC pressure.

### LOW — Message list virtualization
Loading a 200+ message conversation renders all messages to the DOM at once, causing multi-second initial load times. Implement virtual scrolling that only renders messages in/near the viewport.

### LOW — Semantic search for file relevance
Workspace file scoring uses keyword matching only. Integrate local ONNX embeddings (e.g., `@xenova/transformers`) for semantic similarity scoring. Combine with existing keyword scores via weighted fusion.

### Code review findings (v0.34.0 audit)

**Code reuse:**
- `loop.ts:91-102` — hand-rolled char counting duplicates `getContentLength()` from `ollama/types.ts` and misses `tool_use` block sizing. Replace with `agentMessages.reduce((s, m) => s + getContentLength(m.content), 0)`
- `chat.js:527-803` — 6 GitHub card rendering branches repeat identical DOM construction (`gh-card` + `gh-card-title` + `gh-meta` + `gh-link`). Extract `createGhCard()`, `createGhBadge()`, `createGhLink()` helpers (~100 lines savings)
- `chatHandlers.ts` + `usageReport.ts` — budget status formatting (spend, limit, percentage) computed independently in both files. Extract `getBudgetStatus()` on `MetricsCollector`

**Code quality:**
- `chatHandlers.ts:624` — accesses `metricsCollector['currentRun']` via bracket notation to bypass `private`. Add a public `getCurrentTokenEstimate()` accessor instead
- `chatHandlers.ts` + `modelHandlers.ts` — duplicated `isReachable`/`ensureReachable` functions with divergent provider coverage (chatHandlers missing `llmmanager` case). Extract shared utility
- `api.ts:228-237` — `deleteRelease()` bypasses the shared `request()` helper, skipping error handling and duplicating auth headers. Adjust `request()` to handle 204 No Content
- `api.ts` — all responses typed as `Record<string, unknown>` with manual field casting. Define proper response interfaces for type safety
- `githubHandlers.ts` — stringly-typed `msg.action` dispatched via `if/else if` chain. Define a `GitHubAction` union type for compiler exhaustiveness checking
- `huggingface.ts:42-53` — redundant URL regex (protocol-required match, then strip protocol and rematch). Combine into single regex with optional protocol
- `chatHandlers.ts` + `usageReport.ts` — magic number `0.7` for input/output token ratio duplicated. Extract `INPUT_TOKEN_RATIO` constant
- `chat.js:714,721` — release badges reuse `gh-state open`/`gh-state closed` CSS classes meant for PR/issue states. Add dedicated `gh-state tag`/`gh-state draft` classes
- `chat.js:131` — inline HF URL regex can drift from `huggingface.ts` patterns. Consider making extension-side `isHuggingFaceRef()` the single source of truth

**Efficiency:**
- `metrics.ts` — `getDailySpend()` + `getWeeklySpend()` each call `getHistory()` separately, deserializing workspace state twice per chat send. Combine into single-pass `getBudgetStatus()`
- `api.ts:183-192` — `getRelease()` always tries tag endpoint first; numeric IDs cause a guaranteed 404 before fallback. Check if input is numeric and call the ID endpoint directly
- `modelHandlers.ts:54` — no loading indicator during `listGGUFFiles()` HF API fetch (up to 10s timeout). Add `setLoading` messages around the call

### Security audit findings (v0.34.0)

**CRITICAL:**
- `executor.ts:246` — hook system executes shell commands from workspace settings. Malicious `.vscode/settings.json` in a repo could execute arbitrary commands on project open. `SIDECAR_OUTPUT` env var contains tool output that may include attacker-controlled content

**HIGH:**
- `tools.ts:200-205` — `readFile` has NO path validation. `validateFilePath()` exists but is only called by `writeFile`/`editFile`. LLM can read `../../.ssh/id_rsa` or any file on the system and exfiltrate via LLM provider
- No filtering of sensitive files (`.env`, `.pem`, `credentials.json`) before sending to LLM. Security scanner only runs AFTER writes, not before reads
- `chatWebview.ts:168` — CSP allows `unsafe-eval` (required by mermaid.js), significantly weakening XSS protection
- `eventHooks.ts:65` — event hooks pass unsanitized file paths in `SIDECAR_FILE` env var. Crafted filenames with shell metacharacters enable injection

**MEDIUM:**
- `workspace.ts:214-247` — SSRF: `resolveUrlReferences()` fetches any URL without blocking private IPs (169.254.x, 10.x, 192.168.x). Cloud metadata, internal services exposed
- `chat.js:112-119` — SVG sanitizer is regex-based, bypassable via attribute splitting, `<foreignObject>`, HTML entities. Combined with `unsafe-eval`, leads to XSS from LLM-generated diagrams
- `workspace.ts:104-115` — `@file:` references have no path traversal validation. `@file:../../.ssh/id_rsa` sends the file to the LLM
- API keys stored in plaintext `settings.json`. Consider VS Code `SecretStorage` API
- `auth.ts:4` — GitHub token requests full `repo` scope (read/write all repos). Use more granular scopes
- `executor.ts:52-68` — workspace `.vscode/settings.json` can set `toolPermissions: { "run_command": "allow" }`, bypassing approval in cautious mode
- MCP server configs in workspace settings can spawn arbitrary processes on project open

**LOW:**
- `executor.ts:162` — default `confirmFn` auto-approves (`actions[0]` = "Allow"). Should default to deny
- `shellSession.ts:237` — unbounded background command spawning. Add max concurrent limit

### Architecture audit findings (v0.34.0)

**HIGH:**
- `chatHandlers.ts:131-636` — `handleUserMessage` is a 500+ line god function mixing budget checks, context building, system prompt assembly, agent orchestration, and error handling. Needs decomposition
- `extension.ts:49` — MCPManager not in `context.subscriptions`. MCP server child processes leak on deactivate
- `chatHandlers.ts:131-138` — race condition: second `handleUserMessage` can corrupt `state.messages` during post-loop merge. `chatGeneration` guard only covers `clearChat`
- `loop.ts:321` — parallel `write_file` calls to same path produce non-deterministic results. Serialize writes to same file

**MEDIUM:**
- `tools.ts:20-34` — module-level singletons (`shellSession`, `symbolGraph`) create hidden coupling and untestable state
- `chatState.ts:29` — `messages` array mutated from multiple async paths with fragile merge logic
- `mcpManager.ts:46-59` — MCP tool errors lose server/call context, surfaced as generic "Internal error"
- `chatHandlers.ts:97-129` — error classifier missing 429, 500/502/503, content policy violations, token limit exceeded
- `executor.ts:246-248` — hook failures silently swallowed with `console.warn`. Policy hooks don't block tool execution
- `tools.ts:883-904` — `getCustomToolRegistry()` rebuilt on every `findTool()` call in hot loops. Cache with config invalidation
- `executor.ts:27-38` — `executeTool` has 10 positional parameters. Use options object pattern

### AI engineering audit findings (v0.34.0)

**P1 (critical for reliability):**
- `chatHandlers.ts:243-258` — no tool format instructions in system prompt for local models. Biggest reliability gap for Ollama users — models can't reliably call tools without format guidance
- `conversationSummarizer.ts:119` — summary inserted as `role: 'user'`, can create consecutive user messages that Anthropic API rejects. Insert an assistant acknowledgment after summary
- `subagent.ts:62` — sub-agents share mutable `SideCarClient` instance. `updateSystemPrompt` during sub-agent run corrupts parent's prompt

**P2 (significant impact):**
- `anthropicBackend.ts:63` — hardcoded `max_tokens: 4096`. Claude 3.5 Sonnet/Opus support 8192 output tokens. Should be configurable or model-derived
- `anthropicBackend.ts:106` — doesn't use `abortableRead`. Stalled Anthropic streams can't be cancelled after connection established
- `anthropicBackend.ts:154-157` — malformed streaming tool input silently becomes `{}`, causing confusing execution failures
- `openaiBackend.ts:219` — fallback tool call ID `openai_tc_${Date.now()}` collides when multiple calls flush in same millisecond
- `loop.ts:111` vs `chatHandlers.ts:417` — token estimation uses chars/3.5 in loop but chars/4 in pruner. Budget disagreements
- `loop.ts:291-297` — cycle detection only catches exact 2-repetition. Alternating patterns (A,B,A,B) not detected despite CYCLE_WINDOW=4
- `workspaceIndex.ts:38,125` — file content cache has 5-min TTL but no invalidation on file change watcher event. Agent sees stale content
- `workspaceIndex.ts:326-327` — query matching is path-substring only. "fix auth bug" won't boost `auth.ts`
- `ollamaBackend.ts:12-22` — tool support deny list is static, becomes stale as new models release. Consider `ollama show` API check
- `ollamaBackend.ts:281` — discards non-`'stop'` done_reason for tool calls. Newer Ollama versions use tool-specific done reasons

**P3:**
- `loop.ts:79` — `autoFixRetries` never resets between different file writes. After N errors, auto-fix stops for rest of session
- Sub-agents consume tokens not tracked in parent's `totalChars`
- `loop.ts:186-189` — timeout promise timer never cleared on success, creating thousands of pending timers over long runs

### Frontend performance observations (v0.34.0)

- `media/chat.js` — 800+ line file with `@ts-nocheck` and `eslint-disable`. Unminified, no code splitting
- No message list virtualization for 200+ message conversations (already on roadmap)
- Multiple `innerHTML` usages in card rendering — DOM API preferred for security and performance
- 5.2MB `mermaid.min.js` bundled — consider lighter alternative or web worker rendering
- Per-item event listeners on cards instead of event delegation (functional but not ideal at scale)

---

## Diff & Review UX

### Streaming diff view
Render file changes as they stream in from the agent instead of displaying raw text blocks. Show a live diff that builds up as tokens arrive.

### Agent-driven inline edit suggestions (enhancement)
Ghost text tab-to-apply is shipped for `edit_file`. Remaining work: extend to `write_file` and code generation blocks, batch inline edits (multiple pending at once), and syntax-highlighted ghost text.

---

## Smarter Context

### Smart context selection (enhancement)
Initial AST-based JS/TS extraction shipped in v0.24.0. Remaining: full tree-sitter integration for richer parsing, and expanding multi-language support beyond the current regex-based extractors.

### Large file & monorepo handling
Gracefully handle very large files (10k+ lines) and monorepo-scale workspaces without degrading performance. Strategies include streaming file reads with chunked context windows, lazy indexing (only index files on access rather than upfront), depth-limited directory traversal for monorepos, and configurable workspace scope boundaries (`sidecar.workspaceRoots`).

### RAG over documentation
Index project documentation (READMEs, wiki pages, doc comments, markdown files) and include relevant sections in context based on the user's query. Use embedding-based similarity search for retrieval.

### Agent memory
Persistent memory across sessions about project patterns, conventions, user preferences, and past decisions. Stored per-workspace, surfaced in context when relevant. Distinct from chat history — captures insights and learned facts rather than raw conversation.

---

## Observability

### Agent action audit log
Structured log of every agent action — which tool was called, with what arguments, what changed, and when. Stored per-session as JSON, browsable via a `/audit` slash command or the agent dashboard.

### Model decision explanations
Add a "Why?" button on tool calls and code suggestions that asks the model to explain its reasoning for that specific action. Surfaces thinking blocks more prominently and generates on-demand explanations when thinking wasn't captured. Could reuse the existing collapsible thinking block infrastructure.

### Conversation pattern analysis
Analyze usage patterns across sessions to surface actionable insights: which tools the agent uses most, average iterations per task type, common failure modes, and which file types/areas of the codebase get the most agent attention. Render as a `/insights` slash command. Over time, use patterns to suggest workflow improvements.

### Model comparison / Arena mode
Send the same prompt to two models side-by-side and compare responses in parallel columns. Users can vote on which response is better. Useful for evaluating which model works best for different tasks.

### Real-time code profiling integration
Integrate with language-specific profiling tools to surface execution timing data. Best implemented as an MCP server that wraps profilers (Node.js `--prof`, Python `cProfile`, Go `pprof`) and exposes results as tool output. The agent can then read profiling data and make targeted optimization suggestions.

---

## Modes & Workflows

### Conversation steering
Enable smarter, more interactive conversations:
- **Clarifying questions**: the model asks for missing context before acting
- **Next-step suggestions**: after completing a task, suggest logical follow-ups
- **Mid-task redirection**: interrupt a running agent with new instructions without fully aborting

### Chat threads and branching
Support multiple parallel conversation branches from a single chat:
- Branch a conversation at any point to explore alternatives
- Named threads with independent context
- Thread picker in the UI sidebar
- Per-thread history persistence

### Custom modes
User-defined agent modes (e.g., Architect, Coder, Debugger) with different system prompts, tool access, and behaviors per mode. Ship 3 built-in modes and let users create their own via `sidecar.customModes` setting.

### Background agent orchestration (enhancement)
Background command support shipped in v0.18.0. Remaining:
- Full agent spawning with independent state and progress tracking
- Multi-agent task coordination with dependency graphs
- Permission requests upfront for complex workflows
- Agent dashboard for monitoring multiple concurrent agents

### Auto mode
An intelligent approval classifier that evaluates each tool call in real-time to decide whether it needs user confirmation. Sits between cautious and autonomous modes — learns from the user's approval patterns to reduce friction without sacrificing safety.

---

## Model & Provider Support

### Bitbucket / Atlassian support
Add Bitbucket Cloud and Bitbucket Server as alternative git hosting providers alongside GitHub. Requires implementing the Bitbucket REST API v2.0 for PRs, issues, releases, and repo browsing, plus Atlassian OAuth2 or app password authentication. Refactor `GitHubAPI` into a `GitProvider` interface with auto-detection from git remote URL.

### OpenRouter support
Add OpenRouter as a dedicated backend option. A single API key gives access to 400+ models (GPT-4, Gemini, Mistral, Llama, etc.). Currently works via the OpenAI-compatible backend, but a dedicated integration could add model browsing, cost display, and rate limit awareness.

---

## Browser & Web

### Browser automation
Built-in browser automation powered by Playwright MCP for testing and interacting with web apps. The agent can navigate pages, click elements, fill forms, take screenshots, and verify UI behavior. Ship as an optional built-in MCP server.

---

## Advanced Context & Intelligence

### Deep codebase indexing
Build a symbol graph with component connections, data models, and dependency tracking. Go beyond file-level context to understand how the codebase fits together — imports, exports, call sites, type hierarchies. Biggest context quality gap versus paid competitors like Cody and Cursor.

### Cross-file reference awareness
Surface usages, callers, and dependents when the agent reads or edits a symbol. For example, renaming a function should show all call sites, not just the definition. Builds on deep codebase indexing.

### Next edit predictions
After the user makes a change, anticipate ripple effects and suggest connected edits across the codebase (e.g., updating imports, renaming references, fixing type mismatches). Requires deep codebase indexing as a foundation.

### Extension / plugin API
A public API for extending SideCar beyond MCP servers — custom slash commands, custom message renderers, custom tool providers, and lifecycle hooks. Ship a `@sidecar/sdk` package with types and helpers.

### MCP marketplace
A discoverable directory of MCP servers that users can browse and install from within SideCar. Show descriptions, install counts, and one-click setup.

---

## Multi-Agent Orchestration

### Worktree-isolated agents
Each background agent gets its own git worktree — a full isolated copy of the codebase. Multiple agents can edit files simultaneously without conflicts. Worktrees are created on agent start and cleaned up or merged on completion.

### Agent dashboard
A visual panel showing all running and completed agent threads. Displays status (running/done/failed), elapsed time, token usage, and a summary of changes per agent.

### Agent diff review & merge
After a background agent completes, review its changes independently in a diff view scoped to that agent's worktree. Accept, reject, or cherry-pick individual file changes before merging back.

### Multi-agent task coordination
Coordinate multiple agents working on related tasks from a single prompt. Agents run in parallel in isolated worktrees, with a coordination layer to handle dependencies and sequencing.

---

## Security & Permissions

### Granular permission controls for tool categories
Fine-grained permission system for tool groups (file operations, system commands, network access, external APIs). Agents request permission scopes upfront.

### Enhanced sandboxing for dangerous operations
Isolate potentially dangerous tools in constrained environments. Whitelist allowed commands, working directories, and file paths.

### Customizable code analysis rules
User-defined analysis patterns via `sidecar.analysisRules` — regex pattern, severity, and message. Rules run alongside the existing security scanner after agent file writes and surface in `get_diagnostics` output.

---

## Advanced Agent Capabilities

### Multi-agent collaboration workflows
Orchestrate specialized agents that collaborate on complex tasks. Define inter-agent communication patterns, task dependencies, and handoff mechanics.

### Sophisticated planning and task decomposition
Agents use explicit planning steps before execution. Break complex goals into subtasks with dependency graphs, estimate effort/risk per subtask, and execute with backtracking on failure.

### Improved memory management for long-running sessions
Hierarchical memory with immediate recall (current session), working memory (last N turns), and long-term memory (distilled insights). Automatically archive and summarize old turns.

### Mid-task redirection without aborting
Allow users to interrupt a running agent with new instructions. Agent incorporates feedback, adjusts its current plan, and continues execution instead of starting over.

---

## Tool Discovery & Management

### Better integration with external tool registries
Enhanced tool registry integration enabling discovery of community-maintained extensions and MCP servers.

### Dynamic tool loading/unloading
Support hot-reloading of tools without restarting the extension. Tools can be enabled/disabled dynamically via UI toggles.

### Tool versioning and compatibility management
Track tool versions and validate compatibility with active models before use.

---

## User Experience Improvements

### Enhanced visualization of agent reasoning
Detailed visual breakdown of agent thinking: goal decomposition, tool selection rationale, result interpretation, and error recovery strategy. Timeline view with collapsible reasoning blocks.

### Better error handling and recovery mechanisms
Intelligent error parsing that categorizes failures and suggests targeted recovery actions. Human-readable error explanations with links to docs.

### Improved configuration management
Config hierarchy with workspace/folder/global scopes. Visual config inspector showing which setting came from where. Import/export config presets.

### Customizable chat UI themes
The chat panel is a webview with its own CSS, independent of the VS Code editor theme:
- **Built-in themes**: 3–4 presets (Default Dark, Light, High Contrast, Minimal)
- **Custom CSS**: `sidecar.customCSS` setting pointing to a user CSS file injected into the webview
- **Font and density controls**: `sidecar.chatFontSize` and `sidecar.chatDensity` (compact/comfortable/spacious)
- **VS Code theme sync**: read CSS custom properties from the active color theme to auto-match

---

## Integration & Provider Improvements

### Enhanced MCP support
Deeper MCP integration with UI-based server discovery, one-click installation, versioning, and capability advertisement.

### VS Code extension API
APIs for third-party extensions to hook into SideCar workflows. Expose commands, context injection points, and agent event hooks.

### Provider-specific optimizations
Prompt prefixes for code-focused models, parameter tuning per provider, and automatic fallback chains (e.g., OpenAI → Anthropic → Ollama).

---

## Performance Optimizations

### Caching mechanisms for tool results
Cache results from expensive tools (grep on large repos, external API calls) with configurable TTL.

### Importance-based context management
Sliding window context with importance sampling instead of pure recency. High-signal tool results preserved across pruning cycles.

### Parallel execution of independent tool calls
When agent generates multiple independent tool calls in sequence, execute them concurrently instead of serially.

---

## Real-time Collaboration

Multi-user collaboration for SideCar, delivered in phases. Each phase is independently useful.

### Phase 1 — VS Code Live Share integration
Build on VS Code's existing Live Share extension API rather than inventing a collaboration protocol. SideCar registers its chat panel as a Live Share shared service, so all participants see the same conversation, agent actions, and tool call results in real-time. File edits are handled by Live Share's existing operational transform engine. Requires:
- Live Share API integration (`vsls` extension API) to share the chat webview state
- Presence indicators showing which participants are in the SideCar session
- Read-only vs. interactive roles (host controls the agent, guests observe and can send messages)
- Shared conversation history synced via Live Share's shared state API

### Phase 2 — Shared agent control
Multiple users can interact with the same agent session. Requires resolving ownership questions:
- Who can approve/reject tool calls in cautious mode? (Host-only, any participant, or configurable)
- Who can abort a running agent?
- Per-user message attribution (show who sent each message)
- Turn-taking or free-form input modes
- Shared pending confirmation prompts visible to all participants

### Phase 3 — Concurrent agent editing with conflict resolution
Multiple users' agents can edit files simultaneously with automatic conflict resolution:
- CRDT or OT-based merge for concurrent edits to the same file
- Conflict detection when two agents or an agent + human modify overlapping regions
- Visual conflict markers in the diff view with per-user/per-agent attribution
- Merge conflict resolution assistant that understands both sides' intent

### Phase 4 — Standalone collaboration server
For teams that need collaboration without Live Share, a lightweight WebSocket server (shipped as an optional `@sidecar/collab-server` package) that coordinates sessions:
- User identity and authentication (GitHub OAuth, API tokens)
- Persistent shared sessions that survive VS Code restarts
- Session history and audit trail accessible to all team members
- Role-based permissions (admin, editor, viewer)

---

## Input & Accessibility

### Voice input
Hold a key and speak prompts instead of typing. Use the Web Speech API or a local speech-to-text model for transcription.

---

## Completed Items

All completed features, grouped by version. Oldest at the bottom.

### v0.34.0 (2026-04-09)

- [x] **Spending budgets & cost tracking**: `sidecar.dailyBudget` and `sidecar.weeklyBudget` settings with enforcement (blocks at limit, warns at 80%). Per-run cost in metrics. `/usage` dashboard shows budget status
- [x] **Token compaction fixes**: agent loop `totalChars` initialized from existing history (was 0). Post-loop merge no longer re-adds pruned messages
- [x] **LLMManager provider & model discovery**: `llmmanager` as explicit provider. `discoverAllAvailableModels()` uses configured URLs. Startup discovery skipped for remote-only providers
- [x] **HuggingFace model install**: paste a HF URL in model input → fetches GGUF files → VS Code quick pick for quantization → pulls via Ollama's `hf.co/` syntax
- [x] **GitHub release management**: `/releases`, `/release <tag>`, `/release create`, `/release delete` slash commands with release card rendering
- [x] **TypeScript type error cleanup**: zero type errors (added missing imports for `EditBlock`, `ProposedContentProvider`, `StreamingDiffPreviewFn`)
- [x] **Lint-staged tsc fix**: `bash -c 'tsc --noEmit'` wrapper to avoid file arg conflicts with `--project`

### v0.33.0 (2026-04-09)

- [x] Roadmap cleanup: marked 7 completed features with version numbers, added 8 new planned categories

### v0.32.0 (2026-04-08)

- [x] **Context management & tool hardening**: default context cap 8K → 16K, Ollama `num_ctx` runtime detection, adaptive context pruning, `sidecar.contextLimit` setting, file path validation, SVG sanitization
- [x] **`display_diagram` tool**: extract and display diagrams from markdown files

### v0.31.0 (2026-04-08)

- [x] **Mermaid diagram rendering**: lazy-loaded mermaid.js, theme-aware styling, collapsible source view, copy-to-SVG

### v0.30.0–v0.30.1 (2026-04-08)

- [x] **LLMManager backend**: connect to LLMManager on `localhost:11435` with token auth
- [x] **Claude Code skill compatibility**: load skills from `~/.claude/commands/`, workspace `.claude/commands/`, and `.sidecar/skills/`
- [x] **Backend fallback**: `sidecar.fallbackBaseUrl`/`fallbackApiKey`/`fallbackModel` with auto-switch after 2 failures
- [x] **Configurable message ceiling**: `sidecar.agentMaxMessages` setting (default 25)
- [x] **Dual-stage context compression**: conversation summarization + semantic tool result extraction
- [x] **Memory leak fixes**: event delegation for model buttons and image preview buttons
- [x] Stream error tests: 26 new tests for OpenAI and Anthropic backends

### v0.20.0–v0.28.1

- [x] **Auto-fix on failure** (v0.20.0): diagnostics fed back to model in retry loop
- [x] **Cost tracking dashboard** (v0.20.0): `/usage` command with per-run history and cost estimates
- [x] **Web page context** (v0.21.0): auto-fetch URLs in chat messages
- [x] **Onboarding walkthrough** (v0.22.0): first-run Getting Started card
- [x] **Multi-file change summary** (v0.22.0): collapsible diffs, per-file Revert, Accept All
- [x] **Smart context selection** (v0.24.0): AST-based JS/TS extraction with query relevance scoring
- [x] **Context pinning** (v0.27.0): `@pin:path` syntax and `sidecar.pinnedContext` setting
- [x] **OpenAI-compatible backend** (v0.28.0): LM Studio, vLLM, llama.cpp, OpenRouter support
- [x] Vision support (v0.10.0+): image attachments for vision models
- [x] Auto-commit with smart messages
- [x] Agent run debugger / replay
- [x] Codebase map
- [x] Multi-model routing
- [x] AI code review agent (multi-agent PR review)
- [x] Test coverage analysis
- [x] CI/CD pipeline integrations
- [x] Project management tool integrations (Jira, Linear, GitHub Issues)
- [x] Enhanced debugging capabilities (breakpoints, variable inspection, call stack)
- [x] Improved collaboration features (multi-user awareness, conflict detection)
- [x] Team configuration sharing
- [x] Telemetry-free guarantee

### Core infrastructure (v0.11.0–v0.19.0)

- [x] Agent loop cycle detection: halt on repeated identical tool calls
- [x] Task-specific temperature: `sidecar.agentTemperature` (default 0.2)
- [x] Tool support auto-detection: disable tools after 3 consecutive failures
- [x] Optimized system prompts: numbered rules, positive instructions, multi-step guidance
- [x] `.sidecar/` project directory: cache, logs, sessions, plans, memory
- [x] Shared backend utilities: `parseThinkTags()`, `toFunctionTools()` deduplicated
- [x] Config validation: `clampMin()` for all numeric settings
- [x] Error classification: ENOTFOUND, EADDRNOTAVAIL, EHOSTUNREACH, ECONNRESET
- [x] FileSystemWatcher disposal on deactivate
- [x] Agent abort on extension deactivate
- [x] Pending confirmations cleared on abort
- [x] Shell session SIGTERM → SIGKILL timeout on dispose
- [x] Standardized error messages across backends
- [x] Typing indicator fix: remove duplicates, `setLoading: false` in finally
- [x] Scroll handler debounce via requestAnimationFrame
- [x] O(1) message delete via `data-msg-index` attribute
- [x] `parseFileContent` language branching
- [x] Partial sort in `getRelevantContext`
- [x] Pre-built pinned file Set for O(1) lookups
- [x] `pruneHistory` incremental char tracking: flatten once at end
- [x] Multi-language AST extraction: Python, Rust, Go, Java/Kotlin
- [x] Workspace index excludes: `coverage/`, `build/`, `.turbo`, `.cache`
- [x] GitHub Actions: bot-powered releases, issue auto-labeling, PR test result comments
- [x] Per-request timeout for LLM calls (`sidecar.requestTimeout`)
- [x] Local model context cap
- [x] Workspace context budget enforcement
- [x] Fix: user message dropped by pruneHistory array reference aliasing
- [x] Slash commands: `/reset`, `/undo`, `/export`, `/model`, `/help`, `/batch`, `/doc`, `/spec`, `/insight`, `/save`, `/sessions`, `/scan`, `/usage`, `/context`, `/test`, `/lint`, `/deps`, `/scaffold`, `/commit`, `/verbose`, `/prompt`, `/skills`, `/releases`, `/release`
- [x] Agent progress indicators (step count, elapsed time, token usage)
- [x] Actionable error cards with retry and settings buttons
- [x] Sticky scroll with floating scroll-to-bottom button
- [x] Incremental streaming renderer
- [x] Workspace indexing with relevance scoring
- [x] Stop button (Send toggles to Stop while processing)
- [x] Activity bar, agent progress pulse, tool execution animation
- [x] Agent mode dropdown (cautious/autonomous/manual) in header
- [x] Slash command autocomplete dropdown with filtering and keyboard navigation
- [x] Keyboard shortcuts: Cmd+L (clear), Cmd+Shift+U (undo), Cmd+Shift+E (export)
- [x] Conversation-aware workspace index (track file reads/writes, decay over time)
- [x] Inline confirmation cards (replace system modal dialogs)
- [x] Prompt caching: Anthropic API cache_control on stable prefix
- [x] Security scanning: secrets detection + vulnerability patterns
- [x] Pre-commit secrets gate: `/scan` command
- [x] Diff preview: VS Code diff editor for write_file/edit_file in cautious mode
- [x] Inline chat (Cmd+I): edit code in place within the editor
- [x] Inline completions: Copilot-like autocomplete via Ollama FIM
- [x] Conversation history panel: browse, load, delete saved conversations
- [x] Unified git toolset: 8 tools backed by GitCLI
- [x] Chat-only model support with tool support detection and badge
- [x] Rich markdown rendering (block + inline)
- [x] `<think>` tag parsing for reasoning models
- [x] Verbose mode with `/verbose` and `/prompt`
- [x] Context injection reordering, context pruning, compact system prompts
- [x] Persistent shell session with streaming output and background commands
- [x] LimitedCache with TTL and size eviction
- [x] Model pre-warm on extension activation
- [x] GitHub Pages documentation site (12 pages)
- [x] VS Code Marketplace listing and auto-publish workflow
- [x] Reconnect button with auto-retry and exponential backoff
- [x] 506 total tests
