# SideCar Roadmap

This document tracks planned improvements and features for SideCar. Items are grouped by theme and roughly prioritized within each group.

Last updated: 2026-04-09 (v0.34.0)

---

## Technical Debt & Performance (from v0.28.1 audit)

Items identified via architecture, AI engineering, algorithms, and frontend performance reviews. Grouped by priority.

### LOW — Config interface sub-object grouping
`SideCarConfig` has 28+ fields. Group into sub-objects (`AgentConfig`, `CompletionConfig`, `ShellConfig`, `ContextConfig`) to improve maintainability. Requires updating all downstream call sites.

### LOW — Real tokenizer integration
Token counting uses character estimation (3.5–4 chars/token) which varies by model. Integrate `js-tiktoken` for OpenAI models and community tokenizers for others. Fall back to character estimation when no tokenizer is available.

### LOW — Incremental markdown parser for streaming
During streaming, the renderer clears `innerHTML` and rebuilds from parsed markdown on each debounced update (~12x/sec). An incremental parser that tracks completed blocks and only renders new content would reduce DOM churn and GC pressure.

### LOW — Message list virtualization
Loading a 200+ message conversation renders all messages to the DOM at once, causing multi-second initial load times. Implement virtual scrolling that only renders messages in/near the viewport.

### LOW — Semantic search for file relevance
Workspace file scoring uses keyword matching only. Integrate local ONNX embeddings (e.g., `@xenova/transformers`) for semantic similarity scoring. Combine with existing keyword scores via weighted fusion.

---

## Diff & Review UX

### Streaming diff view
Render file changes as they stream in from the agent instead of displaying raw text blocks. Show a live diff that builds up as tokens arrive.

### Agent-driven inline edit suggestions
After the agent proposes a code change, render it as ghost text (inline suggestion) directly in the editor — press Tab to accept, Esc to dismiss. Different from autocomplete: this is agent-initiated, can span multiple lines, and is triggered by chat or agent actions rather than typing. Cursor's "tab to apply" is the benchmark here. Requires VS Code's `InlineCompletionItemProvider` API and a way to pipe agent edits into it.

### ~~Multi-file change summary~~ (completed in v0.22.0)
~~After an agent run, show a unified changeset review panel listing all modified files with diffs. Allow the user to review, revert individual files, or accept all.~~

---

## Smarter Context

### ~~Smart context selection~~ (started in v0.24.0)
~~Use AST or tree-sitter parsing to include relevant functions, classes, and type definitions instead of whole files.~~ Initial implementation landed: lightweight AST parsing extracts functions, classes, imports, and exports from JS/TS files and scores them by query relevance. Full tree-sitter integration and multi-language support still planned.

### Large file & monorepo handling
Gracefully handle very large files (10k+ lines) and monorepo-scale workspaces without degrading performance. Strategies include streaming file reads with chunked context windows, lazy indexing (only index files on access rather than upfront), depth-limited directory traversal for monorepos, and configurable workspace scope boundaries (`sidecar.workspaceRoots`). The workspace indexer and AST parser should degrade gracefully — partial results are better than timeouts.

### RAG over documentation
Index project documentation (READMEs, wiki pages, doc comments, markdown files) and include relevant sections in context based on the user's query. Use embedding-based similarity search for retrieval.

### Agent memory
Persistent memory across sessions about project patterns, conventions, user preferences, and past decisions. Stored per-workspace, surfaced in context when relevant. Distinct from chat history — captures insights and learned facts rather than raw conversation.

---

## Observability

### Agent action audit log
Structured log of every agent action — which tool was called, with what arguments, what changed, and when. Stored per-session as JSON, browsable via a `/audit` slash command or the agent dashboard. Useful for debugging unexpected changes, understanding what an autonomous agent did while unattended, and building trust with cautious users. Pairs with the agent dashboard for visual inspection.

### Model comparison
Send the same prompt to multiple models side-by-side and compare responses. Useful for evaluating which model works best for different tasks. Render results in parallel columns.

---

## Existing Planned Features

### Conversation steering
Enable smarter, more interactive conversations between the user and the agent:
- **Clarifying questions**: the model asks for missing context before acting (e.g., "Which test framework are you using?" instead of guessing)
- **Next-step suggestions**: after completing a task, suggest logical follow-ups (e.g., "Want me to add tests for this?" or "Should I run the linter?")
- **Mid-task redirection**: allow the user to interrupt a running agent with new instructions without fully aborting — the agent incorporates the feedback and adjusts its approach

Requires system prompt changes, a feedback injection mechanism in the agent loop, and UI support for inline suggestions.

### Chat threads and branching
Support multiple parallel conversation branches from a single chat:
- Branch a conversation at

---

