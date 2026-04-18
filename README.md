<p align="center">
  <img src="media/SideCar.png" alt="SideCar Logo" width="200">
</p>

# SideCar — AI Coding Assistant for VS Code

[![VS Code Marketplace](https://badgen.net/vs-marketplace/v/nedonatelli.sidecar-ai)](https://marketplace.visualstudio.com/items?itemName=nedonatelli.sidecar-ai)

**SideCar** is a free, self-hosted VS Code extension that serves as a drop-in replacement for GitHub Copilot and Claude Code. Use local [Ollama](https://ollama.com) models, the [Anthropic API](https://api.anthropic.com), Kickstand *(coming soon)*, or any [OpenAI-compatible server](https://nedonatelli.github.io/sidecar/getting-started#using-openai-compatible-servers) (LM Studio, vLLM, llama.cpp, OpenRouter) for AI-powered coding — with full agentic capabilities, inline completions, and tool use.

> A free, open-source, local-first **autonomous AI agent for coding**. Full agent loop, not just chat. No subscriptions, no data leaving your machine.

SideCar will always be free, tips not required but appreciated.

<a href="https://www.buymeacoffee.com/nedonatelli" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-red.png" alt="Buy Me A Coffee" style="height: 20px !important;" ></a>

## Why SideCar?

Most local AI extensions for VS Code are **chat wrappers or autocomplete plugins**. SideCar is a **full agentic coding assistant** — closer to Claude Code or Cursor than to a chatbot, but free, open-source, and model-agnostic.

### vs. Local Extensions

| Capability | SideCar | Continue | Llama Coder | Twinny |
|---|---|---|---|---|
| Autonomous agent loop | **Yes** | Yes | No | No |
| File read/write/edit tools | **Yes** | Yes | No | No |
| Run commands & tests | **Yes** (persistent shell) | Yes | No | No |
| Web search | **Yes** (built-in) | No | No | No |
| Security & secrets scanning | **Yes** (Problems panel) | No | No | No |
| MCP server support | **Yes** | Yes | No | No |
| Git integration (commit, PR, releases) | **Yes** | Partial | No | No |
| Diff preview & undo/rollback | **Yes** | Partial | No | No |
| Plan mode | **Yes** | No | No | No |
| Review mode (accept/discard per file) | **Yes** | No | No | No |
| Pending-change file decorations | **Yes** | No | No | No |
| Activity-bar review badge | **Yes** | No | No | No |
| Native lightbulb code actions | **Yes** | Partial | No | No |
| Built-in skills (8) | **Yes** | Yes | No | No |
| Tree-sitter AST parsing | **Yes** | Yes | No | No |
| Codebase indexing | **Yes** | Yes | No | No |
| Spending budgets | **Yes** | No | No | No |
| Session spend tracker (status bar) | **Yes** | No | No | No |
| Hybrid cost-aware delegation | **Partial** | No | No | No |
| Getting-started walkthrough | **Yes** | No | No | No |
| Conversation steering (type while processing) | **Yes** | No | No | No |
| Free & open-source | Yes | Yes | Yes | Yes |

### vs. Pro Tools

| Capability | SideCar | Copilot | Cursor | Claude Code |
|---|---|---|---|---|
| Autonomous agent loop | Yes | Yes | Yes | Yes |
| Model agnostic (any provider) | **Yes** | Partial | Partial | No |
| Fully offline / self-hosted | **Yes** | No | No | No |
| HuggingFace model install | **Yes** | No | No | No |
| Custom skills system | **Yes** | Yes | Yes (.cursorrules) | Yes |
| Context compaction (manual + auto) | **Yes** | Yes | Yes | Yes |
| Spending budgets & cost tracking | **Yes** | No | Yes | No |
| Hybrid local-worker delegation | **Partial** | No | No | No |
| Prompt pruner & pre-request caching | **Yes** | No | No | Partial |
| Plan-then-execute mode | **Yes** | No | Yes | Yes |
| Review mode (batch diff review) | **Yes** | No | Partial | No |
| Native Problems panel integration | **Yes** | No | No | No |
| Status bar health indicator | **Yes** | Partial | No | No |
| Getting-started walkthrough | **Yes** | Yes | No | No |
| Native modal approval for destructive tools | **Yes** | No | No | Partial |
| Conversation steering (type while processing) | **Yes** | No | Yes | Yes |
| Works in your existing VS Code | **Yes** | Yes | No (fork) | Yes (extension + CLI) |
| Monthly subscription | **Free** | $10-19/mo | $20/mo | Usage-based |

### What sets SideCar apart

- **True agentic autonomy** — SideCar reads your code, edits files, runs tests, reads the errors, and iterates until the task is done. Switch between cautious, autonomous, manual, plan, review, or custom user-defined modes.
- **No vendor lock-in** — Use Ollama for fully offline operation, Anthropic for Claude, OpenAI-compatible servers (LM Studio, vLLM, OpenRouter), Kickstand *(coming soon)*, or install GGUF models directly from HuggingFace. Same interface, your choice.
- **Feels like a first-party VS Code extension** — status bar health indicator (red/yellow/green on backend state), native error toasts with one-click recovery actions, lightbulb code actions on diagnostics (Fix / Explain / Refactor), Problems panel integration for agent-detected secrets and stubs, file decorations on pending changes, activity-bar badge for pending-review count, a five-step Welcome-page walkthrough, and a command palette surface with a consistent `SideCar:` category. No shadow UIs — every action lives where VS Code users already look for it.
- **Hybrid cost-aware architecture** — when using paid backends, SideCar combines Anthropic prompt caching, a lossy-but-bounded prompt pruner (whitespace / tool-result head-tail truncation / duplicate dedup — 90% reduction on realistic agent loops), and a `delegate_task` tool that offloads read-only research to a local Ollama worker so the frontier model only pays for reasoning and synthesis. A session spend tracker in the status bar shows live `$` accumulated per model so you always know what the current run is costing.
- **Security from the ground up** — API keys stored in VS Code SecretStorage (OS keychain), secrets detection, vulnerability scanning, path traversal protection, sensitive file blocking, workspace hook warnings, and prompt injection sandboxing. Secret findings and stub code are published to the native Problems panel via `sidecar-secrets` / `sidecar-stubs` sources, just like tsc and eslint findings.
- **Extensible with MCP & Skills** — Connect external tools via MCP, create custom skills with markdown files, or use the 8 built-in skills (review, debug, refactor, explain, write-tests, break-this, create-skill, mcp-builder).
- **Production-grade safety** — Agent mode controls (including **review mode** for batch diff review), iteration limits, token budgets, daily/weekly spending caps, cycle detection, streaming diff preview, plan mode, **completion gate** (refuses to let the agent finish without running lint and tests for edited files), native blocking modal approval for destructive tools (`run_command`, `run_tests`, git mutations), and one-click rollback.
- **Persistent codebase indexing** — File index and symbol graph persist across restarts via `.sidecar/cache/`. Tree-sitter AST parsing for 6 languages. Near-instant startup on subsequent activations.
- **Smart context** — Tree-sitter AST extraction for TypeScript, JavaScript, Python, Rust, Go, and Java/Kotlin. SideCar sends relevant functions and classes to the model, not entire files.

## Features

### Agentic Coding Assistant
- **Tool use** — the model can read, write, edit, and search files, run commands, check diagnostics, and run tests autonomously
- **Agent loop** — multi-step execution (read code, edit, run tests, fix errors) without manual intervention at each step
- **Agent progress** — live step count, elapsed time, and token usage during agent runs
- **Activity indicators** — animated progress bar and tool execution pulses so you always know SideCar is working
- **Conversation steering** — chat input stays enabled during processing; send a new message to redirect the agent mid-run, or press Escape to abort. The Send button dynamically switches to Stop when the input is empty
- **Diagnostics integration** — reads compiler errors and warnings from VS Code's language services
- **Test-driven loop** — runs tests, feeds failures back to the model, iterates until passing
- **Undo/rollback** — revert all AI-made file changes with one click
- **Streaming diff preview** — in cautious mode, file writes open VS Code's diff editor with dual accept/reject UI (editor notification + chat card — first click wins)
- **Review mode** — approval mode that buffers every `write_file` / `edit_file` into an in-memory shadow store instead of touching disk, then surfaces pending changes in a dedicated **Pending Agent Changes** TreeView. Click any file to open VS Code's native diff editor; accept or discard per-file or all-at-once before anything is persisted. Read-through is transparent — when the agent reads a file it's edited this session, it sees its own pending content
- **Audit mode** *(new in v0.60, hardened in v0.61)* — stricter approval tier that buffers every `write_file` / `edit_file` / `delete_file` into an in-memory `AuditBuffer` with *atomic flush*: accept applies every staged change in one pass via `workspace.fs` or rolls back on any per-write failure, so the disk never sits in a partially-applied state. Command palette ships `SideCar: Audit: Review Buffered Changes` (QuickPick list of pending files with per-file diff), `Accept All`, and `Reject All`. v0.61 adds per-file accept/reject via the review loop, conflict detection against mid-review disk edits, buffer persistence across extension reloads (with `Review` / `Discard` recovery prompt on startup), and `git_commit` buffering (commits queue alongside file writes when `sidecar.audit.bufferGitCommits: true`, execute as the last step of a full accept). Complements Review mode (which scopes to only `write_file` / `edit_file` and uses a TreeView) — pick Audit when you need all-or-nothing semantics, deletion coverage, or reload-safety
- **Shadow Workspaces** *(new in v0.59)* — opt-in feature that runs agent tasks in an ephemeral git worktree at `.sidecar/shadows/<task-id>/` off the current `HEAD` so writes never touch your main tree until an explicit accept. Toggle via `sidecar.shadowWorkspace.mode` (`off` / `opt-in` / `always`)
- **Regression Guards** *(new in v0.60)* — declarative shell-command guards in `sidecar.regressionGuards` that fire on post-write / post-turn / pre-completion triggers as hard gates the agent must pass. Blocking guards inject their stdout back as a synthetic user message so the agent can revise; non-blocking guards surface as warnings. Use cases the built-in lint/test gate can't express: physics invariants, proof re-checks, API contract diffs, bundle-size budgets
- **Project Knowledge Index** *(new in v0.61, expanded in v0.62, opt-in preview)* — semantic search over every function / class / method / interface in your workspace. Ask "where is auth handled?" and get back the specific `requireAuth` function plus every route that wraps it (reached via graph walk through the symbol call graph). New `project_knowledge_search` agent tool with optional `kindFilter` and `pathPrefix`, `graphWalkDepth` (default 1) to include structurally-related symbols whose body text didn't itself score. `SemanticRetriever` prefers symbol-level hits when PKI is on so the main chat context is symbol-scoped instead of file-scoped — tighter evidence units for RAG. Enable via `sidecar.projectKnowledge.enabled: true` — flips to default-on in v0.63 after another preview cycle
- **Merkle-addressed fingerprint** *(new in v0.62, enabled by default when PKI is on)* — content-addressed hash tree over the symbol index: every symbol is a leaf with a SHA-256 hash, every file is an interior node aggregating its symbols' hashes + mean-pooled embeddings, and the root is a single workspace fingerprint. Enables *query-time descent* — on a search, the retriever walks aggregated embeddings to pick candidate files *before* scoring individual leaves, turning an O(total symbols) cosine scan into O(picked files × symbols per file). `getMerkleRoot()` on the index surfaces a 64-char hex fingerprint for cache validity + cross-machine sync. Toggle via `sidecar.merkleIndex.enabled` (default `true` when PKI is on)
- **Retrieval CI ratchet** *(new in v0.62)* — retrieval quality is gated in CI against pinned aggregate thresholds (precision@K ≥ 0.45, recall@K ≥ 0.95, F1@K ≥ 0.55, MRR ≥ 0.90 on the golden dataset). Regressions in SemanticRetriever, Merkle descent, or embedding-model changes surface as a failing test instead of silently degrading retrieval. Opt-in LLM-as-judge layer (`npm run eval:llm`) rates `Faithfulness` (per-hit) and `Answer Relevancy` (per-query) with a real frontier model
- **Completion gate** — deterministic barrier that refuses to let the agent declare a turn done until lint and the colocated tests for edited files have actually run. Catches the "ready for use" fabrication failure mode by tracking every `write_file` / `edit_file` against every `eslint` / `tsc` / `vitest` / `jest` / `pytest` / `run_tests` invocation during the turn. Toggle via `sidecar.completionGate.enabled`
- **Stub validator** — auto-detects placeholder code (TODO, "real implementation", stub functions) in agent output and reprompts the model to finish
- **Smart "continue" recognition** — terse replies like `continue`, `go on`, `keep going`, `proceed`, `next` are rewritten into a directive that tells the model to pick up from its most recent response, skipping completed steps
- **Custom modes** — define your own agent modes (Architect, Debugger, Coder) with dedicated system prompts, approval behavior, and per-tool permissions via `sidecar.customModes`
- **Background agents** — `/bg <task>` spawns autonomous agents that work in parallel without blocking the main conversation. Dashboard panel shows status, output, and stop controls. Up to 3 concurrent (configurable via `sidecar.bgMaxConcurrent`)
- **Typed Sub-Agent Facets** *(new in v0.66)* — dispatch one or more named specialists (`general-coder`, `test-author`, `security-reviewer`, `latex-writer`, `signal-processing`, `frontend`, `technical-writer`, `data-engineer`) against a shared task. Each facet runs in its own isolated Shadow Workspace with its own tool allowlist, preferred model, and a composed system prompt layered over the orchestrator's rules. `SideCar: Facets: Dispatch Specialists` in the Command Palette opens a multi-select QuickPick and an input prompt. Batches coalesce into a single aggregated review flow at the end instead of stacking N accept/reject prompts mid-run — the review UI detects cross-facet file overlaps, opens `vscode.diff` per facet, and applies accepted diffs via `git apply`. Facets can talk to each other through a typed RPC bus (`rpc.<peerId>.<method>` tools) that never rejects — calls resolve to `{ ok, value }` or `{ ok: false, errorKind }`. Add project-local facets in `<workspace>/.sidecar/facets/*.md` or user-level facets via `sidecar.facets.registry` paths. Toggle via `sidecar.facets.enabled` (default `true`); cap concurrency via `sidecar.facets.maxConcurrent` (default `3`)
- **Safety guardrails** — agent mode dropdown (cautious/autonomous/manual/plan/review/custom) in the header, iteration limits, token budget, daily/weekly spending caps
- **Thinking/reasoning** — collapsible reasoning blocks from models that support extended thinking (Anthropic) or `<think>` tags (qwen3, deepseek-r1)
- **Verbose mode** — `/verbose` to show system prompt, per-iteration summaries, and tool selection context during agent runs
- **Observability** — `/audit` to browse structured tool execution logs, "Why?" button on tool cards for on-demand decision explanations, `/insights` for conversation pattern analysis with usage trends and suggestions
- **Smart context selection** — AST-based parsing extracts relevant functions, classes, and imports from JS/TS files instead of including whole files in context
- **Bounded caches** — workspace file content and AST caches use TTL-based eviction to prevent unbounded memory growth during long sessions
- **Persistent shell** — `run_command` uses a long-lived shell process; env vars, cwd, and aliases persist between calls. Supports configurable timeouts, background commands, and streaming output
- **Context pruning** — conversation history is automatically compressed between turns so local models don't choke on accumulated context from prior tool calls
- **Clean tool display** — tool calls show as `Read src/foo.ts` with icons and spinners, matching the polish of Claude Code and Copilot

### Inline Chat (Cmd+I)
- Edit code in place within the editor
- Select code and describe changes, or insert at cursor
- Uses surrounding code context for better edits

### Inline Completions
- Copilot-like autocomplete as you type (opt-in via settings)
- Uses Ollama's FIM endpoint for local models
- Falls back to Messages API for Anthropic
- Debounced with in-flight cancellation

### Code Actions & Lightbulb
- **Editor context menu** — right-click a selection: **Explain**, **Fix**, **Refactor** with SideCar
- **Native lightbulb on diagnostics** — when VS Code shows a red or yellow squiggle, press `⌘.` / `Ctrl+.` (or click the 💡) and you'll see **Fix with SideCar** / **Explain this error with SideCar** alongside the built-in Quick Fix suggestions. **Refactor with SideCar** appears in the Refactor submenu on any selection. Code actions are wired through a `CodeActionProvider` registered for all `file` scheme documents, so they surface natively rather than only in a custom menu. Each action forwards the line content + the formatted diagnostic (`[typescript] TS2339 error: Property 'foo' does not exist`) to chat.
- **Terminal error interception** — failed commands in the integrated terminal trigger a **Diagnose in chat** notification. Accepting injects a synthesized prompt with the command, exit code, cwd, and ANSI-stripped output tail, then runs the agent against it. Dedupes within a 30s cooldown, skips SideCar's own terminal, and requires VS Code shell integration. Toggle via `sidecar.terminalErrorInterception`

### Native VS Code Integration (v0.47.0)

SideCar is built to feel like a first-party VS Code extension. Every high-traffic touchpoint uses the same patterns the built-in tools (git, Problems, Source Control) use:

- **Status bar health indicator** — the `$(hubot) <model>` item in the bottom-right reflects live backend state. Green on ok, yellow on rate-limited, red on auth / connection error with `statusBarItem.errorBackground`. Hover tooltip is a `MarkdownString` with the last error body and clickable `command:` links for one-click recovery (`Toggle chat`, `Switch backend`, `Set API key`).
- **Session spend status bar** — a `$(credit-card) $0.1234` item appears the moment a paid backend incurs cost, clickable to open a QuickPick breakdown with per-model totals, request counts, input/output/cache-read/cache-write token counts, and a reset action. Hidden on local-only setups.
- **Native error toasts with recovery actions** — auth / connection / model errors promote from inline chat messages into `window.showErrorMessage` toasts with action buttons that execute real VS Code commands. Rate-limit and validation errors stay in-chat so you aren't buried under toast spam.
- **Problems panel integration** — leaked API keys, SQL concat queries, eval calls, and `// TODO: implement` stubs detected in agent-written code are published to VS Code's native Problems panel with source tags `sidecar-secrets`, `sidecar-vulns`, or `sidecar-stubs`. Filter the Problems panel with `source:sidecar-*` to scope to SideCar-only findings. Click any entry to jump to the offending line. New command: `SideCar: Clear Diagnostics`.
- **File decorations for pending edits** — in review mode, every file the agent has queued for review gets a `P` badge in the Explorer and editor tabs with the `gitDecoration.modifiedResourceForeground` color. Parent folders show the rollup indicator (matching git's M/A/D convention). Accept or discard the edit and the badge disappears instantly.
- **Activity-bar badge for pending-review count** — the SideCar icon in the Activity Bar shows a numeric badge when there are pending review-mode edits, aggregated automatically from the TreeView via `TreeView.badge`. Same mechanism Source Control uses for the changed-file count.
- **Getting-started walkthrough** — `contributes.walkthroughs` registers a five-step Welcome editor page (Welcome → Pick a backend → Open the chat → Inline editing and the lightbulb → Discover every action) that auto-opens on first install and can be reopened any time via `SideCar: Open Walkthrough`.
- **Empty-state welcome card** — when the chat view is empty (first launch, after Clear Chat, fresh session), SideCar renders a compact welcome card showing the active model + backend with a health indicator, three quick-action buttons (`Set / Refresh API Key`, `Switch Backend`, `Browse Commands`), four clickable starter prompt chips, and platform-aware keyboard shortcut hints.
- **Quick Pick model switcher** — `SideCar: Select Model` opens a native QuickPick for keyboard-first model switching: installed models are listed first with a `$(check)` marker on the active one, then library models with `$(cloud-download)` for not-yet-pulled. Empty-state recovery via a warning with `Switch Backend` / `Set API Key` actions.
- **Native modal approval for destructive tools** — `run_command`, `run_tests`, `git_stage`, `git_commit`, `git_push`, `git_pull`, `git_branch`, `git_stash` now show a blocking `showWarningMessage({modal: true})` instead of an inline chat card. You can't miss the prompt while scrolled away from chat, and approval can't auto-dismiss. Non-destructive tool approvals keep the existing inline card flow.
- **Progress notifications for long operations** — `sidecar.reviewChanges`, `sidecar.summarizePR`, `sidecar.generateCommitMessage`, `sidecar.scanStaged` wrap their async work in `window.withProgress({location: Notification})` so palette-triggered actions show a bottom-right spinner even when the chat view is hidden.
- **Command palette with consistent `SideCar:` category** — every user-facing action is in the palette with a `SideCar:` prefix, appropriate icon, and `when` clauses gating internal / context-sensitive commands (inline-edit commands gated on `sidecar.hasInlineEdit`, selection commands gated on `editorHasSelection`).
- **Right-click context menu on chat messages** — right-click any message for **Copy message** / **Delete message**. Right-click a code block for **Copy code** / **Save code as...**. Right-click a tool invocation for **Why? · *tool_name*** / **Copy output · *tool_name***. Menu items support optional muted `detail` suffixes so multiple "Why?" entries stay unambiguous.
- **Custom 150ms tooltips** — replaced the browser's 500-1000ms HTML `title` delay with themed CSS tooltips styled via `--vscode-editorHoverWidget-*` tokens. Hover any header button and you get near-instant feedback.

### Background Doc Sync
On every save, SideCar keeps your documentation in sync with your code — no AI round-trips, no external indexer, just local string analysis over the file you're editing:

- **JSDoc staleness diagnostics** — scans TypeScript / JavaScript files for `@param` tags that no longer match the function signature. Orphan tags (the JSDoc describes a parameter that no longer exists) and missing tags (a parameter with no matching `@param` entry) surface as warning diagnostics with one-click quick fixes to remove or add the tag, preserving JSDoc indentation and the `*` prefix. Toggle via `sidecar.jsDocSync.enabled`
- **README sync** — on save of `README.md` (and on save of any `src/` source file, so drift surfaces immediately when you rename an API), scans fenced ts/tsx/js/jsx code blocks for calls to workspace-exported functions whose argument count no longer matches the current signature. Quick fix rewrites the call: drops trailing args when there are too many, appends missing parameter names as placeholders when there are too few. Toggle via `sidecar.readmeSync.enabled`

Both features skip class methods, destructured parameters, rest parameters, and multi-line calls — the analyzer is conservative by design to avoid false positives in user-facing docs. See [docs/background-doc-sync](https://nedonatelli.github.io/sidecar/background-doc-sync) for the full rule set.

### AI Chat
- Streaming responses in a dedicated sidebar panel
- **Semantic search** — ONNX embeddings (all-MiniLM-L6-v2) for meaning-based file relevance, blended with keyword scoring. "Authentication logic" finds `src/auth/jwt.ts` without keyword matches
- **Workspace indexing** — persistent file index with relevance scoring replaces per-message glob scan, updated incrementally via file watcher
- **Reasoning timeline** — agent thinking is split into numbered steps that close when a tool call starts. Each step shows a purple (reasoning) or blue (tool) pill and a per-step duration badge
- **Customizable UI themes** — `sidecar.chatDensity` (compact/normal/comfortable), `sidecar.chatFontSize`, and `sidecar.chatAccentColor` update live without reloading the webview
- **Message list virtualization** — offscreen text messages in long sessions are detached via `IntersectionObserver` and rehydrated on scroll-back, keeping 200+ message conversations responsive
- **Structured context rules** — `.sidecarrules` files with glob patterns to prefer, ban, or require files in context
- **Chat logging** — every conversation logged as JSONL to `$TMPDIR/sidecar-chatlogs/` for debugging and recovery
- **Rich markdown rendering** — headings, bullet/numbered lists, blockquotes, horizontal rules, bold, italic, code, and links all rendered in assistant messages
- **Streaming tool-call normalization** — qwen3-coder and Hermes-style `<function=...>` / `<tool_call>...` output is parsed at the backend boundary and emitted as structured tool calls instead of leaking raw XML into the chat
- **Active file context** — includes the currently open file and cursor position
- **@ references** — `@file:path`, `@folder:path`, `@symbol:name` for precise context inclusion
- **Image support** — paste screenshots or attach images for vision models
- **Slash commands** — `/model`, `/help`, `/batch`, `/doc`, `/spec`, `/insight`, `/save`, `/sessions`, `/scan`, `/usage`, `/context`, `/test`, `/lint`, `/deps`, `/scaffold`, `/commit`, `/verbose`, `/prompt`, `/audit`, `/insights`, `/mcp`, `/init`, `/move`, `/clone`, `/skills`, `/releases`, `/release`, `/bg` — with autocomplete dropdown as you type. Actions that duplicated header buttons or palette commands (`/reset`, `/export`, `/compact`, `/undo`) were removed in v0.47.0; use the buttons or `SideCar:` palette entries instead
- **Diagram generation** — models can generate Mermaid diagrams in code blocks; rendered natively in chat with syntax highlighting and copy-to-SVG support
- **Actionable errors** — classified error cards with retry, start Ollama, and settings buttons
- **Sticky scroll** — auto-scroll pauses when you scroll up, floating button to jump back down
- **Chat history persistence** — conversations survive VS Code restarts (per-workspace)
- **Streaming indicator** — shows token count and generation speed
- **Model management** — switch models, install new ones from Ollama, search/filter in the model picker

### Multi-Backend Support
- **Ollama** (default) — runs locally, free, no API key needed
- **Anthropic API** — use Claude models with your API key, with prompt caching for ~90% input token cost reduction
- **Kickstand** *(coming soon)* — self-hosted LLM client backend with managed GPU memory. The backend adapter ships today for anyone running a local dev build; the first-party Kickstand release is still in progress.
- **OpenAI-compatible** — works with LM Studio, vLLM, llama.cpp, text-generation-webui, OpenRouter, and any server with a `/v1/chat/completions` endpoint
- **One-click profile switcher** — click the ⚙ gear in the chat header to flip between Local Ollama / Anthropic Claude / OpenAI / Kickstand *(coming soon)* in a single click. Each profile stores its own API key in VS Code's SecretStorage, so switching backends doesn't clobber a key you've already set. Also available as `SideCar: Switch Backend` from the Command Palette.

### Cost Controls (Paid Backends)

When you're paying per token, SideCar stacks four cost-cutting layers so the frontier model only pays for reasoning and synthesis:

- **Session spend tracker** — every Anthropic streaming response reports its `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`. SideCar multiplies them against a built-in Claude price table (Opus 4.6/4.5, Sonnet 4.6/4.5, Haiku 4.5 + 3.x fallbacks) and displays the running session total as a `$(credit-card) $0.1234` status bar item. Click it for a per-model QuickPick breakdown with request counts, token totals, and session minutes. `SideCar: Reset Session Spend` clears the tally; `SideCar: Show Session Spend` opens the breakdown manually. Uses list prices — consult the Anthropic Console for authoritative billing.
- **Anthropic prompt caching** — tool definitions and conversation history carry `cache_control: { type: 'ephemeral' }` breakpoints so agent loops cache-read the stable prefix instead of re-sending it every turn. 90% cache-read discount on the cached bytes, 25% cache-write premium on the delta. Pairs with the system-prompt cache split to keep the effective cost of long agent runs low.
- **Prompt pruner** — lossy-but-bounded pipeline that runs before serialization for Anthropic and OpenAI requests. Three transforms: collapse runs of 3+ blank lines, head+tail truncate oversize `tool_result` blocks with an explicit `[...N bytes elided...]` marker, and replace duplicate tool_result bodies with a back-reference. Measured **90.2% reduction** on a realistic fixture (30,676 → 3,008 bytes). Safe for agent loops — only lossy on tool output, never on user or assistant messages. Toggle via `sidecar.promptPruning.enabled` (default on); tune the per-tool-result ceiling via `sidecar.promptPruning.maxToolResultTokens` (default 2000).
- **`delegate_task` tool (hybrid architecture)** — exposed only to paid backends. Lets the frontier orchestrator offload read-only research (file reads, greps, searches, symbol lookups, git queries) to a local Ollama worker running on its own `SideCarClient`. The worker executes its own mini agent loop with a read-only tool subset and returns a compact structured summary. Token consumption never touches the orchestrator's paid-budget accounting. Settings: `sidecar.delegateTask.enabled` (default on), `sidecar.delegateTask.workerModel` (defaults to chat model), `sidecar.delegateTask.workerBaseUrl` (default `http://localhost:11434`). No-op on local-only setups.
- **Budgets** — `sidecar.dailyBudget` and `sidecar.weeklyBudget` cap total spend in USD; agent runs are blocked when the limit is reached.

### MCP (Model Context Protocol)
- Connect to any MCP server via **stdio**, **HTTP**, or **SSE** transport
- MCP tools appear transparently alongside built-in tools
- **`.mcp.json` project config** — team-shared server definitions (Claude Code compatible)
- **Per-tool enable/disable** — filter out dangerous tools per server
- **Output size limits** — prevent context bloat from large MCP results
- **Health monitoring** — automatic reconnection with exponential backoff
- **`/mcp` status command** — check server status, transport, and tool counts
- **`/mcp-builder` skill** — built-in guide for creating high-quality MCP servers
- Configure via `sidecar.mcpServers` or `.mcp.json`:
  ```json
  "sidecar.mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"]
    },
    "remote-api": {
      "type": "http",
      "url": "https://mcp.example.com/api",
      "headers": { "Authorization": "Bearer ${TOKEN}" }
    }
  }
  ```

### Security Scanning
- **Automatic secrets detection** — scans files after agent writes for AWS keys, GitHub tokens, API keys, private keys, JWTs, connection strings, and more
- **Vulnerability scanning** — flags SQL injection, command injection, XSS (innerHTML), eval usage, and insecure HTTP URLs
- **Integrated into diagnostics** — `get_diagnostics` includes security findings alongside compiler errors
- **Pre-commit scan** — `/scan` command or `SideCar: Scan Staged Files for Secrets` in the command palette scans staged git files before committing
- Skips comments, node_modules, lock files, and minified code

### Adversarial Critic
A second LLM call whose only job is to find reasons the main agent's change is wrong — logic bugs, security issues, regressions, off-by-one errors, concurrency bugs, exception-handling gaps. Purely adversarial: the critic system prompt forbids praise, suggestions, or style nits. If it can't find a real problem, it says "NO ISSUES" and stops.

**When it fires:** after every successful `write_file` / `edit_file`, and after every `run_tests` that errored (with the failing output plus recent edit diffs for correlation).

**How findings are surfaced:**
- **High severity** — injected as a synthetic user message that blocks the turn until the agent either fixes the underlying issue or explains why the reviewer is wrong. Capped at 2 injections per file per turn so the agent can't be trapped in an infinite critic loop.
- **Low severity** — rendered as a chat annotation with the `🔍 Critic review` header. Informational only, the agent never sees them.

**Enabling it:** set `sidecar.critic.enabled` to `true`. The critic uses your main model by default — on paid backends you'll want to set `sidecar.critic.model` to something cheaper (e.g. Haiku 4.5 to critique Sonnet's output). `sidecar.critic.blockOnHighSeverity` controls whether high-severity findings actually block the loop or just surface as annotations.

**Cost:** each critic call is a full round trip with a 1024-token budget. On Ollama it's free but adds a few seconds per edit; on paid backends it roughly doubles the per-iteration cost unless you use a cheaper critic model.

### Tool Registry (23+ built-in tools + MCP)
| Tool | Description |
|------|-------------|
| `read_file` | Read file contents |
| `write_file` | Create or overwrite files |
| `edit_file` | Search/replace edits in existing files |
| `search_files` | Glob pattern file search |
| `grep` | Content search with regex |
| `run_command` | Execute shell commands (persistent session, background support) |
| `list_directory` | List directory contents |
| `get_diagnostics` | Read compiler errors and warnings |
| `run_tests` | Run test suites with auto-detection |
| `git_diff/status/stage/commit/log/push/pull/branch/stash` | Full git workflow |
| `find_references` | Find symbol references across workspace |
| `web_search` | Search the web via DuckDuckGo |
| `display_diagram` | Extract and render diagrams from markdown files |
| `switch_backend` | Switch to a different backend profile (ollama / anthropic / openai / kickstand). Always requires user approval |
| `get_setting` | Read the current value of a `sidecar.*` setting. Secrets are blocked |
| `update_setting` | Update a `sidecar.*` setting at user scope. Security-sensitive keys are denied; every call requires an approval modal |
| `ask_user` | Ask the user a clarifying question with selectable options |
| `spawn_agent` | Spawn a sub-agent for parallel tasks (max depth: 3, 15 iterations each) |
| `delegate_task` *(paid backends only)* | Offload read-only research to a local Ollama worker. Orchestrator pays nothing for the worker's tokens |

### Project Instructions (SIDECAR.md)
Run `/init` in the chat to auto-generate a `.sidecar/SIDECAR.md` file from your codebase. SideCar scans config files, the file tree, and sample source files (prioritizing entry points) to produce a structured project overview. It also reads `CLAUDE.md` and `AGENTS.md` if they exist.

Or create one manually:

```markdown
# Project: My App

## Build
- Run `npm run build` to compile
- Run `npm test` to run tests

## Conventions
- Use TypeScript strict mode
- Prefer async/await over callbacks
- Components go in src/components/
```

SideCar reads this file on every message and includes it in the system prompt.

### Hooks
Run shell commands before/after any tool execution:
```json
"sidecar.hooks": {
  "write_file": { "post": "npm run lint --fix" },
  "*": { "pre": "echo \"Tool: $SIDECAR_TOOL\"" }
}
```
Environment variables: `SIDECAR_TOOL`, `SIDECAR_INPUT`, `SIDECAR_OUTPUT` (post only).

### Scheduled Tasks
Run recurring agent tasks on an interval:
```json
"sidecar.scheduledTasks": [
  { "name": "Lint check", "intervalMinutes": 30, "prompt": "Run the linter and fix any issues", "enabled": true }
]
```
Scheduled tasks run autonomously and log to the SideCar Agent output channel.

### GitHub Integration
- Clone repos, list/view/create PRs and issues
- View commit history, diffs, push/pull
- Browse repo files on GitHub

### Documentation Index

> **Note:** this is a keyword-tokenized paragraph index, **not** embedding-based RAG. For semantic similarity retrieval over code files, see the **Semantic Search** feature below which uses ONNX all-MiniLM-L6-v2 embeddings. The two work together: the doc index targets human-written prose (README sections, JSDoc paragraphs) where exact term matching wins, and semantic search targets code where embedding similarity matches "auth flow" to `jwt.ts` without a shared keyword.

- **Automatic documentation discovery** — crawls README, docs/, wiki/ folders for `.md` files at startup
- **Keyword-based search** — retrieves relevant documentation sections for every user message by tokenizing the query and scoring entries by term overlap
- **Context injection** — matched documentation is injected into the system prompt under a `## Project Documentation` section to improve accuracy and consistency
- **Smart ranking** — title keyword matches score 3x higher than body text; organized by type (heading vs. paragraph)
- **Configurable limits** — control max entries per query, auto-refresh interval, and enable/disable via settings
- Example: Ask "how does authentication work?" and the agent automatically includes `docs/AUTHENTICATION.md` in context

### Agent Memory (Persistent Learning)
- **Pattern tracking** — remembers successful tool uses, coding conventions, and architectural decisions across sessions
- **Full-text search** — every message queries learned patterns for relevant context
- **Use-count tracking** — frequently-referenced patterns are boosted in search results
- **Persistence** — memories stored in `.sidecar/memory/agent-memories.json` and auto-loaded on startup
- **Configurable limits** — control max entries (with LRU eviction), enable/disable via settings
- **Automatic recording** — successful tool executions are recorded as patterns without manual intervention
- Example: After successfully using `formatUserName()` for a task, it's remembered. When a similar task appears later, the function is suggested and injected

## Requirements

- **[Ollama](https://ollama.com)** installed and in your PATH (for local models)
- **Visual Studio Code** 1.88.0 or later

## Getting Started

1. Install [Ollama](https://ollama.com) if you haven't already
2. Install the SideCar extension
3. Click the SideCar icon in the activity bar
4. Start chatting — SideCar launches Ollama automatically

### Using with Anthropic API

Fastest path (recommended):

1. Click the ⚙ gear in the chat header → **Anthropic Claude** under Backend.
2. SideCar will prompt for your API key on first switch — paste it and you're done. `baseUrl`, `provider`, and a default Claude model are all set in one click.

Manual path (if you prefer editing settings):

1. Set `sidecar.baseUrl` to `https://api.anthropic.com`
2. Run `SideCar: Set / Refresh API Key` from the command palette and paste your Anthropic API key
3. Set `sidecar.model` to a Claude model (e.g. `claude-sonnet-4-6`)

API keys are stored encrypted in your OS keychain via VS Code's SecretStorage — never in plaintext settings. Each backend profile uses its own SecretStorage slot, so switching between Ollama ↔ Anthropic ↔ OpenAI ↔ Kickstand *(coming soon)* preserves the keys you've already entered.

### Using with OpenAI-compatible servers

Works with LM Studio, vLLM, llama.cpp, text-generation-webui, OpenRouter, and more:

1. Set `sidecar.baseUrl` to your server URL (e.g. `http://localhost:1234`)
2. Run `SideCar: Set / Refresh API Key` if your server requires authentication (optional for most local servers)
3. Set `sidecar.model` to the model name on your server

SideCar auto-detects the provider. To override, set `sidecar.provider` to `"openai"`.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+I` / `Ctrl+Shift+I` | Toggle SideCar chat panel |
| `Cmd+I` / `Ctrl+I` | Inline chat (edit code in place) |
| `Cmd+L` / `Ctrl+L` | Clear chat |
| `Cmd+Shift+U` / `Ctrl+Shift+U` | Undo all AI changes |
| `Cmd+Shift+E` / `Ctrl+Shift+E` | Export chat as Markdown |

## Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.baseUrl` | `http://localhost:11434` | API base URL |
| `sidecar.apiKey` | `ollama` | API key (ignored for Ollama). Stored in VS Code SecretStorage — set via `SideCar: Set API Key` command, plaintext values auto-migrate on activation |
| `sidecar.model` | `qwen3-coder:30b` | Model for chat |
| `sidecar.systemPrompt` | `""` | Custom system prompt |
| `sidecar.toolPermissions` | `{}` | Per-tool overrides: `{ "tool_name": "allow" \| "deny" \| "ask" }` |
| `sidecar.hooks` | `{}` | Pre/post execution hooks (see Hooks section above) |
| `sidecar.scheduledTasks` | `[]` | Recurring agent tasks (see Scheduled Tasks section above) |
| `sidecar.mcpServers` | `{}` | MCP servers to connect to (see MCP section above) |
| `sidecar.agentMode` | `cautious` | Agent mode: cautious, autonomous, manual, plan, review, audit, or a custom mode name |
| `sidecar.customModes` | `[]` | Custom agent modes with system prompts and approval behavior |
| `sidecar.bgMaxConcurrent` | `3` | Max background agents running simultaneously (1–10) |
| `sidecar.agentTemperature` | `0.2` | Temperature for agent tool-calling requests. Lower = more deterministic |
| `sidecar.agentMaxIterations` | `25` | Max agent loop iterations |
| `sidecar.agentMaxTokens` | `100000` | Max tokens per agent run |
| `sidecar.includeWorkspace` | `true` | Include workspace files in context |
| `sidecar.includeActiveFile` | `true` | Include active file in context |
| `sidecar.filePatterns` | `["**/*.ts", ...]` | File patterns for workspace context |
| `sidecar.maxFiles` | `10` | Max files in workspace context |
| `sidecar.contextLimit` | `0` | Override context token limit for local models (0 = auto-detect with 16K cap) |
| `sidecar.enableInlineCompletions` | `false` | Enable Copilot-like autocomplete |
| `sidecar.completionModel` | `""` | Model for completions (empty = use chat model) |
| `sidecar.completionMaxTokens` | `256` | Max tokens for completions |
| `sidecar.verboseMode` | `false` | Show detailed agent reasoning during runs |
| `sidecar.expandThinking` | `false` | Show reasoning blocks expanded instead of collapsed |
| `sidecar.chatDensity` | `normal` | Chat UI density: `compact`, `normal`, or `comfortable` (changes message padding and gaps) |
| `sidecar.chatFontSize` | `13` | Chat UI base font size in pixels (10–22) |
| `sidecar.chatAccentColor` | `""` | Override the chat accent color (hex, rgb/rgba, hsl/hsla, or named color). Empty = inherit from VS Code theme |
| `sidecar.terminalErrorInterception` | `true` | Detect non-zero exit codes in the integrated terminal and offer **Diagnose in chat**. Requires VS Code shell integration |
| `sidecar.jsDocSync.enabled` | `true` | Flag orphan and missing JSDoc `@param` tags on save of TS/JS files, with quick-fix actions |
| `sidecar.readmeSync.enabled` | `true` | Flag stale call arity in README.md fenced code blocks on save of README.md or any `src/` source file |
| `sidecar.completionGate.enabled` | `true` | Refuse to let the agent declare a turn done until lint and the colocated tests for edited files have actually run |
| `sidecar.requestTimeout` | `120` | Timeout in seconds for each LLM request. Aborts if no tokens arrive within this window. Set to 0 to disable |
| `sidecar.shellTimeout` | `120` | Default timeout for shell commands in seconds |
| `sidecar.shellMaxOutputMB` | `10` | Maximum shell output size in MB before truncation |

## Documentation

Full documentation is available at [nedonatelli.github.io/sidecar](https://nedonatelli.github.io/sidecar/).

Repo-local references for contributors and security-conscious users:

- **[SECURITY.md](SECURITY.md)** — threat model, vulnerability disclosure path, supported versions, and the full secret-pattern catalog with `SECRET_PATTERNS_VERSION` change history.
- **[docs/extending-sidecar.md](docs/extending-sidecar.md)** — the four extension surfaces (skills, custom tools, MCP servers, policy hooks) with authoring examples and trust-requirement comparison.
- **[docs/agent-loop-diagram.md](docs/agent-loop-diagram.md)** · **[docs/tool-system-diagram.md](docs/tool-system-diagram.md)** · **[docs/context-pipeline-diagram.md](docs/context-pipeline-diagram.md)** · **[docs/mcp-lifecycle-diagram.md](docs/mcp-lifecycle-diagram.md)** — Mermaid architecture diagrams for the agent loop, tool dispatch, retrieval pipeline, and MCP lifecycle.

## Support & Contact

- **Bug reports & feature requests**: [GitHub Issues](https://github.com/nedonatelli/sidecar/issues)
- **Security issues**: private disclosure via the process in [SECURITY.md](SECURITY.md) — please don't open public issues for vulnerabilities
- **Email**: [sidecarai.vscode@gmail.com](mailto:sidecarai.vscode@gmail.com)
- **Documentation**: [nedonatelli.github.io/sidecar](https://nedonatelli.github.io/sidecar/)

## Disclaimer

SideCar is an independent project by Nicholas Donatelli and is not affiliated with, endorsed by, or sponsored by Ollama, Anthropic, Meta, Mistral AI, Google, GitHub, or any other company. All product names are trademarks of their respective holders.

## License

[MIT](LICENSE)