## Completed Items (v0.11.0–v0.34.0)

### v0.34.0

- [x] Spending budgets & cost tracking (v0.34.0)
  - `sidecar.dailyBudget` and `sidecar.weeklyBudget` settings with enforcement (blocks agent runs at limit, warns at 80%). Per-run cost recorded in metrics. `/usage` dashboard shows budget status and per-run cost column.

- [x] Token compaction fixes (v0.34.0)
  - Agent loop `totalChars` now initialized from existing conversation history (was 0, so compression threshold never fired). Post-loop merge no longer re-adds messages that pruning had removed.

- [x] LLMManager provider & model discovery (v0.34.0)
  - `llmmanager` as explicit provider. `discoverAllAvailableModels()` probes both Ollama and LLMManager using configured URLs. Startup discovery skipped for remote-only providers.

- [x] TypeScript type error cleanup (v0.34.0)
  - Added missing type imports (`EditBlock`, `ProposedContentProvider`, `StreamingDiffPreviewFn`) — zero type errors.

### Technical Debt & Performance (from v0.28.1 audit)

- [x] Context management & tool hardening (v0.32.0)
  - Local models were hitting context limits after a single large agentic task. Fixed by raising the default context cap (8K → 16K), reading Ollama's actual runtime `num_ctx`, scaling the pruning floor with context window size, and adding progressive compression of the latest turn when over budget. Added `sidecar.contextLimit` setting for user override. Hardened file tools with path validation to prevent hallucinated filenames. SVG output sanitized to prevent XSS. Co-author trailer now links to the SideCarAI-Bot GitHub account.

- [x] Mermaid diagram rendering (v0.31.0)
  - Models can now generate diagrams inline within chat using Mermaid syntax. Chat webview detects mermaid code blocks, lazily loads mermaid.js on first diagram, renders SVG output natively with theme-aware styling, and provides collapsible source view and copy-to-clipboard for SVG.
  - Implementation: Added lazy-loading mermaid.js integration in `chat.js` with CSP updates for `'unsafe-eval'` (required by mermaid). Diagram blocks styled with dedicated layout (`diagram-block`, `diagram-container`, `diagram-source`) that matches SideCar's dark theme. SVG copied on button click after render completes.
  - Use case: `/doc` slash command can now generate architecture diagrams, sequence diagrams, flowcharts, ER diagrams, and other Mermaid diagram types automatically.

- [x] Code block button memory leak (v0.30.1)
  - Image remove buttons and model action buttons in the chat UI had per-button event listeners capturing loop variables and objects in closures. Refactored to use event delegation on container elements with HTML dataset attributes instead. Eliminates closure references and memory leaks in long conversations.
  - Implementation: Both image preview (`imagePreview` container) and model list (`modelList` container) now use single delegated listeners instead of per-element handlers. Pattern was already correctly used for code block buttons.

- [x] Backend fallback (primary → secondary provider) (v0.30.1)
  - Fully functional in v0.30.0+. Users configure secondary provider via `sidecar.fallbackBaseUrl`, `sidecar.fallbackApiKey`, `sidecar.fallbackModel`. After 2 consecutive failures on primary, auto-switches to fallback with warning. Tracks failures via counter that resets on success. Auto-switches back to primary when fallback succeeds.
  - Testing: Added unit tests (v0.30.1) verifying counter reset behavior and configuration support.
  - Remaining: Verbose logging for fallback events (low priority — console warnings already visible)

- [x] OpenAI and Anthropic stream error tests
  - Added comprehensive stream error path tests for both OpenAI and Anthropic backends: malformed JSON, partial chunks, mid-stream errors, tool call accumulation, malformed tool arguments, multiple sequential tool calls, missing delta fields, abrupt stream termination, and complete/non-streaming error paths. 26 new tests total.

- [x] Consolidate parseTextToolCalls regex passes
  - `parseTextToolCalls()` in `loop.ts` already uses a single combined regex matching all three patterns (function tags, tool_call tags, JSON code fences) in one pass.

- [x] parseThinkTags index tracking
  - `parseThinkTags()` in `streamUtils.ts` already uses index tracking via a `pos` variable instead of repeated `content.slice()` calls, reducing GC pressure during heavy thinking output.

### Smarter Context

- [x] Context pinning (v0.27.0)
  - Users can pin specific files or folders via `@pin:path` syntax or the `sidecar.pinnedContext` setting. Pinned files are always included in context regardless of relevance scoring and bypass the token budget limit up to a configurable cap.
  - Use case: Essential for project instructions, configuration files, and frequently-referenced documentation.

### Existing Planned Features

- [x] Vision support (v0.10.0+)
  - Completed: Image attachments fully supported — paste screenshots or attach images for vision models. Chat includes images in messages.
  - Remaining features for full vision support:
    - Screenshot-to-code: paste a UI mockup, generate HTML/CSS/React
    - Visual debugging: paste error screenshots, have the model diagnose
    - Design diffing: compare a mockup to current UI code
  - Requires vision-capable models (Claude, LLaVA on Ollama).

- [x] Auto-fix on failure (v0.20.0)
  - When linter, tests, or diagnostics fail after agent edits, errors are automatically fed back to the model for iteration. No manual re-prompting needed. Uses `get_diagnostics` integration with automatic retry and configurable timeout (`sidecar.autoFixRetries`).
  - Use case: Agents automatically fix compilation errors, test failures, and lint violations in a tight feedback loop.

- [x] Web page context (v0.21.0)
  - Paste URLs in chat and SideCar automatically fetches page content (HTML → markdown) and includes it in context. Works with docs, Stack Overflow answers, API references, and any accessible web pages. Auto-detects URLs in chat messages and expands them.
  - Use case: Reference external documentation without manual copy-pasting, especially useful for referencing framework docs or error resolution pages.

- [x] Cost tracking & budgets (v0.20.0–v0.34.0)
  - Full spending management: `/usage` dashboard with per-run cost breakdown, daily/weekly spending caps (`sidecar.dailyBudget`, `sidecar.weeklyBudget`), budget enforcement that blocks agent runs at limit, 80% threshold warnings in chat, per-run cost in metrics history.

- [x] Onboarding walkthrough (v0.22.0)
  - Interactive first-run tutorial shows a "Getting Started" card on first launch. Guides users through key features: chat basics, agent mode, available tools, slash commands, and SIDECAR.md project instructions. Dismissible and can be re-triggered via command palette.
  - Impact: Reduces time-to-value for new users and improves feature discovery.

### Developer Experience

- [x] Auto-commit with smart messages
  - Automatically commit after each successful agent edit with generated conventional commit messages. Opt-in via a setting (`sidecar.autoCommit`). Each commit is atomic and revertable. Inspired by Aider's auto-commit behavior.

- [x] Agent run debugger / replay
  - When an agent loop produces unexpected results, there's no way to inspect why. Add a replay mode that records the full agent trace (prompts, tool calls, tool results, model responses, branching decisions) and lets the user step through it after the fact. Render as a timeline with expandable steps showing input/output at each turn. Supports pause-and-inspect during live runs too. Essential for debugging complex multi-step agent workflows and for contributors working on the agent loop itself.

- [x] Codebase map
  - Generate a visual or textual overview of the entire codebase structure — files, modules, dependencies, entry points. Helps the model orient in large projects and gives users a bird's-eye view. Could render as a tree, graph, or markdown summary.

- [x] Multi-model routing
  - Route different task types to different models automatically. For example: fast/small model for completions, strong/large model for complex multi-file edits, cheap model for code review. Configurable via a routing table in settings.

### Quality & Review

- [x] AI code review agent
  - Multi-agent PR review with specialized sub-agents for bug detection, security analysis, code quality, and test coverage gaps. Review uncommitted changes or full PRs in-editor with inline annotations. Inspired by CodeRabbit and Qodo's multi-agent review architecture.

- [x] Test coverage analysis
  - Show coverage gaps after agent changes, suggest which tests to add, and auto-generate tests targeting uncovered code paths. Integrate with existing coverage tools (c8, istanbul, coverage.py, go test -cover).

### Integration Improvements

- [x] CI/CD pipeline integrations
  - Native integration with GitHub Actions, GitLab CI, Jenkins, CircleCI, and other CI/CD platforms. Agents can trigger builds, inspect test results, review deployment logs, and propose fixes for failing pipelines. Enables autonomous debugging of CI failures and proactive issue detection.

- [x] Project management tool integrations
  - Connect to Jira, Linear, GitHub Issues, and other issue trackers. Agents can link code changes to tickets, auto-update issue status on completion, extract requirements from tickets into context, and generate PRs tied to specific tasks.

- [x] Enhanced debugging capabilities
  - Integrated debugger support: breakpoint management, variable inspection, call stack navigation. Agents can set breakpoints, step through code, and analyze runtime state to diagnose failures. Supports Node.js, Python, and Go debuggers.

- [x] Improved collaboration features
  - Multi-user awareness: see which team members are editing which files in real-time. Conflict detection when agents and humans edit the same file. Merge conflict resolution assistance. Shared session history and notes within a workspace.

### Enterprise & Team

- [x] Team configuration sharing
  - Share SIDECAR.md, custom modes, MCP server configs, and tool permissions across a team via a shared config directory or settings sync. Teams define conventions once and every member gets the same agent behavior.

- [x] Telemetry-free guarantee
  - Explicit privacy mode with zero telemetry, zero usage data collection, and no network calls except to the configured LLM endpoint. Verifiable via source code (already open-source). Key selling point for enterprise and compliance-sensitive environments.

### All Other Completed Items

- [x] Agent loop cycle detection: halt on repeated identical tool calls
- [x] Task-specific temperature: `sidecar.agentTemperature` (default 0.2) for tool-calling requests
- [x] Tool support auto-detection: track runtime failures, disable tools after 3 misses
- [x] Optimized system prompts: numbered rules, positive instructions, multi-step guidance
- [x] Context injection reordering: relevant files before workspace tree
- [x] `.sidecar/` project directory: foundation for cache, logs, sessions, plans, memory
- [x] Shared backend utilities: `parseThinkTags()`, `toFunctionTools()` deduplicated across backends
- [x] Config validation: `clampMin()` for all numeric settings
- [x] Error classification expansion: ENOTFOUND, EADDRNOTAVAIL, EHOSTUNREACH, ECONNRESET
- [x] FileSystemWatcher disposal on deactivate
- [x] Agent abort on extension deactivate
- [x] Pending confirmations cleared on abort
- [x] Shell session SIGTERM → SIGKILL timeout on dispose
- [x] Standardized error messages across all three backends
- [x] Typing indicator fix: remove duplicates, `setLoading: false` in finally block
- [x] Scroll handler debounce via requestAnimationFrame with cached element ref
- [x] O(1) message delete via `data-msg-index` attribute
- [x] `parseFileContent` language branching: test only relevant patterns per language
- [x] Partial sort in `getRelevantContext`: filter relevant files, sort only those
- [x] Pre-built pinned file Set for O(1) lookups
- [x] `pruneHistory` incremental char tracking: flatten once at end instead of O(m²)
- [x] Multi-language AST extraction: Python, Rust, Go, Java/Kotlin with full body capture
- [x] Smart context `enhanceContextWithSmartElements` wired into fallback path
- [x] Workspace index excludes: `coverage/`, `build/`, `.turbo`, `.cache`
- [x] 27 new tests: streamUtils, config validation, agent loop timeout, pruneHistory regression, backend stream errors
- [x] GitHub Actions: bot-powered releases, issue auto-labeling, PR test result comments
- [x] Per-request timeout for LLM calls with `sidecar.requestTimeout` setting
- [x] Local model context cap to prevent oversized prompts
- [x] Workspace context budget enforcement
- [x] Fix: user message dropped by pruneHistory array reference aliasing
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
- [x] `&lt;think&gt;` tag parsing for Ollama reasoning models (qwen3, deepseek-r1)
- [x] Verbose mode with `/verbose` and `/prompt` slash commands
- [x] Expand thinking setting (`sidecar.expandThinking`)
- [x] System prompt constraint ordering (constraints before tool list)
- [x] Race condition guard and message merge for concurrent agent runs
- [x] Token budget now includes tool call/result sizes
- [x] System prompt bounds checking (50% of model context cap)
- [x] Agent loop break on empty stripped content (prevents infinite loop)
- [x] Block-level markdown rendering: headings, bullet/numbered lists, blockquotes, horizontal rules
- [x] Smart context selection (initial): AST-based JS/TS element extraction with query relevance scoring
- [x] Autonomous mode auto-resolves pending confirmation prompts on switch
- [x] Await agentMode config update before confirming change
- [x] Duplicate file parsing removed from workspace index
- [x] Clarified `expandThinking` setting description
- [x] Fix block markdown infinite loop on `\r\n` line endings
- [x] LimitedCache with TTL and size eviction for workspace and AST caches
- [x] Persistent shell session: env vars, cwd, and state persist between commands
- [x] Streaming tool output: real-time shell output piped to the UI
- [x] Between-turn context pruning: tiered compression of old tool results and thinking blocks
- [x] Clean tool display: icons, display names, spinners, and result badges (matches Claude Code/Copilot polish)
- [x] Streaming markdown renderer: boundary-aware incremental rendering with debounce
- [x] Compact system prompt for local models (~60% shorter)
- [x] Background command support: start long-running processes and check on them later
- [x] Security fix: grep command injection via execFile with args array
- [x] Robustness: Promise.allSettled for parallel tool execution, null safety, retry backoff cap, debounced file watcher
- [x] Model pre-warm: load configured Ollama model into memory on extension activation
- [x] Typing status line with wall-clock timer and phase descriptions
- [x] Version, GitHub URL, and docs URL in system prompt for self-identification
- [x] Docs site redesign: custom CSS matching logo gradient, animated hero, feature cards
- [x] OpenAI-compatible API backend: LM Studio, vLLM, llama.cpp, OpenRouter, etc.
- [x] `sidecar.provider` setting with auto-detection (Ollama, Anthropic, OpenAI)
- [x] Context pinning: `@pin:path` syntax and `sidecar.pinnedContext` setting
- [x] Auto-fix on failure: diagnostics check after writes with configurable retry
- [x] Web page context: auto-fetch URLs in chat messages
- [x] Onboarding walkthrough: first-run Getting Started card
- [x] Reconnect button with auto-retry and exponential backoff
- [x] Scroll fix: `min-height: 0` for flexbox scroll truncation
- [x] Markdown post-processing pass for un-rendered bold/code
- [x] `display_diagram` tool: extract and display diagrams from markdown files
- [x] Adaptive context pruning: progressive compression of latest turn when over budget
- [x] `sidecar.contextLimit` setting for user-configurable context token limit
- [x] Ollama `num_ctx` runtime detection (prefer actual over advertised context length)
- [x] File path validation: reject hallucinated paths in write_file, edit_file, display_diagram
- [x] SVG sanitization for mermaid diagram output
- [x] SideCarAI-Bot co-author attribution on commits
- [x] Verbose log blocks collapsed by default any message to explore alternatives
- Named threads with independent context
- Thread picker in the UI sidebar
- Per-thread history persistence

---

## Modes & Workflows

### Custom modes
User-defined agent modes (e.g., Architect, Coder, Debugger) with different system prompts, tool access, and behaviors per mode. Ship 3 built-in modes and let users create their own via `sidecar.customModes` setting. Inspired by Kilo Code's mode system.

### ✅ PARTIALLY COMPLETED — Background agents (v0.18.0+)
**Completed:** Background command support via `run_command` tool with async execution and result polling. Long-running processes can run in parallel.

**Remaining features for full background agent orchestration:**
- Full agent spawning with independent state and progress tracking
- Multi-agent task coordination with dependency graphs
- Permission requests upfront for complex workflows
- Agent dashboard for monitoring multiple concurrent agents

### Auto mode
An intelligent approval classifier that evaluates each tool call in real-time to decide whether it needs user confirmation. Sits between cautious and autonomous modes — learns from the user's approval patterns to reduce friction without sacrificing safety.

---

## Model & Provider Support

### ~~OpenAI-compatible API support~~ (completed in v0.28.0)
~~Add a generic OpenAI-compatible backend that works with any server exposing the `/v1/chat/completions` endpoint — LM Studio, vLLM, llama.cpp, text-generation-webui, and any OpenAI-compatible provider.~~ Shipped with SSE streaming, incremental tool call accumulation, `<think>` tag parsing, `/v1/models` listing, and `sidecar.provider` setting for explicit backend selection.

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
Build a symbol graph with component connections, data models, and dependency tracking. Go beyond file-level context to understand how the codebase fits together — imports, exports, call sites, type hierarchies. Major upgrade to context quality. Sourcegraph's Cody already ships cross-repo symbol graphs — this is the biggest context quality gap versus paid competitors.

### Cross-file reference awareness
Surface usages, callers, and dependents when the agent reads or edits a symbol. For example, renaming a function should show all call sites, not just the definition. Builds on deep codebase indexing. Key differentiator for Cody and Cursor.

### Next edit predictions
After the user makes a change, anticipate ripple effects and suggest connected edits across the codebase (e.g., updating imports, renaming references, fixing type mismatches). Requires deep codebase indexing as a foundation.

### Extension / plugin API
A public API for extending SideCar beyond MCP servers — custom slash commands, custom message renderers, custom tool providers, and lifecycle hooks (pre-tool, post-tool, pre-commit). Plugins are standard VS Code extensions that depend on `sidecar` and call its API. Ship a `@sidecar/sdk` package with types and helpers. This is what separates tools that grow communities from those that plateau — let power users build on top of SideCar without forking it.

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

### ✅ COMPLETED — Auto-fix on failure (v0.20.0)
**Description & Implementation:** When linter, tests, or diagnostics fail after agent edits, errors are automatically fed back to the model for iteration. No manual re-prompting needed. Uses `get_diagnostics` integration with automatic retry and configurable timeout (`sidecar.autoFixRetries`).

**Use case:** Agents automatically fix compilation errors, test failures, and lint violations in a tight feedback loop.

### Test coverage analysis
Show coverage gaps after agent changes, suggest which tests to add, and auto-generate tests targeting uncovered code paths. Integrate with existing coverage tools (c8, istanbul, coverage.py, go test -cover).

---

## Input & Accessibility

### Voice input
Hold a key and speak prompts instead of typing. Use the Web Speech API or a local speech-to-text model for transcription. Approximately 3x faster than typing for natural language instructions. Claude Code and Codex both shipped voice input in early 2026.

### ✅ COMPLETED — Web page context (v0.21.0)
**Description & Implementation:** Paste URLs in chat and SideCar automatically fetches page content (HTML → markdown) and includes it in context. Works with docs, Stack Overflow answers, API references, and any accessible web pages. Auto-detects URLs in chat messages and expands them.

**Use case:** Reference external documentation without manual copy-pasting, especially useful for referencing framework docs or error resolution pages.

---

## Developer Experience

### Agent run debugger / replay
When an agent loop produces unexpected results, there's no way to inspect why. Add a replay mode that records the full agent trace (prompts, tool calls, tool results, model responses, branching decisions) and lets the user step through it after the fact. Render as a timeline with expandable steps showing input/output at each turn. Supports pause-and-inspect during live runs too. Essential for debugging complex multi-step agent workflows and for contributors working on the agent loop itself.

### Codebase map
Generate a visual or textual overview of the entire codebase structure — files, modules, dependencies, entry points. Helps the model orient in large projects and gives users a bird's-eye view. Could render as a tree, graph, or markdown summary.

### Auto-commit with smart messages
Automatically commit after each successful agent edit with generated conventional commit messages. Opt-in via a setting (`sidecar.autoCommit`). Each commit is atomic and revertable. Inspired by Aider's auto-commit behavior.

### Multi-model routing
Route different task types to different models automatically. For example: fast/small model for completions, strong/large model for complex multi-file edits, cheap model for code review. Configurable via a routing table in settings.

### ✅ COMPLETED — Cost tracking & budgets (v0.20.0–v0.34.0)
**Description & Implementation:** Full spending management for Anthropic API users. `/usage` dashboard with per-run cost breakdown, daily and weekly spending caps (`sidecar.dailyBudget`, `sidecar.weeklyBudget`), budget enforcement that blocks agent runs when limits are reached, and 80% threshold warnings in chat. Per-run cost recorded in metrics history with budget status section in `/usage` report.

**Use case:** Critical for teams and individuals managing API costs — prevents runaway spending during autonomous agent sessions.

### ✅ COMPLETED — Onboarding walkthrough (v0.22.0)
**Description & Implementation:** Interactive first-run tutorial shows a "Getting Started" card on first launch. Guides users through key features: chat basics, agent mode, available tools, slash commands, and SIDECAR.md project instructions. Dismissible and can be re-triggered via command palette.

**Impact:** Reduces time-to-value for new users and improves feature discovery.

---

## Tool Discovery & Management

### Better integration with external tool registries
Enhanced tool registry integration enabling discovery of community-maintained extensions and MCP servers. Surface tool metadata, version history, and compatibility information across different LLM provider ecosystems.

### Dynamic tool loading/unloading
Support hot-reloading of tools without restarting the extension. Tools can be enabled/disabled dynamically via UI toggles in settings. Enables experimentation with new tools and graceful handling of unavailable external services.

### Tool versioning and compatibility management
Track tool versions and validate compatibility with active models before use. Tools can specify minimum/maximum model versions, feature flags, and fallback behavior when incompatible. Prevents silent failures when tool and model combinations are unsupported.

---

## Security & Permissions

### Granular permission controls for tool categories
Fine-grained permission system for tool groups (file operations, system commands, network access, external APIs). Users can allow/deny entire categories or specific tools. Agents request permission scopes upfront (e.g., "This task needs file write + command execution").

### Enhanced sandboxing for dangerous operations
Isolate potentially dangerous tools (run_command, write_file) in constrained environments. Whitelist allowed commands, working directories, and file paths. Prevent shell injection, directory traversal, and excessive resource consumption. Critical for shared environments and untrusted agent workflows.

### Audit logging for tool usage
Comprehensive audit trail of all tool calls: timestamp, tool name, arguments, result, user approval status, and any side effects. Queryable via dashboard. Essential for compliance, debugging unexpected behavior, and building user trust in autonomous agents.

---

## Advanced Agent Capabilities

### Multi-agent collaboration workflows
Orchestrate specialized agents that collaborate on complex tasks. Define inter-agent communication patterns, task dependencies, and handoff mechanics. Example: Research Agent → Analysis Agent → Writing Agent → Review Agent for documentation generation.

### Sophisticated planning and task decomposition
Agents use explicit planning steps before execution. Break complex goals into subtasks with dependency graphs, estimate effort/risk per subtask, and execute with backtracking on failure. Inspired by o1-preview's chain-of-thought planning.

### Improved memory management for long-running sessions
Persistent session memory across days/weeks without accumulating bloat. Implement hierarchical memory with immediate recall (current session), working memory (last N turns), and long-term memory (distilled insights). Automatically archive and summarize old turns.

### Mid-task redirection without aborting
Allow users to interrupt a running agent with new instructions. Agent incorporates feedback, adjusts its current plan, and continues execution instead of starting over. Requires UI support for inline interrupts and agent state introspection.

---

## Integration & Provider Support

### Enhanced MCP (Model Context Protocol) support
Deeper MCP integration with UI-based MCP server discovery and one-click installation. Support for MCP server versioning, dependency resolution, and capability advertisement. MCP tools displayed with usage examples and documentation.

### Better VS Code extension integration
APIs for third-party extensions to hook into SideCar workflows. Expose commands, context injection points, and agent event hooks. Enable extensions to add custom tools, message processors, and agent modes without forking SideCar.

### Improved support for different LLM providers
Expanded multi-provider support with provider-specific optimizations: prompt prefixes for code-focused models, parameter tuning per provider, cost visibility for each provider, and automatic fallback chains (e.g., OpenAI → Anthropic → Ollama).

---

## Performance Optimizations

### Caching mechanisms for tool results
Cache results from expensive tools (grep on large repos, external API calls) with configurable TTL. Agents can reference cached results without re-execution. Reduces redundant work in iterated agent runs.

### More efficient context management
Implement sliding window context with importance sampling instead of pure recency. High-signal tool results preserved across pruning cycles. Early tool results that influenced agent decisions stay in context even if not recent.

### Parallel execution of independent tool calls
When agent generates multiple independent tool calls in sequence, execute them concurrently instead of serially. Reduce agent latency by 50%+ for multi-file operations, dependency analysis, and complex test runs.

---

## User Experience Improvements

### Enhanced visualization of agent reasoning
Detailed visual breakdown of agent thinking: goal decomposition, tool selection rationale, result interpretation, and error recovery strategy. Timeline view with collapsible reasoning blocks matching o1/o3 style thinking transparency.

### Better error handling and recovery mechanisms
Intelligent error parsing that categorizes failures (timeout, permission denied, not found, invalid syntax) and suggests targeted recovery actions. Agents automatically retry with backoff instead of failing hard. Human-readable error explanations with links to docs.

### Improved configuration management
Config hierarchy with workspace/folder/global scopes. Configuration inheritance and merging rules. Visual config inspector showing which setting came from where. Import/export config presets for different project types.

---

## Integration Improvements

### CI/CD pipeline integrations
Native integration with GitHub Actions, GitLab CI, Jenkins, CircleCI, and other CI/CD platforms. Agents can trigger builds, inspect test results, review deployment logs, and propose fixes for failing pipelines. Enables autonomous debugging of CI failures and proactive issue detection.

### Project management tool integrations
Connect to Jira, Linear, GitHub Issues, and other issue trackers. Agents can link code changes to tickets, auto-update issue status on completion, extract requirements from tickets into context, and generate PRs tied to specific tasks.

### Enhanced debugging capabilities
Integrated debugger support: breakpoint management, variable inspection, call stack navigation. Agents can set breakpoints, step through code, and analyze runtime state to diagnose failures. Supports Node.js, Python, and Go debuggers.

### Improved collaboration features
Multi-user awareness: see which team members are editing which files in real-time. Conflict detection when agents and humans edit the same file. Merge conflict resolution assistance. Shared session history and notes within a workspace.

---

## Enterprise & Team

### Team configuration sharing
Share SIDECAR.md, custom modes, MCP server configs, and tool permissions across a team via a shared config directory or settings sync. Teams define conventions once and every member gets the same agent behavior.

### Telemetry-free guarantee
Explicit privacy mode with zero telemetry, zero usage data collection, and no network calls except to the configured LLM endpoint. Verifiable via source code (already open-source). Key selling point for enterprise and compliance-sensitive environments.

---

## Completed (v0.11.0–v0.28.1)

- [x] Agent loop cycle detection: halt on repeated identical tool calls
- [x] Task-specific temperature: `sidecar.agentTemperature` (default 0.2) for tool-calling requests
- [x] Tool support auto-detection: track runtime failures, disable tools after 3 misses
- [x] Optimized system prompts: numbered rules, positive instructions, multi-step guidance
- [x] Context injection reordering: relevant files before workspace tree
- [x] `.sidecar/` project directory: foundation for cache, logs, sessions, plans, memory
- [x] Shared backend utilities: `parseThinkTags()`, `toFunctionTools()` deduplicated across backends
- [x] Config validation: `clampMin()` for all numeric settings
- [x] Error classification expansion: ENOTFOUND, EADDRNOTAVAIL, EHOSTUNREACH, ECONNRESET
- [x] FileSystemWatcher disposal on deactivate
- [x] Agent abort on extension deactivate
- [x] Pending confirmations cleared on abort
- [x] Shell session SIGTERM → SIGKILL timeout on dispose
- [x] Standardized error messages across all three backends
- [x] Typing indicator fix: remove duplicates, `setLoading: false` in finally block
- [x] Scroll handler debounce via requestAnimationFrame with cached element ref
- [x] O(1) message delete via `data-msg-index` attribute
- [x] `parseFileContent` language branching: test only relevant patterns per language
- [x] Partial sort in `getRelevantContext`: filter relevant files, sort only those
- [x] Pre-built pinned file Set for O(1) lookups
- [x] `pruneHistory` incremental char tracking: flatten once at end instead of O(m²)
- [x] Multi-language AST extraction: Python, Rust, Go, Java/Kotlin with full body capture
- [x] Smart context `enhanceContextWithSmartElements` wired into fallback path
- [x] Workspace index excludes: `coverage/`, `build/`, `.turbo`, `.cache`
- [x] 27 new tests: streamUtils, config validation, agent loop timeout, pruneHistory regression, backend stream errors
- [x] GitHub Actions: bot-powered releases, issue auto-labeling, PR test result comments
- [x] Per-request timeout for LLM calls with `sidecar.requestTimeout` setting
- [x] Local model context cap to prevent oversized prompts
- [x] Workspace context budget enforcement
- [x] Fix: user message dropped by pruneHistory array reference aliasing
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
- [x] `<think>` tag parsing for Ollama reasoning models (qwen3, deepseek-r1)
- [x] Verbose mode with `/verbose` and `/prompt` slash commands
- [x] Expand thinking setting (`sidecar.expandThinking`)
- [x] System prompt constraint ordering (constraints before tool list)
- [x] Race condition guard and message merge for concurrent agent runs
- [x] Token budget now includes tool call/result sizes
- [x] System prompt bounds checking (50% of model context cap)
- [x] Agent loop break on empty stripped content (prevents infinite loop)
- [x] Block-level markdown rendering: headings, bullet/numbered lists, blockquotes, horizontal rules
- [x] Smart context selection (initial): AST-based JS/TS element extraction with query relevance scoring
- [x] Autonomous mode auto-resolves pending confirmation prompts on switch
- [x] Await agentMode config update before confirming change
- [x] Duplicate file parsing removed from workspace index
- [x] Clarified `expandThinking` setting description
- [x] Fix block markdown infinite loop on `\r\n` line endings
- [x] LimitedCache with TTL and size eviction for workspace and AST caches
- [x] Persistent shell session: env vars, cwd, and state persist between commands
- [x] Streaming tool output: real-time shell output piped to the UI
- [x] Between-turn context pruning: tiered compression of old tool results and thinking blocks
- [x] Clean tool display: icons, display names, spinners, and result badges (matches Claude Code/Copilot polish)
- [x] Streaming markdown renderer: boundary-aware incremental rendering with debounce
- [x] Compact system prompt for local models (~60% shorter)
- [x] Background command support: start long-running processes and check on them later
- [x] Security fix: grep command injection via execFile with args array
- [x] Robustness: Promise.allSettled for parallel tool execution, null safety, retry backoff cap, debounced file watcher
- [x] Model pre-warm: load configured Ollama model into memory on extension activation
- [x] Typing status line with wall-clock timer and phase descriptions
- [x] Version, GitHub URL, and docs URL in system prompt for self-identification
- [x] Docs site redesign: custom CSS matching logo gradient, animated hero, feature cards
- [x] OpenAI-compatible API backend: LM Studio, vLLM, llama.cpp, OpenRouter, etc.
- [x] `sidecar.provider` setting with auto-detection (Ollama, Anthropic, OpenAI)
- [x] Context pinning: `@pin:path` syntax and `sidecar.pinnedContext` setting
- [x] Auto-fix on failure: diagnostics check after writes with configurable retry
- [x] Web page context: auto-fetch URLs in chat messages
- [x] Onboarding walkthrough: first-run Getting Started card
- [x] Reconnect button with auto-retry and exponential backoff
- [x] Scroll fix: `min-height: 0` for flexbox scroll truncation
- [x] Markdown post-processing pass for un-rendered bold/code
- [x] `display_diagram` tool: extract and display diagrams from markdown files
- [x] Adaptive context pruning: progressive compression of latest turn when over budget
- [x] `sidecar.contextLimit` setting for user-configurable context token limit
- [x] Ollama `num_ctx` runtime detection (prefer actual over advertised context length)
- [x] File path validation: reject hallucinated paths in write_file, edit_file, display_diagram
- [x] SVG sanitization for mermaid diagram output
- [x] SideCarAI-Bot co-author attribution on commits
- [x] Verbose log blocks collapsed by default
