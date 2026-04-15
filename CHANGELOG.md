# Changelog

All notable changes to the SideCar extension will be documented in this file.

## [Unreleased]

## [0.52.0] - 2026-04-14

Reliability + retriever-fusion completion release. Two themes bundled: finishing the retriever-fusion story deferred from v0.51 by wrapping workspace semantic search as the third `Retriever`, and a reliability pass aimed at stream failures — the kind of mid-turn error that used to just lose the user's in-flight reasoning. Plus two pieces of passive infrastructure (circuit breaker, prompt cache byte-stability tests) that catch classes of failures before they reach users.

### Added

- **Semantic workspace search as a `Retriever`.** Finishes the retriever-fusion story from v0.51. `WorkspaceIndex.getRelevantContext()` was split into reusable phases: `rankFiles(query, activeFilePath)` runs the existing heuristic + semantic + context-rules pipeline and returns a sorted `RankedFile[]`, `loadFileContent(relativePath)` exposes the streaming + cache-aware file read, and three new render helpers (`getPinnedFilesSection`, `getFileDependenciesSection`, `getWorkspaceStructureSection`) handle the non-ranking pieces independently. Legacy `getRelevantContext()` stays for backward compat but is no longer called from `injectSystemContext`. New [`src/agent/retrieval/semanticRetriever.ts`](src/agent/retrieval/semanticRetriever.ts) wraps the index as a `Retriever`; each hit is a truncated file snippet (3000-char cap) so a single large file can't dominate fused output against memory/doc snippets. `injectSystemContext` now builds a three-retriever list (docs, memory, workspace) and runs them through `fuseRetrievers()` under a single shared budget — a strong workspace file can outrank a weak doc hit and vice versa.
- **Per-provider circuit breaker for LLM backends.** New [`src/ollama/circuitBreaker.ts`](src/ollama/circuitBreaker.ts): three-state machine (`closed` → `open` after 5 consecutive failures → `half-open` after 60s cooldown → `closed` on successful probe). Exactly one probe allowed in `half-open`; a failed probe reopens with a fresh cooldown so a flaky provider doesn't get to burn extra user requests. Per-provider isolation via `Map<ProviderType, BreakerEntry>`, matching the same pattern as the v0.48.0 rate-limit store split. Wired into `SideCarClient.streamChat` and `.complete`: `guard()` before dispatch throws `BackendCircuitOpenError` with the cooldown remainder when open, `recordSuccess` / `recordFailure` after the call close the loop. User aborts still short-circuit before `recordFailure` so a user Ctrl+C doesn't count toward opening. Complements the existing fallback-switching machinery — the fallback only triggers inside a request, while the breaker holds state across requests.
- **`/resume` partial-stream recovery.** When a backend stream dies mid-turn (network drop, provider timeout, transient 5xx), the agent loop used to lose whatever text had already been emitted and the user had to re-ask from scratch. Now `streamOneTurn` catches non-abort throws and, if any text had been accumulated before the failure, fires a new `onStreamFailure(partial, error)` callback on `AgentCallbacks` before re-throwing. `chatHandlers` stashes the partial on `ChatState.pendingPartialAssistant`, and a new `/resume` slash command re-dispatches the last turn with a hint that says "you were mid-sentence, here's the partial, pick up where you left off, don't repeat verbatim". Any normal `handleUserMessage` call discards a stale partial at the top so old partials never replay. Listener errors in `onStreamFailure` are swallowed so they can't mask the original backend error.
- **Prompt cache byte-stability regression tests.** New test block in [`chatHandlers.test.ts`](src/webview/handlers/chatHandlers.test.ts) pins the invariants that keep Anthropic's prompt cache hitting: (1) byte-identical inputs must produce byte-identical output, (2) the per-session fields must live strictly inside the `## Session` block which must come after the `## Workspace Structure` cache marker, (3) the cached prefix must not contain timestamps, epoch ms, or random-id-looking hex strings. Catches the classic "I sprinkled `new Date().toISOString()` into an injection section" regression before it hits prod.

### Closes cycle-2 audit items

- HIGH: retriever fusion for semantic search + doc index + agent memory (closes the v0.51 deferral).
- MEDIUM: Anthropic prompt cache boundary byte-stability regression tests.
- MEDIUM: No circuit breaker around failing backends.

### Deferred

- `resumeFrom` as a webview button affordance — the slash command works end-to-end but a one-click button in the error toast would be smoother. Follow-up if users ask for it.
- LLM-as-judge scoring in the eval harness.
- Policy-hook interface for `runAgentLoop` (`beforeIteration` / `afterToolResult` / `onTermination`) — still on the HIGH audit list.
- Backend anticorruption layer (`normalizeStream`) — still on the HIGH audit list, enables OpenRouter / Groq / Fireworks.

### Stats

- 1840 total tests (119 test files)
- 23 built-in tools, 8 skills

## [0.51.0] - 2026-04-14

Context budget release. Four independent features, all targeting the same underlying problem: SideCar was spending tokens (and real money) on work that should have been cached, fused, or capped. The theme that tied them together was an actual user incident — a $0.17 real OpenAI spend that still tripped a rate-limit because every turn was pushing ~100k tokens of context through requests that didn't need to be that large.

### Added

- **Retriever fusion with reciprocal-rank fusion.** New [`src/agent/retrieval/`](src/agent/retrieval/) module exposes a unified `Retriever` interface (`retriever.ts`), standard RRF ranking (`fusion.ts`, 60-constant dampening), and adapters for the documentation index (`docRetriever.ts`) and persistent agent memory (`memoryRetriever.ts`). `injectSystemContext()` now runs these adapters in parallel through `fuseRetrievers()` and renders the fused top-K under a single `## Retrieved Context` header — a strong memory hit can now displace a weak doc hit (and vice versa) instead of each source getting its own fixed allocation. Not-ready retrievers are skipped silently and thrown errors are swallowed so one bad source can't break injection. `WorkspaceIndex` is intentionally left out of fusion for this release — it already does its own semantic + heuristic + pinning blend internally and returns a pre-formatted string, so wrapping it would be a rewrite rather than an adapter. Deferred.
- **Unknown-model cost warning + JSON-sourced pricing table.** The hardcoded `MODEL_COSTS` table moved into [`src/config/modelCosts.json`](src/config/modelCosts.json) so pricing can be updated without a TypeScript change, and expanded to cover the common OpenAI lineup (4o, 4o-mini, 4.1, 4.1-mini, 5, 5-mini, o1, o1-mini) plus older Claude 3.x models. `estimateCost()` now emits a one-time `console.warn` for unknown model ids so you find out when a new provider ships something we don't have pricing for — previously it silently returned `null`, which is why the OpenAI cost panel stayed empty despite real spending. Dedup via module-level `Set<string>`; test-only reset helper for unit coverage. `tsconfig.json` gains `resolveJsonModule: true`.
- **ConversationSummarizer per-turn cap.** New `maxCharsPerTurn` option on `SummarizeOptions` bounds each turn's contribution to the pre-LLM facts list. With a 220-char default (`DEFAULT_MAX_CHARS_PER_TURN`), a typical 10-turn window aggregates to ~2.2k chars — well under the default 800-char `maxSummaryLength`, which means the LLM compression round-trip is skipped entirely in the common case. Big agent loops with multi-thousand-char replies no longer balloon the summarizer's input and force an unnecessary LLM call. The assembled `Turn N: query → reply` line is hard-capped after smart-truncation of each half, so pathological query+reply pairs can't blow past the budget either. No new SideCarConfig knob; the default kicks in automatically via [`src/agent/loop/compression.ts`](src/agent/loop/compression.ts).
- **Report cache for `/usage` and `/insights`.** New [`src/webview/handlers/reportCache.ts`](src/webview/handlers/reportCache.ts) with `getOrComputeReport(key, fingerprint, compute, ttlMs)` keyed on a caller-supplied fingerprint plus a 5-minute TTL. Either a fingerprint change OR age beyond the TTL triggers a recompute, so the cache can't go stale even if the underlying data changes in a way the fingerprint didn't catch. `handleUsage()` fingerprints on history length + last metric timestamp; `handleInsights()` fingerprints on audit count + metrics count + memory count + last audit timestamp. `/insights` in particular was walking up to 5000 audit rows through `analyzeConversation()` on every call, even when nothing had changed since the last run.

### Deferred

- Semantic workspace search adapter (would require rewriting `WorkspaceIndex.getRelevantContext` instead of wrapping it).
- SideCarConfig + settings UI exposure for `maxCharsPerTurn` (the default is a working value; reopen if tuning is needed).
- Policy-hook interface for `runAgentLoop` (`beforeIteration` / `afterToolResult` / `onTermination`) — still on the HIGH audit list.
- Eval cases that exercise fusion / cost warning / summarizer cap end-to-end. The underlying retrievers + agent memory aren't yet plumbed through the LLM eval workspace sandbox, so they stay as unit-level coverage for now.

### Stats

- 1816 total tests (116 test files)
- 23 built-in tools, 8 skills

## [0.50.0] - 2026-04-14

Architectural + testing release. No user-facing feature changes — every change is under the hood. The main event: `runAgentLoop` (SideCar's core agent loop) was a 1,216-line god function that nobody wanted to touch. It's now a 255-line orchestrator plus 14 focused helper modules under [`src/agent/loop/`](src/agent/loop/), each with a single clear responsibility. The second event: the LLM evaluation harness shipped in v0.49.1 was extended from 3 baseline cases to 11 agent-loop cases, and every single decomposition phase was verified against those cases before commit — zero behavioral regressions across 9 refactor commits.

### Refactor — `runAgentLoop` decomposition

Closes cycle-2 ai-engineering HIGH finding: *"runAgentLoop is the next god-function decomposition target. 700+ lines owning streaming, compression, cycle detection, memory writes, tool execution, checkpoints, cost tracking, abort handling."*

Same extraction pattern as the already-successful `tools.ts` split (v0.48.0) and `handleUserMessage` decomposition (v0.46.0): single-responsibility helpers, a `LoopState` container object threaded through every call, re-exports preserved on the public module so existing import sites don't need a coordinated rewrite.

**loop.ts size progression** (9 commits, each left the tree green):

| Phase | Commit | `loop.ts` lines | Delta |
|---|---|---:|---:|
| pre-refactor | — | 1,216 | — |
| phase 1: state + compression | `2cf6ead` | 876 | −340 |
| phase 2: stream + cycle + message + text | `997cc44` | 835 | −41 |
| phase 3a: stubCheck | `de159c8` | 765 | −70 |
| phase 3b: criticHook | `99e4248` | 652 | −113 |
| phase 3c: gate | `ba4b17a` | 629 | −23 |
| phase 3d: autoFix | `e9a4e4a` | 591 | −38 |
| phase 3e: executeToolUses | `bf9f530` | 417 | −174 |
| phase 4: finalize + composer + notifications + orchestrator swap | `9452333` | **255** | −162 |

**79% reduction in loop.ts.** The resulting orchestrator reads top-to-bottom as pseudo-code for one iteration: abort check → compression → notifications → checkpoint → stream turn → empty-response gate → cycle checks → assistant message → tool execution → tool-result accounting → post-turn policies → plan-mode return → (next iteration).

**14 new helper modules under [`src/agent/loop/`](src/agent/loop/)** — each takes a `LoopState` parameter, owns one clear responsibility, and imports only what it touches:

- [`state.ts`](src/agent/loop/state.ts) — `LoopState` interface + `initLoopState` factory. Bundles all the mutable + immutable per-run state (messages, iteration counter, totalChars, cycle-detection ring, retry maps, gate state, tools, approval mode) into one reference that helpers can mutate in place.
- [`compression.ts`](src/agent/loop/compression.ts) — `applyBudgetCompression` (pre-turn summarization + tool-result compression when estimated tokens exceed 70% of budget) + `maybeCompressPostTool` (lighter mid-turn compression after tool results are added) + `compressMessages` (moved here from the bottom of loop.ts where it was tangled with unrelated helpers).
- [`streamTurn.ts`](src/agent/loop/streamTurn.ts) — `streamOneTurn` handles the streamChat request, per-event timeout race, the full event-type switch, and converts abort / timeout into a `terminated` marker instead of throwing (simpler branching at the call site). `resolveTurnContent` runs post-stream cleanup (strip repeated paragraphs, fall back to text-level tool-call parsing).
- [`textParsing.ts`](src/agent/loop/textParsing.ts) — `parseTextToolCalls` + `stripRepeatedContent` moved here. Pure functions, independently unit-tested.
- [`cycleDetection.ts`](src/agent/loop/cycleDetection.ts) — `exceedsBurstCap` (12-call per-iteration cap) + `detectCycleAndBail` (length-1 repeat needs 4 consecutive identical calls, length-2..4 patterns trip after two full cycles). Constants now live with the logic they govern.
- [`messageBuild.ts`](src/agent/loop/messageBuild.ts) — `pushAssistantMessage`, `pushToolResultsMessage`, `accountToolTokens`. Three small mutation helpers that keep the orchestration body from inlining the same 10 lines three times.
- [`stubCheck.ts`](src/agent/loop/stubCheck.ts) — `applyStubCheck` owns the stub-validator reprompt ceremony and the `state.stubFixRetries` counter.
- [`criticHook.ts`](src/agent/loop/criticHook.ts) — `runCriticChecks` + `buildCriticDiff` + `extractAgentIntent` + `RunCriticOptions` moved verbatim from the bottom of loop.ts, plus a new in-loop `applyCritic` wrapper that reads config and pushes the blocking injection into history.
- [`gate.ts`](src/agent/loop/gate.ts) — `recordGateToolUses` (post-tool recording into gateState) + `maybeInjectCompletionGate` (empty-response branch check + synthetic verification reprompt). Returns `'injected'` / `'skip'` so the orchestrator knows whether to `continue` or `break`.
- [`autoFix.ts`](src/agent/loop/autoFix.ts) — `applyAutoFix` polls diagnostics after a 500ms settle delay, honors the per-file retry budget on `state.autoFixRetriesByFile`, injects an error-reprompt user message when any written file has errors.
- [`executeToolUses.ts`](src/agent/loop/executeToolUses.ts) — the biggest helper. Parallel tool execution via `Promise.allSettled` with spawn_agent / delegate_task / normal `executeTool` dispatch. Rejected promises are promoted to synthetic error tool_result blocks so the returned array is always 1:1 with pendingToolUses. Charges spawn_agent sub-agent token usage to `state.totalChars`; explicitly does NOT charge delegate_task worker usage (free-backend offload).
- [`postTurnPolicies.ts`](src/agent/loop/postTurnPolicies.ts) — composer for `applyAutoFix` → `applyStubCheck` → `applyCritic`. Three lines in one module so the orchestrator body stays a one-liner.
- [`notifications.ts`](src/agent/loop/notifications.ts) — `notifyIterationStart` (emits `onIterationStart` with iteration / elapsed / estimated tokens / message count / remaining budget / atCapacity), `maybeEmitProgressSummary` (every 5 iterations starting at iteration 5), `shouldStopAtCheckpoint` (60%-of-max checkpoint prompt).
- [`finalize.ts`](src/agent/loop/finalize.ts) — `finalize(state, callbacks)` runs the post-loop teardown (flush tool-chain buffer, emit next-step suggestions when iteration > 1, log done, fire onDone, return state.messages). `generateNextStepSuggestions` moved here from the bottom of loop.ts.

Re-exports preserved on `loop.ts`: `compressMessages`, `parseTextToolCalls`, `stripRepeatedContent`, `runCriticChecks`, `RunCriticOptions`. Every existing import site (`loop.test.ts`, `critic.runner.test.ts`, and the 10+ files that call `runAgentLoop`) stays unchanged.

**Deferred to a follow-up**: policy-hook interface (`beforeIteration` / `afterToolResult` / `onTermination` registration bus). The current decomposition gets file-level separation, but policies are still called directly from the orchestrator rather than registered through a hook bus — that's a separable feature to layer on top.

### Added — agent-loop LLM eval harness expansion

Closes cycle-2 ai-engineering HIGH finding: *"No evaluation harness for LLM behavior."* v0.49.1 shipped the agent-loop layer with 3 starter cases; v0.50.0 extends it to 11 cases covering every reachable code path plus a `workspace.findFiles` sandbox fix.

**New agent eval cases** (all pass against local Ollama `qwen3-coder:30b` in ~90s total):

- `multi-tool-iteration` — forces parallel `Promise.allSettled` path in tool execution with a 5-file line-counting task
- `observe-tool-error-no-fabrication` — asserts the agent observes a `read_file` error on a nonexistent path and doesn't fabricate content by writing a new file
- `no-stub-in-write` — indirect stub-validator coverage via a factorial-implementation prompt with stub-marker assertions on the written file
- `fix-simple-bug` — read + edit trajectory on a real arithmetic bug with file-content assertions
- `search-files-glob` — exercises `search_files` tool + glob matching (new coverage)
- `write-multi-file-batch` — parallel `write_file` dispatch in `executeToolUses`
- `plan-mode-no-tools` — `approvalMode: 'plan'` short-circuit path, asserts no tools fire on iteration 1
- `search-then-edit-multi-file` — multi-step grep → edit across multiple files; **also incidentally triggers `maybeInjectCompletionGate` for real** (the agent edits without verifying and the gate injects its synthetic reprompt)

**New scorer predicate**: `trajectoryHasToolError: boolean` — asserts at least one `tool_result` event had `isError=true`. Useful for cases that deliberately give the agent a bad input and want to pin that the error was observed.

**Sandbox fix**: `workspace.findFiles` was unconditionally returning `[]` in the vitest vscode mock, which silently made every prior eval run think `search_files` had no matches. [`workspaceSandbox.ts`](tests/llm-eval/workspaceSandbox.ts) now overrides it with a minimatch-style walker backed by real `node:fs` that supports `**`, `*`, `?`, `.`, and `{a,b}` glob syntax and respects the exclude pattern. `search_files` now actually hits its real code path in eval runs.

**Coverage by policy/path** (✅ = exercised end-to-end in at least one case):

| Path | Coverage |
|---|---|
| `streamOneTurn` happy path | ✅ every case |
| `executeToolUses` normal dispatch | ✅ every tool-using case |
| `recordGateToolUses` | ✅ every edit case |
| `maybeInjectCompletionGate` | ✅ search-then-edit-multi-file (bonus discovery) |
| `accountToolTokens` | ✅ every case |
| `applyStubCheck` | ✅ no-stub-in-write (indirect) |
| Plan-mode short-circuit | ✅ plan-mode-no-tools |
| `finalize` / next-step suggestions | ✅ every case |
| `applyAutoFix` | ❌ needs `languages.getDiagnostics` mock (deferred) |
| `applyCritic` | ❌ disabled by default (deferred) |
| Burst cap / cycle detection / sub-agent / compression exhaustion | ❌ hard to trigger reliably |

### Engineering discipline

- **Zero regressions across 9 refactor commits.** The eval harness built earlier in the release is exactly the safety net that made the refactor safe to ship. Without it, every phase would have required hope-and-pray manual testing.
- **Bisect hygiene.** Each phase is its own commit, each left `tsc --noEmit` + `npm test` + `npm run eval:llm` green. If anything breaks in a future session, `git bisect` lands on the single helper extraction that introduced the regression.
- Main unit suite: 1,798 passing at every phase boundary (unchanged from v0.49.1).

## [0.49.1] - 2026-04-14

Patch release. No behavior changes for the shipping agent flow — cosmetic, docs, and developer tooling only.

### Changed

- **Activity bar icon** — replaced the white-rectangle placeholder PNG with a traced SVG scooter silhouette ([media/sidecar_silhouette.svg](media/sidecar_silhouette.svg)). Uses `fill="currentColor"` so VS Code's `--vscode-activityBar-foreground` tints the icon automatically on both light and dark themes. `preserveAspectRatio="xMidYMid slice"` fills the square slot vertically; wide-aspect content is cropped slightly at the edges but the cargo box (SideCar identity signal) remains visible. The top-level marketplace-listing icon at [package.json:23](package.json#L23) is unchanged — still `media/SideCar.png`.
- **Kickstand "(coming soon)" labeling** — every user-facing mention of Kickstand in the settings UI (profile picker, `sidecar.baseUrl` description, `sidecar.provider` enum), README, walkthroughs (`02-backend.md`, `05-discover.md`), and published docs (`configuration.md`, `getting-started.md`) now carries a `(coming soon)` tag. The Kickstand backend adapter ships today for anyone running a local dev build, but the first-party release is still in progress — the labeling prevents readers from assuming it's a sign-up-and-go product. Runtime state labels (e.g. "active · Kickstand" in the model picker) are deliberately left plain since they fire only when a user is actively connected.

### Added — developer tooling

- **Agent-loop eval harness** — extends the existing prompt-only LLM eval layer with a second layer that runs `runAgentLoop` end-to-end against a sandboxed temp-dir workspace. New files under [tests/llm-eval/](tests/llm-eval/):
  - `workspaceSandbox.ts` — per-case temp dir + real-node-fs-backed `workspace.fs` swap, reverted on teardown.
  - `agentTypes.ts` — `TrajectoryEvent`, `AgentEvalCase`, `AgentExpectations` (tool-call presence, partial-input matching, workspace file assertions, final-text substrings).
  - `agentHarness.ts` — `runAgentCase` + backend picker. Defaults to local Ollama since agent-loop cases burn real tokens.
  - `agentScorers.ts` — deterministic scorers that walk the trajectory and post-run workspace snapshot; tool-call input matching is substring-based for string fields so "src/a.ts" matches "./src/a.ts" matches "a.ts".
  - `agentCases.ts` — 3 starter cases (read-single-file, rename-function, grep-for-todo).
  - `agent.eval.ts` — vitest runner, mirrors `prompt.eval.ts`. Skips cleanly via `describe.skipIf` when no backend is available.
  - Architectural finding: `runAgentLoop` does NOT require `ChatState`. All the UI plumbing (`PendingEditStore`, `SkillLoader`, `AgentMemory`, `WorkspaceIndex`) lives on `ChatState` and is optional for headless execution. The agent core takes `(client, messages, callbacks, signal, options)` — clean separation. This finding unblocks future headless automation and makes subsequent refactors of the loop itself safer.
  - Run via `npm run eval:llm` — same entry point as the prompt layer. End-to-end verification: all 3 agent cases pass against local Ollama (qwen3-coder:30b) in ~32s. Main unit suite (1798 tests) unchanged.
  - Closes the cycle-2 ai-engineering HIGH finding: *"No evaluation harness for LLM behavior."*

## [0.49.0] - 2026-04-14

Cost-control and user-experience pass plus a cycle-2 audit burn-down. Headline items: OpenAI / Kickstand `max_tokens` fix that stops TPM bucket drain at tiny real spend, per-provider rate-limit isolation, drag-and-drop files/folders into the chat, native tool-output compression for grep/git/read_file, configurable delegate worker cap, and a terminal-error prompt-injection gap closed. 9 commits since v0.48.0, 45 net new tests (1753 → 1798), zero regressions.

### Fixed — backend cost controls

- **`max_tokens` cap on OpenAI and Kickstand streamChat** — OpenAI's rate limiter reserves `max_tokens` (or the model's default output cap when omitted) against the per-minute token bucket at request time, even though billing only counts tokens actually produced. `streamChat` was omitting `max_tokens` entirely, so each request drained ~16k from the TPM bucket regardless of actual completion size. Users hitting $0.17 in real spend saw `7,902/200,000 tokens remaining` because the reservation wasn't refunding cleanly. `max_tokens=4096` is now sent on every streaming request (matches the local estimator); same fix applied to `kickstandBackend.streamChat`. [openaiBackend.ts](src/ollama/openaiBackend.ts), [kickstandBackend.ts](src/ollama/kickstandBackend.ts)
- **OpenAI usage event parsing** — streaming requests now include `stream_options: { include_usage: true }` and the parser emits a `StreamUsageEvent` with real `prompt_tokens` / `completion_tokens` from OpenAI's final chunk, so `spendTracker` records actual consumption instead of heuristic estimates.
- **Per-provider rate-limit store isolation** — `SideCarClient` held a single shared `RateLimitStore` across every backend it constructed; because `update()` merged fields (keeping old values when a new update omitted them), one provider's remaining-token counts leaked into another provider's view when users switched profiles mid-session. Each provider now gets its own lazily-created store via a `Map<ProviderType, RateLimitStore>`, and `getRateLimits()` returns the current provider's store. Removed the `reset()`-on-baseUrl-change workaround in `updateConnection` — no longer needed since each provider is isolated, and it was wiping legitimate same-provider state on host-only changes. [client.ts](src/ollama/client.ts)
- **`describe()` display now shows `used/limit`** — `X/Y` conventionally reads as "used out of total" (progress bars), but `RateLimitStore.describe()` showed `remaining/limit`, so users saw `7,902/200,000 tokens` and thought "only 8k consumed" when it meant the opposite. Display now subtracts `remaining` from `limit` and reports `used/limit` with the blocking-bucket reset time. [rateLimitState.ts](src/ollama/rateLimitState.ts)
- **Verbose-mode request-body breakdown log** — when `sidecar.verboseMode=true`, every OpenAI request logs a one-line breakdown of `system=Xk · history=Yk · tools=Zk · total=Nk` before sending, plus the actual `prompt_tokens` / `completion_tokens` after the response. Makes it trivial to diagnose "why is my TPM bucket empty" by identifying the dominant input bucket. [openaiBackend.ts](src/ollama/openaiBackend.ts)

### Added — user-facing features

- **Drag-and-drop files and folders into the chat** — dropped files are read on the extension host and attached as `pendingFiles[]` chips above the input, with per-chip remove buttons. Accepts both VS Code explorer drags (`text/uri-list`) and OS file-manager drags (`dataTransfer.files[].path`). Folders expand shallowly, skipping dotfiles and the usual junk directories (`node_modules`, `.git`, `dist`, `out`, `build`, `.next`, `.turbo`, `.venv`). Per-file cap 500KB (matches the existing attach-file button), overall cap 20 attachments per drop, binary content rejected via NUL-byte sniff. Skipped items surface in an info toast with a short reason list. [chatHandlers.ts:1446+](src/webview/handlers/chatHandlers.ts), [chat.js](media/chat.js)
- **Native tool-output compression for grep, git_diff, and read_file** — new [`src/agent/tools/compression.ts`](src/agent/tools/compression.ts) module with pure-function helpers:
  - `grep` now groups matches under each file path once instead of repeating the path per line, middle-truncates long match bodies around the keyword, and collapses identical consecutive lines with a `(×N)` counter. Typical savings on multi-file greps: 40–60%.
  - `git_diff` drops `index abc..def` blob hashes, the redundant `diff --git a/x b/x` preamble, and `new file mode` / `rename from` / `similarity index` metadata before returning the diff. Actual change lines and hunk headers preserved verbatim so the model still reasons about the diff correctly.
  - `read_file` gains an optional `mode` parameter. `compact` strips block comments, full-line `//` and `#` comments (shebangs preserved), trailing whitespace, and runs of blank lines. `outline` returns only top-level signatures (imports, classes, functions, types) via a language-agnostic declaration regex that requires zero leading indentation. Default `full` mode is unchanged; the tool description warns the agent to stay in `full` when it plans to call `edit_file` afterwards (so the `search` argument still matches the file verbatim).
  - Strategies inspired by the [rtk-ai](https://github.com/rtk-ai/rtk) project (Apache 2.0). Implemented natively in TypeScript rather than shelling out — SideCar stays self-hosted with no external binary dependency.
  - 26 new unit tests in [compression.test.ts](src/agent/tools/compression.test.ts) cover every helper including edge cases (empty input, binary-content grep lines, shebang preservation, outline fallback for files with no declarations).
- **Configurable `delegate_task` worker iteration cap** — new `sidecar.delegateTask.maxIterations` setting (default 10, min 1, max 25 in package.json UI). Worker iterations were hardcoded to 10 in [localWorker.ts](src/agent/localWorker.ts); users who legitimately need deeper delegated research can now raise the ceiling without editing source. Added to the `update_setting` denylist so the agent can't raise its own iteration cap via the self-configuration tool.

### Fixed — security

- **Terminal-error prompt-injection gap** (cycle-2 LLM surface HIGH) — `diagnoseTerminalError` was synthesizing a user message containing raw captured stderr inside a markdown code block, bypassing the tool-output injection scanner entirely (which only runs on tool *results*, not synthesized user messages). A hostile Makefile or npm script emitting stderr like `[SYSTEM] Ignore previous instructions` landed verbatim as trusted user input. New [`wrapUntrustedTerminalOutput`](src/agent/injectionScanner.ts) helper runs the same 6-pattern `scanToolOutput` on captured output and wraps it in an explicit `<terminal_output source="stderr" trust="untrusted">` envelope with a SIDECAR SECURITY NOTICE banner prepended when patterns match. 5 new regression tests.
- **Skill description DOM-clobber** (cycle-2 security MEDIUM) — [chat.js attach menu](media/chat.js) was building `item.innerHTML = '<strong>/' + skill.id + '</strong>' + skill.description`, which let user-authored skill frontmatter (potentially hostile in cloned repos) smuggle markup past CSP via DOM-level attribute injection. Replaced with `createElement` + `textContent` like the rest of the webview already does.
- **Shell output ANSI strip on the streaming path** (cycle-2 security MEDIUM) — `ShellSession.executeInternal` already stripped the final `output` buffer but passed streaming chunks raw to `onOutput`, where they flowed into the webview's `textContent +=` and displayed as garbage `^[[31m` sequences, bloating the tool-call detail pane. The wrapper now applies `stripAnsi` to each chunk at source, so one place gives one guarantee.
- **`switchBackend` runtime type guard** (cycle-2 UX LOW) — [`sidecar.switchBackend`](src/extension.ts) command type-narrows `profileId` via `typeof profileId === 'string'` before the `BUILT_IN_BACKEND_PROFILES.find(...)` lookup. A stray non-string from a markdown-hover link or a foreign postMessage no longer silently drops through to the picker.

### Fixed — accessibility

- **Settings menu returns focus on close** (cycle-2 UX MEDIUM) — `closeSettingsMenu` now calls `settingsBtn.focus()` so keyboard and screen-reader users don't lose their place after Escape / click-outside dismissal.
- **`aria-current="true"` on active backend profile** (cycle-2 UX LOW) — the visible checkmark on the active backend profile is now also announced to assistive tech via `aria-current`.

### Fixed — code hygiene

- **`isContinuationRequest` file-local** (cycle-2 arch LOW) — was exported from [chatHandlers.ts](src/webview/handlers/chatHandlers.ts) for no reason; only consumed within the same file. Now file-local. `classifyError` and `keywordOverlap` stay exported because they have their own test coverage in [chatHandlers.test.ts](src/webview/handlers/chatHandlers.test.ts).
- **README "Partial" label** — downgraded "Hybrid cost-aware delegation" from "Yes" to "Partial" in the comparison tables. `delegate_task` offloads read-only research to a local Ollama worker; it is not a general-purpose multi-agent execution system.

### Closed — stale audit entries

Five cycle-2 findings were actually already fixed but never struck:

- HIGH "No rate-limit awareness" — `maybeWaitForRateLimit` has been in every backend's `streamChat` path since v0.47.0.
- HIGH "Indirect prompt injection via `web_search` results" — already flows through the executor's `wrapToolOutput` + `scanToolOutput`.
- HIGH "Indirect prompt injection via git metadata (log / PR / issue bodies)" — same path.
- MEDIUM "`BackgroundAgentManager` shared `shellSession`" — closed by the per-run `ToolRuntime` fix in commit `e32ab49`.
- MEDIUM "MCP header `${VAR}` expansion pulls from unfiltered `process.env`" — `resolveEnvVars` in [mcpManager.ts](src/agent/mcpManager.ts) has been scoped to the per-server `env` block since cycle-1.
- MEDIUM "chatView.ts direct `getConfiguration('sidecar')` reads" — the remaining calls are writes, which must use raw `getConfiguration` by design.

## [0.48.0] - 2026-04-14

Cycle-2 audit hardening pass plus two new user-facing capabilities: the agent can now switch backends and update SideCar settings via natural-language prompts (behind a mandatory approval modal), and OpenAI is a first-class backend profile. 21 commits since v0.47.0, 123 net new tests (1630 → 1753), zero regressions.

### Added — agent can configure itself

- **`switch_backend` agent tool** — enum of `local-ollama` / `anthropic` / `openai` / `kickstand`, resolves a profile from `BUILT_IN_BACKEND_PROFILES` and calls `applyBackendProfile()`. Returns the same status message as the Command Palette flow, including `missing-key` hints telling the user to run `SideCar: Set API Key` first ([tools/settings.ts](src/agent/tools/settings.ts)).
- **`get_setting` agent tool** — reads the current value of any `sidecar.*` setting as JSON. `apiKey` and `fallbackApiKey` are blocked outright — API keys live in VS Code's SecretStorage and are never exposed to tools.
- **`update_setting` agent tool** — writes to user (global) scope with a 17-key security denylist covering secrets, backend identity (use `switch_backend` instead), tool permissions, custom tools/modes/MCP servers, hooks, scheduled tasks, outbound allowlist, system prompt override, and arbitrary context paths. The denylist is pinned by a regression test so adding a new security-sensitive setting must be a deliberate, test-breaking change.
- **`alwaysRequireApproval` tool field** — new field on `RegisteredTool` that forces an approval modal on every call regardless of approval mode OR per-tool permission overrides. Both mutating settings tools carry the flag — the user's durable configuration never changes without an explicit click, even in autonomous mode, even when `toolPermissions: { switch_backend: 'allow' }` is set ([executor.ts](src/agent/executor.ts)).
- **OpenAI backend profile** — new `openai` entry in `BUILT_IN_BACKEND_PROFILES` with `gpt-4o` as the default model and `sidecar.profileKey.openai` as the secret slot. Picks up automatically in the Switch Backend QuickPick since that flow iterates the profile list. Closes the gap where OpenAI was supported as a provider type but was the only major backend missing from the built-in list.

### Fixed — cycle-2 architecture

- **Per-run `ToolRuntime` for background agents** (cycle-2 arch MEDIUM) — parallel background agents used to share `defaultRuntime.shellSession`, so `cd` / `export` / alias changes in one agent would trample another. `BackgroundAgentManager.executeRun` now constructs a fresh `ToolRuntime` per run and threads it through `AgentOptions.toolRuntime` → `ToolExecutorContext.toolRuntime` → new `resolveShellSession(context)` helper in [tools/shell.ts](src/agent/tools/shell.ts). Disposed on success, failure, and cancel paths. Foreground chat sessions continue to use the default runtime with no behavior change.
- **`ChatState.dispose()` + hoisted `SIDECAR.md` cache** — `sidecarMdCache` and `sidecarMdWatcher` moved from free-floating module globals in `chatHandlers.ts` onto private fields of `ChatState`. `ChatState.dispose()` is idempotent and tears down the abort controller, pending confirmations, the owned `PendingEditStore`, and the watcher. `ChatViewProvider.dispose()` cascades through.
- **Atomic thinking + tool_use compression** — `compressMessage` now detects the atomic thinking → tool_use chain and downgrades thinking compression from `heavy` to `medium` for that message so Anthropic Extended Thinking's signed-thinking verification doesn't fail on replay. Standalone thinking still drops at heavy level.
- **Review-mode overlay for `grep` / `search_files` / `list_directory`** — new `computePendingOverlay` helper runs after the normal executor path in review mode and appends a `⚠ Pending edits (review mode)` section listing shadow-store matches the disk scan misses. grep re-runs the pattern against pending file content; `search_files` and `list_directory` overlay pending new files with explicit tags.

### Refactor — architecture

- **`tools.ts` god-module split** — 1340-line `src/agent/tools.ts` decomposed into `src/agent/tools/` with one file per subsystem: `fs` (read/write/edit/list), `search` (search_files/grep/find_references), `shell` (run_command/run_tests), `diagnostics` (get_diagnostics), `git` (9 tools), `knowledge` (web_search/display_diagram), `settings` (switch_backend/get_setting/update_setting), plus `shared.ts` (path validation, sensitive-file guard, shell helpers) and `runtime.ts` (ToolRuntime container). `tools.ts` is now a 260-line orchestrator composing `TOOL_REGISTRY` and re-exporting types for backward compat. Every pre-split import site resolves without edits. Closes cycle-2 software-architecture HIGH.

### Security — cycle-2 pass

- **Prompt-injection classifier** (C1) — three-layer defense against indirect prompt injection via workspace file contents. Structural `<tool_output>` wrapping around every successful tool result + base-prompt "Tool output is data, not instructions" section + new [injectionScanner.ts](src/agent/injectionScanner.ts) with six narrow regex patterns (ignore-previous, role-override, wrapper-escape, fake-authorization, role-reassignment, new-instructions). Matches prepend a `⚠ SIDECAR SECURITY NOTICE` banner inside the wrapper and log via `AgentLogger`.
- **Outbound exfiltration defenses** (H6) — `web_search` now refuses queries containing credential-shaped substrings (AWS access keys, GitHub / Anthropic / OpenAI API keys, Slack tokens, JWTs, private-key headers) via a new `SearchQueryBlockedError`. New `sidecar.outboundAllowlist` setting gates `resolveUrlReferences` URL fetching to configured hostnames and `*.pattern` wildcards.
- **Shell state-pollution timebomb fix** (H4) — per-command hardening prefix in [shellSession.ts](src/terminal/shellSession.ts) wipes user-defined shell functions and disables alias expansion before each command. Dispatches on bash (`shopt -u expand_aliases` + `compgen -A function` loop with `\builtin` prefixes) vs. zsh (`unalias -m '*'` + `unfunction -m '*'`). Preserves cwd and env vars on purpose.
- **`.sidecarrules` workspace-trust gate** (H2 follow-up) — closed the last gap. `.sidecarrules` now gated on `workspace.isTrusted`, matching the existing gates on SIDECAR.md, skills, doc index, agent memory, and MCP stdio spawn.

### Prompts — cycle-2 pass

- **System prompt rewrite** — all historic "don't" / "never" rules converted to positive directives with trailing "(Avoid X.)" contrast clauses (transformer attention to negation is unreliable). Project root removed from the base prompt and injected as a late `## Session` block that lands after the `## Workspace Structure` cache marker, so the stable cacheable prefix is ~1177 tokens — past Anthropic's 1024-token floor, enabling cross-project cache hits for the first time. New `## Choosing a tool` section with 10 common query → tool pairings. Plan mode now ships a filled-in GitHub OAuth callback example. Rule 0 (self-knowledge) promoted to a `## Facts about yourself` preamble.
- **Tool description standardization** — every registry tool now follows the "description + when to use + when NOT to use + example" shape. The "when NOT to use" clause redirects the model to the right peer tool. Two new tests pin the minimum specificity (≥150 chars, at least one example) so future edits can't silently drop it.

### Documentation

- **Adversarial Critic README section** — new README.md section explaining what the critic does, when it fires (successful edits + failed test runs), how high-severity findings block the turn via synthetic injection, how low-severity findings surface as chat annotations, and cost implications on paid backends. The critic feature itself (at [critic.ts](src/agent/critic.ts)) was already fully built — this release adds loop-side integration tests and user-facing documentation.
- **Walkthrough rewrite** — the five getting-started walkthroughs got an accuracy and clarity pass. 01-welcome keeps the concrete feature list (keyboard shortcuts, cost tracking, pending-change review) and now includes the `⌘.` / `Ctrl+.` lightbulb shortcut. 03-chat trimmed a duplicate "Quick tips" section and restored "in the header dropdown" on the agent modes intro. 05-discover added a slash command reference plus documentation and GitHub links. 04-inline: removed a factually wrong "Quick tips" section claiming `@file:` / `@pin:` / `@symbol:` work in inline chat (they don't — inline chat goes through `inlineChatProvider.ts` which never calls `resolveReferences`).
- **Doc "RAG" → "Doc Index" rename** — class-level docs, README, and [docs/rag-and-memory.md](docs/rag-and-memory.md) all updated to accurately describe the keyword-tokenized paragraph index instead of misleadingly calling it RAG. Setting keys kept for backward compatibility. The real embedding-based semantic retriever continues to live in `embeddingIndex.ts` (gated by `sidecar.enableSemanticSearch`).
- **Landing page font propagation** — Inter font now applied to documentation pages so typography is consistent across the landing page and the generated docs site.

### Tests

- **Adversarial critic integration tests** (13) — new [critic.runner.test.ts](src/agent/critic.runner.test.ts) covers the loop-side wiring the pure-logic [critic.test.ts](src/agent/critic.test.ts) couldn't reach: trigger selection, severity dispatch, per-file injection cap enforcement across iterations, malformed-response handling, network-error swallowing, and abort-signal early return. `runCriticChecks` + `RunCriticOptions` exported from loop.ts as a test seam.
- **Per-run `ToolRuntime` regression tests** (20) — [tools/runtime.test.ts](src/agent/tools/runtime.test.ts) for the class itself (instance isolation, session memoization, dispose idempotency, dead-session replacement, singleton identity, per-instance symbol graph), [tools/shell.test.ts](src/agent/tools/shell.test.ts) for the resolver contract (identity-based assertion that `runCommand` and `runTests` never touch the default runtime when a per-call one is provided), and [backgroundAgent.test.ts](src/agent/backgroundAgent.test.ts) for the integration (fresh runtime per run, dispose on success, dispose on failure, parallel runs get distinct runtimes).
- **Settings tool regression tests** (25) — [tools/settings.test.ts](src/agent/tools/settings.test.ts) covers every denylist group, the approval contract, error paths, and a regression test pinning the exact denylist shape.
- **Cycle-2 security, prompt, and architecture tests** — 60+ additional tests across the injection scanner, shell hardening, outbound allowlist, review-mode overlay, atomic compression, tool description shape, and `ChatState` disposal.

## [0.47.0] - 2026-04-14

Large native-feel pass plus cost-control and hybrid-delegation work for paid backends. 14 distinct native VS Code surfaces added, one new agent tool (`delegate_task`), a session spend tracker, and a prompt-pruner pipeline that cuts token usage 60-90% on heavy agent loops. Tests: 1630 passing (171 new since v0.46.0).

### Added — cost controls & hybrid delegation

- **Session spend tracker** — new `SpendTracker` singleton with an Anthropic/Claude price table (Opus 4.6/4.5, Sonnet 4.6/4.5, Haiku 4.5 + 3.x fallbacks) that records every Anthropic streaming response's `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, and `cache_read_input_tokens`. A new `$(credit-card)` status bar item appears the moment a paid backend incurs cost, clickable to open a QuickPick breakdown with per-model totals, request counts, and a reset action. Commands: `SideCar: Show Session Spend`, `SideCar: Reset Session Spend`. Uses list prices — actual billing may vary; authoritative totals live in the Anthropic Console ([spendTracker.ts](src/ollama/spendTracker.ts)).
- **Anthropic prompt caching** — tool definitions and conversation history now carry `cache_control: { type: 'ephemeral' }` breakpoints so agent loops cache-read the stable prefix. `prepareToolsForCache` marks the last tool in the request (caching the entire tool block); `prepareMessagesForCache` marks the second-to-last user message so the current turn stays cheap to write while every prior turn is cache-read. Pairs with the existing system-prompt cache split in `buildSystemBlocks` ([anthropicBackend.ts](src/ollama/anthropicBackend.ts)).
- **Prompt pruner** — new `prunePrompt` pipeline runs before serialization for Anthropic and OpenAI requests. Three transforms: whitespace collapse (3+ blank lines → 2), head+tail tool-result truncation with an explicit `[...N bytes elided...]` marker, and duplicate tool-result dedup where the second+ copy of a file read within one request becomes a back-reference. Measured 90.2% reduction on a realistic verbose fixture (30,676 bytes → 3,008 bytes). Safe for agent loops — only lossy on tool output, never on user or assistant messages. Settings: `sidecar.promptPruning.enabled` (default on), `sidecar.promptPruning.maxToolResultTokens` (default 2000) ([promptPruner.ts](src/ollama/promptPruner.ts)).
- **`delegate_task` tool** — new hybrid-architecture tool exposed only to paid backends (Anthropic, OpenAI) that lets the frontier orchestrator offload read-only research to a local Ollama worker. The worker runs on its own `SideCarClient` pointed at `localhost:11434` with a read-only tool subset (`read_file`, `grep`, `search_files`, `list_directory`, `get_diagnostics`, `find_references`, `git_*`, `display_diagram`) and returns a compact structured summary. Token consumption never touches the orchestrator's paid-budget char counter. Settings: `sidecar.delegateTask.enabled` (default on), `sidecar.delegateTask.workerModel`, `sidecar.delegateTask.workerBaseUrl` ([localWorker.ts](src/agent/localWorker.ts)).
- **`StreamEvent` usage event + `TokenUsage` type** — backends now emit a `usage` stream event at `message_stop` carrying input/output/cache-write/cache-read token counts. `SideCarClient.streamChat` forwards the event to `spendTracker.record(...)` transparently. Makes the spend tracker a zero-config observer ([types.ts](src/ollama/types.ts)).
- **Fallback Claude model catalog** — `ANTHROPIC_FALLBACK_MODELS` (Opus 4.5/4.1/4, Sonnet 4.5/4, Haiku 4.5, plus `-latest` aliases for 3.7/3.5/3 Opus) used when `/v1/models` returns empty, 4xx's, or throws. Ensures the model dropdown is always populated on proxied or scoped Anthropic keys that don't expose the models endpoint.

### Added — native VS Code integration pass

- **Native error toasts with one-click recovery actions** — new `errorSurface.ts` module promotes high-severity errors (auth, connection, model) from inline chat messages into `window.showErrorMessage` toasts with action buttons (`Set API Key`, `Switch Backend`, `Open Model Picker`) that execute the real VS Code command on click. Rate-limit / validation / content-policy errors stay in-chat. JSON request-id noise is stripped from the toast body and long messages cap at 200 characters ([errorSurface.ts](src/webview/errorSurface.ts)).
- **Status bar health indicator** — new `healthStatus.ts` singleton tracks backend state (`unknown` / `ok` / `degraded` / `error`) and drives the model status bar item's icon, background color, and `MarkdownString` tooltip. On auth / connection errors the item turns red with `$(error)` and `statusBarItem.errorBackground`; on successful chat completion it returns to `$(hubot)` with normal colors. The tooltip shows the model, backend, last error body, and three clickable `command:` links (`Toggle chat`, `Switch backend`, `Set API key`) ([healthStatus.ts](src/ollama/healthStatus.ts)).
- **Lightbulb code actions** — new `SidecarCodeActionProvider` registered for all `file` scheme documents contributes three kinds to VS Code's native code actions menu (`⌘.` / `Ctrl+.`): **Fix with SideCar** (`QuickFix`, bound to each actionable diagnostic), **Explain this error with SideCar** (`Empty` kind), and **Refactor with SideCar** (`RefactorRewrite`, appears in the Refactor submenu on any non-empty selection). Each action forwards `{code, fileName, diagnostic}` so keyboard and context-menu invocations still work ([sidecarCodeActionProvider.ts](src/edits/sidecarCodeActionProvider.ts)).
- **Native modal approval for destructive tools** — `ConfirmFn` gained an optional `{modal?, detail?}` options bag and `state.requestConfirm` branches on `options.modal` to call `window.showWarningMessage(message, {modal: true, detail}, ...items)` instead of the inline chat card. New `NATIVE_MODAL_APPROVAL_TOOLS` set routes `run_command`, `run_tests`, `git_stage`, `git_commit`, `git_push`, `git_pull`, `git_branch`, `git_stash` through the modal path so the user can't miss the prompt while scrolled away from chat. Write tools stay on the diff-preview path ([executor.ts](src/agent/executor.ts)).
- **Persistent empty-state welcome card** — new chat webview empty state renders when there are no messages (first launch, after Clear Chat, fresh session). Shows the active model + backend with a green status indicator, three quick-action buttons (`Set / Refresh API Key`, `Switch Backend`, `Browse Commands`), four clickable starter prompt chips that pre-fill the input, and platform-aware keyboard shortcut hints (`⌘⇧I` / `Ctrl+Shift+I`, etc.). Replaces the legacy one-shot onboarding card. Extension-side whitelist handler (`executeExtensionCommand`) gates which commands the webview can invoke ([chat.js](media/chat.js)).
- **File decoration provider for pending agent edits** — new `PendingEditDecorationProvider` watches `PendingEditStore.onChanged` and renders a single-letter `P` badge with the `gitDecoration.modifiedResourceForeground` color on every file with a pending review-mode edit. `propagate: true` so parent folders show the rollup indicator (matching git's M/A/D convention). Minimal refresh strategy — computes the symmetric set difference on every store change ([pendingEditDecorationProvider.ts](src/edits/pendingEditDecorationProvider.ts)).
- **Problem markers in the Problems panel** — new `sidecarDiagnostics.ts` wraps a single `DiagnosticCollection('sidecar')`. The executor's post-write security scan (`scanFile` + `detectStubs`) publishes findings with source tags `sidecar-secrets`, `sidecar-vulns`, or `sidecar-stubs`. Tag the Problems panel filter with `source:sidecar-secrets` to scope. Leaked API keys, SQL concat queries, eval calls, `// TODO: implement` stubs all show up natively alongside tsc/eslint findings. New command: `SideCar: Clear Diagnostics` ([sidecarDiagnostics.ts](src/agent/sidecarDiagnostics.ts)).
- **Getting-started walkthroughs contribution** — new `contributes.walkthroughs` entry registers a five-step `SideCar: Get Started` walkthrough in VS Code's native Welcome editor. Steps: Welcome, Pick a backend, Open the chat, Inline editing and the lightbulb, Discover every action. Auto-opens on first install after a 1.5s delay, gated by `globalState.get('sidecar.walkthroughSeen')`. Reopen via `SideCar: Open Walkthrough`. `.vscodeignore` updated with `!media/walkthroughs/**` so the markdown ships in the .vsix ([media/walkthroughs/](media/walkthroughs/)).
- **Quick Pick model switcher** — new `sidecar.selectModel` command opens a native `window.createQuickPick<ModelQuickPickItem>()` with a busy spinner while loading, then the backend's installed models (flagged with `$(check)` for the active one and `active · <Provider>` descriptions) plus the Ollama library models (flagged with `$(cloud-download)` and `not installed — click to pull via Ollama`). Empty-state recovery via a native warning with `Switch Backend` / `Set API Key` actions. Shares the model-switch path with the webview dropdown through a new public `ChatViewProvider.setModel(name)` method ([extension.ts](src/extension.ts)).
- **Activity bar badge for pending-review count** — `registerReviewPanel` now sets `treeView.badge = {value, tooltip}` on the `sidecar.reviewPanel` TreeView whenever `PendingEditStore.onChanged` fires. VS Code aggregates the badge up to the SideCar Activity Bar icon automatically. Singular/plural wording extracted into a pure `computeReviewBadge(count)` helper ([reviewPanel.ts](src/agent/reviewPanel.ts)).
- **Native progress notifications for long operations** — `window.withProgress({location: ProgressLocation.Notification})` wraps the four palette-triggered one-shot commands: `sidecar.reviewChanges`, `sidecar.summarizePR`, `sidecar.generateCommitMessage`, `sidecar.scanStaged`. Users who invoke these from the Command Palette with the chat view hidden now see a bottom-right toast with a spinner + title + status message for the duration ([extension.ts](src/extension.ts)).

### Changed — command palette audit & polish

- **Consistent `SideCar:` category across every palette command** — every `sidecar.*` command now uses `"category": "SideCar"` with a simple title. VS Code auto-formats as `SideCar: <title>` in the palette. Fixed three previously inconsistent entries (`Toggle SideCar Chat` → `SideCar: Toggle Chat`, `Explain with SideCar` → `SideCar: Explain Selection`, etc.) and added icons to every command.
- **`menus.commandPalette` gating for internal / context-sensitive commands** — `sidecar.review.acceptFile` / `discardFile` / `openDiff` hidden from the palette (`when: "false"`) since they're tree-item commands that take arguments. `sidecar.acceptInlineEdit` / `rejectInlineEdit` gated on the existing `sidecar.hasInlineEdit` context key. `sidecar.explainSelection` / `fixSelection` / `refactorSelection` gated on `editorHasSelection`.
- **Custom tooltips with 150ms delay on chat view buttons** — replaced HTML `title` attributes (which use the browser's ~500-1000ms native delay) with a CSS-based `[data-tooltip]` + `aria-label` pattern. New `::after` pseudo-element styled with `--vscode-editorHoverWidget-*` tokens ([chat.css](media/chat.css)).
- **Right-click context menu on chat messages** — single delegated `contextmenu` listener on `messagesContainer` opens a themed popover with dynamic items: **Copy message** / **Delete message** always; **Copy code** + **Save code as...** when the click landed on a `.code-block`; **Why?** + **Copy output** when the click landed on a `.tool-call`. Each item supports an optional `detail` field (muted italic suffix) so "Why?" entries are labeled with the tool name. Uses `--vscode-menu-*` theme tokens ([chat.js](media/chat.js)).
- **Anthropic `listInstalledModels` fix** — when provider is `anthropic`, the client now hits `GET /v1/models` with `x-api-key` + `anthropic-version: 2023-06-01` headers. Before: fell through to the Ollama `/api/tags` path against `api.anthropic.com` and threw, showing "Cannot connect to API" even with a valid key.
- **`SideCar: Set / Refresh API Key` command** — renamed from `SideCar: Set API Key (SecretStorage)`, added `$(key)` icon, surfaced as a navigation action in the chat view title bar. Trims whitespace on save (defense-in-depth trim also at the `AnthropicBackend` constructor); rejects empty input; calls `chatProvider.reloadModels()` after saving so the UI recovers without reloading the window.
- **Reload-models connection refresh** — `ChatViewProvider.reloadModels()` now calls `updateConnection(baseUrl, apiKey)` and `updateModel(model)` from the current config before listing. Previously the refresh raced the `onDidChangeConfiguration` listener and listed models against the stale client immediately after a backend switch.
- **Settings polish** — targeted pass across `sidecar.*` configuration entries in package.json. Added `enumDescriptions` to enum settings (`sidecar.provider`, `sidecar.chatDensity`), upgraded ~30 plain `description` fields to `markdownDescription` with code formatting and cross-setting links, added `order` fields to cluster the Settings UI (0-9 backend → 10-15 context → 20-24 agent → 40-49 cost → 50-55 UI), added `tags: ["sidecar", "backend"|"agent"|"cost"|"ui"|"context"|"secret"]` for filter chips, and added missing `minimum`/`maximum` guardrails on numeric settings.
- **Killed duplicate slash commands** — `/reset`, `/export`, `/compact`, `/undo` removed from `chat.js` (each duplicated a header button or Command Palette entry). The `/help` autocomplete list is pruned to match and ends with a tip pointing users at the header buttons and `SideCar:` palette commands.
- **Undo All Changes UI removed from the chat header** — the rotating-arrow `#undo-btn` button and its click handler are gone. The underlying `sidecar.undoChanges` command / keybinding / palette entry are still registered.
- **One-click backend profile switcher** — new gear-icon (⚙) settings menu in the chat header replaces the old Export button. Opens a context menu with a **Backend** section listing three built-in profiles (Local Ollama, Anthropic Claude, Kickstand), the currently active one checkmarked. Clicking a profile runs the new `sidecar.switchBackend` command, which writes `baseUrl` / `provider` / `model` in one shot and swaps in the profile's stored API key from its own SecretStorage slot (`sidecar.profileKey.<id>`). Missing-key case surfaces a warning with a "Set API Key" action. Also available via the Command Palette as `SideCar: Switch Backend`.
- **`sidecar.enableMermaid` setting** (default on) — when disabled, `chatWebview` skips the mermaid URI injection entirely and `chat.js` falls through to plain code-block rendering for ```mermaid fences.

### Fixed

- **Anthropic reachability check no longer masquerades bad URLs / bad keys as outages.** `isProviderReachable` probed `https://api.anthropic.com/` bare, which Anthropic returns 404/405 for. Now probes `/v1/models` with the real auth headers, and for remote providers treats any response < 500 as reachable ([providerReachability.ts](src/config/providerReachability.ts)).
- **`/init` overwrite of SIDECAR.md no longer leaves stale editor content.** Now routes through `WorkspaceEdit.replace` against the full document range + `doc.save()` so VS Code's in-memory document stays in sync with disk.

### Stats
- 1630 total tests (107 test files, 171 new since v0.46.0)
- 23 built-in tools (22 core + conditional `delegate_task` on paid backends), 8 skills
- 14 new native VS Code integration surfaces

### Refactor / Code Quality

Closed out all remaining cycle-1 audit items from the original v0.34.0 review — 17 items across two commits.

- **`handleUserMessage` decomposed**: 443 → 172 lines via six extracted helpers (`prepareUserMessageText`, `updateWorkspaceRelevance`, `connectWithRetry`, `checkBudgetLimits`, `buildSystemPromptForRun`, `recordRunCost`) and a `createAgentCallbacks` factory that owns the per-run text buffer, flush timer, and current iteration closure. Main function is now pure orchestration.
- **`ToolRuntime` class**: unified the `shellSession` + `symbolGraph` module globals into one object with a single dispose point and a single injection seam. Backward-compat `disposeShellSession` / `setSymbolGraph` wrappers keep existing tests and extension activation unchanged.
- **chat.js modularization started**: removed misleading `@ts-nocheck` / `eslint-disable` comments (nothing in `media/` was ever typechecked per tsconfig scoping). Extracted GitHub card rendering (245 lines) to `media/chat/githubCards.js` via `window.SideCar.githubCards` namespace. `chat.js` is now 210 lines smaller (3617 → 3407) and gains a pattern for further subsystem extractions.
- **`github/api.ts` typed responses**: defined `RawPR`, `RawIssue`, `RawRelease`, `RawRepoContent` raw-payload interfaces and centralized parsing in `parsePR` / `parseIssue` / `parseRelease`. Removes every per-field `as number` / `as string` cast.
- **`GitHubAction` union type**: 16-member exhaustive union in `github/types.ts` replacing stringly-typed `action?` and `githubAction?` fields on webview messages.
- **`loop.ts` tool-use/result char counting** delegated to `getContentLength(pendingToolUses) + getContentLength(toolResults)`, removing the hand-rolled duplicate.
- **`CONTEXT_COMPRESSION_THRESHOLD` constant** extracted so `0.7` no longer collides semantically with `INPUT_TOKEN_RATIO`.
- **`chat.js` card rendering** collapsed into shared `ghDiv` / `ghStatePill` / `ghLink` / `ghCardTitle` / `ghAuthorMeta` helpers; all six GitHub action branches now build on them.
- **`isReachable` / `ensureReachable` wrappers deleted**; call sites call `isProviderReachable(state.client.getProviderType())` directly.
- **Pruning message** now uses `CHARS_PER_TOKEN` constant instead of hardcoded `/ 4`.
- **ROADMAP backlog reconciled**: struck through nine audit items that were already fixed in earlier work but not reflected — `abortableRead` in the Anthropic backend, malformed tool input rejection, `withFileLock` per-path mutex, messages mutation via generation guard, `deleteRelease` through `this.request`, bracket-notation access cleanup, double workspace-state deserialization replaced with `getSpendBreakdown`, and more.

## [0.46.0] - 2026-04-12

### Added

- **Agent diff review & merge** — new `review` approval mode buffers every `write_file` / `edit_file` call an agent makes into an in-memory `PendingEditStore` instead of touching disk. Pending changes surface in a dedicated **Pending Agent Changes** TreeView (SideCar activity bar) with diff-added / diff-modified icons. Click any file to open VS Code's native diff editor showing the captured baseline vs. the pending content. Accept / Discard per file via inline icons, or Accept-All / Discard-All from the panel title bar. Read-through is transparent: when the agent calls `read_file` on a path it has already edited this session, the executor returns the pending content so the agent sees a consistent view of its own in-progress work. Five new commands (`sidecar.review.acceptFile`, `.discardFile`, `.acceptAll`, `.discardAll`, `.openDiff`). v1 ships session + file granularity; hunk-level accept/reject is deferred to v2.
- **JSDoc staleness diagnostics** — on save and open of any TypeScript / JavaScript file, SideCar scans top-level function / arrow declarations and their leading JSDoc blocks for mismatched `@param` tags. Orphan tags (the JSDoc has a tag for a parameter the signature no longer has) and missing tags (the signature has a parameter with no matching JSDoc entry) surface as warning diagnostics with two quick fixes: "Remove orphan" (deletes the stale tag line) and "Add missing" (inserts a new tag line preserving the JSDoc block's indentation and `*` prefix). Quick-fix lookups resolve the owning function by name (extracted from the diagnostic message), so fixes still apply cleanly after an earlier fix in the same block shifted lines. Toggle with `sidecar.jsDocSync.enabled` (default on).
- **README sync** — on save and open of `README.md`, SideCar scans fenced ts / tsx / js / jsx code blocks for calls to workspace-exported functions whose argument count no longer matches the current signature. Also re-runs automatically when any source file under `src/` saves, so the user sees README drift immediately when they change an API. Exported-function index is seeded via `workspace.findFiles` on activation and refreshed incrementally on file save / create / change / delete. Stale calls surface as warnings with a "Update call to foo() (N arguments)" quick fix that rewrites the call — dropping trailing args when there are too many, or appending the missing parameter names as placeholders when there are too few. Method calls (`obj.foo(...)`), constructor calls (`new Foo(...)`), and control-flow keywords (`if`, `while`) are excluded. Functions with destructured or rest parameters never flag. Toggle with `sidecar.readmeSync.enabled` (default on).
- **Completion gate** — deterministic barrier that fires when the agent tries to terminate a turn without having run lint or tests for the files it edited. Tracks every `write_file` / `edit_file` call against every `run_tests` / `eslint` / `tsc` / `vitest` / `jest` / `pytest` invocation during the turn. At the natural termination point, if any edited source file has a colocated test file that wasn't exercised, or if lint never ran, the gate injects a synthetic user message demanding verification before the turn can end. Capped at 2 injections per turn to prevent loops — after exhaustion the loop terminates with a warning rather than hanging. Catches the failure mode where the model reports a change as "ready for use" without ever running the checks it claims pass. Toggle with `sidecar.completionGate.enabled` (default on).
- **Smart "continue" interpretation** — terse chat replies like `continue`, `go on`, `keep going`, `proceed`, `resume`, `next`, `more` are now rewritten into a directive that tells the model to pick up from its most recent response, skipping completed steps. Matches the existing `pendingQuestion` short-reply pattern. Skipped when there's no prior assistant message or when `pendingQuestion` is already active.

### Changed

- **Cycle detection loosened for length-1 patterns.** Requires 4 consecutive identical tool calls to trip, up from 2, so agents can legitimately re-run a tool to verify after edits or retry tests after fixes without getting cut off. Length 2..4 cycle detection is unchanged (two full cycles still bails out, since A,B,A,B is a much clearer loop signal).

### Stats
- 1459 total tests (97 test files, 194 new since v0.45.0)
- 22 built-in tools, 8 skills

## [0.45.0] - 2026-04-11

### Added
- **Terminal error interception** — SideCar watches the integrated terminal via `onDidStartTerminalShellExecution` / `onDidEndTerminalShellExecution`. On a non-zero exit it captures the command line, exit code, working directory, and ANSI-stripped tail of the output, then offers a **Diagnose in chat** notification that synthesizes a prompt and runs the agent against the failure. Dedupes identical commands within a 30s cooldown, skips SideCar's own terminal, and silently no-ops when shell integration isn't available. Toggle with `sidecar.terminalErrorInterception` (default on).
- **Reasoning timeline** — agent reasoning is now segmented into discrete steps. Each thinking block closes out when a tool call starts, so consecutive reasoning/tool-call cycles render as separate numbered segments (purple pills for reasoning, blue for tools) with per-step duration badges.
- **Customizable chat UI themes** — three new live-updating settings: `sidecar.chatDensity` (compact/normal/comfortable), `sidecar.chatFontSize` (10–22), and `sidecar.chatAccentColor`. Applied as CSS custom properties via a new `uiSettings` message and re-pushed when settings change — no reload required. Accent color values pass through an allowlist validator (hex, `rgb(a)`, `hsl(a)`, small named-color set) so settings strings can't smuggle other CSS properties.
- **Message list virtualization** — long chat sessions (200+ messages) now detach the inner DOM of offscreen text messages via two `IntersectionObserver` instances, preserving pixel height via inline style. Messages rehydrate from stored raw markdown when scrolled back into view. Rich widgets (audit cards, diffs, mermaid diagrams, confirmation panels) stay fully mounted.

### Fixed
- **Streaming tool-call interception** — qwen3-coder and other models that emit `<function=name><parameter=...>...</parameter></function>` or `<tool_call>{...}</tool_call>` in plain text no longer leak the raw XML into the chat bubble. A new streaming parser in `streamUtils.ts` normalizes these at the Ollama and OpenAI backend boundaries, emitting structured `tool_use` events instead of `text`. Handles chunk-boundary partial markers, unknown tool names (fall through as text), and unclosed blocks (recovered at stream end). Applies to both `OllamaBackend` and `OpenAIBackend` streams.
- **Incremental markdown finish** — `finishAssistantMessage` no longer wipes the DOM and re-parses the entire message. It now appends only the slice streaming didn't render, preserving code blocks, lists, and headings built during streaming. Removes an O(N) re-parse on every assistant message finish.

### Stats
- 1265 total tests (90 test files, 17 new)
- 22 built-in tools, 8 skills

---

## [0.44.0] - 2026-04-11

### Added
- **Custom agent modes** — define your own modes via `sidecar.customModes` with dedicated system prompts, approval behavior (autonomous/cautious/manual), and per-tool permissions. Custom modes appear in the dropdown alongside the built-in modes.
- **Background agent orchestration** — `/bg <task>` spawns autonomous agents that run independently with their own client and message history. Up to 3 concurrent (configurable via `sidecar.bgMaxConcurrent`), with a collapsible dashboard panel showing status, live output, and stop controls. Completion summaries posted to the main chat.
- **`SideCar: Set API Key (SecretStorage)` command** — interactive password prompt for setting API keys in VS Code SecretStorage. Plaintext values from settings.json auto-migrate on activation.
- **Self-knowledge prompt rule** — system prompt now includes Rule 0 telling the model to answer identity questions (version, name, project root) directly from the prompt instead of reading package.json.

### Security
- **API keys moved to SecretStorage** — `sidecar.apiKey` and `sidecar.fallbackApiKey` are now stored in VS Code's SecretStorage (OS keychain). Plaintext values are migrated automatically on first activation. Settings sync no longer pushes keys to other devices.

### Fixed
- **5 architecture audit items** — `executeTool` refactored from 10 positional params to an `ExecuteToolOptions` object; MCP tool errors now include server name + tool name + input context; error classifier expanded with `rate_limit` (429), `server_error` (5xx, overloaded), `content_policy`, and `token_limit` types; pre-hook failures now block tool execution (return error tool_result); custom tool registry cached with JSON snapshot key.
- **Cycle detection** — expanded window from 4 to 8, now detects repeating patterns of length 1–4 (catches A,A,A,A and A,B,C,A,B,C, not just A,B,A,B).
- **File content cache invalidation** — file watcher now evicts cached content on change/delete events instead of waiting for the 5-min TTL.
- **Query matching** — new `tokenize()` helper splits camelCase/snake_case/path tokens and matches against query words. "parse util" now scores `parseUtils.ts` higher.
- **Ollama tool call detection** — emit `stopReason: 'tool_use'` whenever tool calls were yielded in a stream, regardless of `done_reason` value (handles `done_reason: 'length'` or omitted).
- **autoFixRetries per-file** — replaced single global counter with `Map<file, retries>` so each file gets its own retry budget.
- **Sub-agent token budget** — sub-agent token usage now counts against the parent's budget via new `onCharsConsumed` callback and `SubAgentResult.charsConsumed` propagation.
- **Timeout timer leak** — `setTimeout` is now cleared in a `finally` block after `Promise.race` so the winning side doesn't leave a timer keeping the event loop alive.
- **Stopped tracking `.sidecar/memory/agent-memories.json`** — runtime LRU state was polluting every commit with thousands of unrelated diff lines.

### Stats
- 1234 total tests (89 test files)
- 22 built-in tools, 8 skills

## [0.43.0] - 2026-04-11

### Added
- **Conversation steering** — chat input stays enabled during agent processing. Send a new message to redirect the agent mid-run, or press Escape to abort. The Send button dynamically switches to "Stop" when the input is empty.
- **`/init` refinements** — confirmation dialog before overwriting existing SIDECAR.md; improved system prompt for higher-quality output (unique value prop, architecture patterns, 120-line cap); entry-point priority sampling with directory diversity; reads CLAUDE.md, AGENTS.md, and copilot-instructions.md if they exist.
- **Model list search** — search/filter input at the top of the model picker panel, auto-focused on open.

### Fixed
- **UX/UI audit** (6 items) — touch targets enlarged (scroll-to-bottom 36px, header buttons 32px min, image remove 24px); spacing normalized to 8pt grid; minimum font size raised from 10px to 11px; panel overlays use relative positioning instead of hardcoded `top: 42px`; close buttons got padding and hover backgrounds.
- **Prompt engineering audit** (7 items) — summarization truncation increased to 200/300 chars with word-boundary-aware `smartTruncate()`; context sections labeled with `## Project Documentation / Agent Memory / Workspace Context` headers; `spawn_agent` description enriched with good/bad examples; `run_command` clarifies `command`/`command_id` mutual exclusivity; inline examples added to `search_files`, `grep`, `run_command`; `enum` constraints on `git_branch` and `git_stash` action params; sub-agent recursion capped at MAX_AGENT_DEPTH=3.

### Stats
- 1234 total tests (89 test files)
- 22 built-in tools, 8 skills

## [0.42.0] - 2026-04-10

### Added
- **Semantic search** — ONNX embedding index using all-MiniLM-L6-v2 (384-dim, ~23MB). File content is embedded and searched by cosine similarity, blended with heuristic scores. Queries like "authentication logic" now find `src/auth/jwt.ts` even without keyword matches.
- **Stub validator** — post-generation scanner detects placeholder patterns (TODO, "real implementation", "for now", pass-only bodies) in agent-written code and auto-reprompts the model to finish the implementation.
- **Streaming diff preview** — file writes in cautious mode open VS Code's diff editor with dual accept/reject UI: notification in the editor + confirmation card in chat. First click wins.
- **Chat log tmp files** — every conversation is logged as JSONL to `$TMPDIR/sidecar-chatlogs/` for debugging and recovery.
- **Structured context rules** — `.sidecarrules` files with glob-pattern matching to prefer, ban, or require files in workspace context.
- **VS Code integration test infrastructure** — `@vscode/test-electron` + `@vscode/test-cli` with 32 integration tests running inside a real VS Code instance.

### Fixed
- **Message persistence** — `serializeContent()` replaces `getContentText()` for session saves, preserving tool_use, tool_result, and thinking blocks. Messages no longer drop when switching chats.
- **Recency bias** — topic-change detection resets workspace file scores when keyword overlap < 15%; agent memory session cap at 2; conversation summarizer keeps 2 recent turns (was 4); pending question threshold tightened to 8 words.
- **Plan mode UI** — accept/reject/revise buttons now attach directly to the streamed assistant message instead of creating a duplicate plan block.

### Changed
- `handleUserMessage` decomposed into `buildBaseSystemPrompt()`, `injectSystemContext()`, `enrichAndPruneMessages()`, `postLoopProcessing()` for maintainability.
- System prompt adds anti-stub rule and topic-focus rule for better model output quality.

### Stats
- 1227 unit tests + 32 integration tests (88 test files, coverage 62.1%)
- 22 built-in tools, 8 skills

## [0.41.0] - 2026-04-10

### Added
- **Agent action audit log** — every tool execution recorded as structured JSONL in `.sidecar/logs/audit.jsonl` with timestamp, tool name, input, result (500 char), duration, iteration, session, model, and approval mode
- **`/audit` command** — browse audit log with filters: `/audit errors`, `/audit tool:grep`, `/audit last:20`, `/audit since:2026-04-01`, `/audit clear`
- **"Why?" button on tool calls** — hover any completed tool card to see a "Why?" button; click for on-demand model explanation of the tool decision (2-3 sentences)
- **`/insights` command** — conversation pattern analysis with tool performance stats, usage distribution chart, common 2-tool sequences, co-occurrence matrix, hourly activity heatmap, error clusters, actionable suggestions, and learned patterns from memory
- **MCP HTTP transport** — connect to remote MCP servers via Streamable HTTP (`type: "http"`)
- **MCP SSE transport** — connect to remote MCP servers via Server-Sent Events (`type: "sse"`)
- **`.mcp.json` project config** — Claude Code-compatible project-scope MCP server definitions, merged with VS Code settings (local overrides shared)
- **MCP per-tool enable/disable** — filter out specific tools per server via `tools: { "tool_name": { enabled: false } }`
- **MCP output size limits** — `maxResultChars` per server (default 50,000) truncates oversized tool results
- **MCP health monitoring** — automatic reconnection with exponential backoff (2s, 5s, 15s) on connection failure
- **MCP environment variable expansion** — `${VAR}` references in HTTP headers resolved from env config + process.env
- **`/mcp` command** — show MCP server connection status, transport type, tool counts, uptime, and errors
- **`mcp-builder` skill** — built-in guide for creating high-quality MCP servers (TypeScript/Python, tool schemas, annotations, evaluation)
- `MetricsCollector.getToolDuration()` — read elapsed time since last `recordToolStart()`
- `AgentMemory.queryAll()` — return all stored memories for analytics/export

### Changed
- `MCPServerConfig` extended with `type`, `url`, `headers`, `tools`, and `maxResultChars` fields
- MCP connection startup now merges configs from VS Code settings and `.mcp.json` in parallel
- MCP `Client` version bumped from `0.4.0` to `0.40.0`
- Extension MCP connection logic refactored to support all three transport types

## [0.40.0] - 2026-04-10

### Added
- **Symbol graph: call site tracking** — indexes which functions call which, with caller file, name, and line number. New `getCallers()`, `getCallsInFile()` query methods
- **Symbol graph: type relationships** — tracks `extends`/`implements` edges for classes and interfaces. New `getSubtypes()`, `getSupertypes()`, `getTypeEdgesInFile()` query methods
- **Symbol context enrichment** — `getSymbolContext()` now includes "Called by", "Extends/implements", and "Subtypes" sections for LLM prompt injection
- **Conversation steering: next-step suggestions** — after the agent loop completes, analyzes tool usage and suggests follow-up actions (e.g. "Run tests to verify the changes") as clickable buttons
- **Conversation steering: progress summaries** — every 5 iterations, emits iteration count, elapsed time, and context usage percentage
- **Conversation steering: checkpoint prompts** — at 60% of max iterations, asks the user whether to continue or stop the task
- **Agent memory: tool chain tracking** — records sequences of tools used together in a session, stores chains of 3+ as `toolchain` memories with deduplication
- **Agent memory: failure learning** — tool failures now recorded as `failure` type memories alongside successes
- **Agent memory: co-occurrence scoring** — `getToolCooccurrences()` and `suggestNextTools()` recommend likely next tools based on past chain history

### Fixed
- Agent memory `recordUse()` now called automatically when `search()` returns results — use counts reflect real retrieval
- Agent memory eviction no longer uses unused `_minUseCount` variable
- Mermaid diagram rendering error (`window.mermaid.initialize is not a function`) caused by ESM-bundled mermaid exporting API under `.default`
- Agent loop auto-compacts before giving up on token budget exceeded (was stopping without attempting compaction)
- Anti-preamble prompt rule promoted to CRITICAL block for stronger model compliance

### Changed
- Symbol graph persistence format bumped to version 2 (includes calls and type edges)
- System prompt anti-repetition instructions moved above numbered rules for higher model attention

## [0.39.0] - 2026-04-10

### Added
- **`ask_user` clarification tool**: LLM can present users with selectable options or custom text input when it needs more context. New `clarify` webview card with option buttons and free-text input
- **Pending question tracking**: when the assistant asks a question in prose, the next short user reply is automatically contextualized as a response
- **Kickstand rebrand**: LLMManager renamed to Kickstand across all source, config, and docs. Provider `kickstand`, CLI `kick`, token path `~/.config/kickstand/token`
- **Dynamic tool support probing**: replaced static deny list with live `/api/show` capabilities query. Cached per-session with runtime failure backstop
- **Version bump automation**: `npm run bump 0.X.0 "summary"` auto-updates package.json, CHANGELOG, ROADMAP, README, docs, and landing page stats

### Security
- Path traversal validation on `@file:` and `@folder:` references
- Default `confirmFn` changed from auto-approve to deny
- Workspace trust warnings for tool permissions and MCP server configs
- SVG sanitizer replaced with DOMParser + allowlist (was regex-based)
- Event hook env vars sanitized for control characters
- Background command limit (10 concurrent) with auto-cleanup
- CSP `connect-src` tightened to specific Ollama/Kickstand ports

### Performance
- Provider reachability timeout 5s → 1.5s
- Streaming text batched at 50ms intervals (~60% fewer postMessage calls)
- `scrollToBottom` throttled to `requestAnimationFrame`
- RAG/memory search skipped when system prompt budget 90%+ full
- Model tool probe batch size 5 → 15
- Token estimation standardized to `CHARS_PER_TOKEN = 4` (was inconsistent 3.5 vs 4)

### Fixed
- Mermaid diagrams: sanitizer now allows `<style>` tags, `securityLevel` set to `loose`, added error logging
- Provider reachability missing `kickstand` case
- Install-time tool check was using empty runtime data instead of static list

### Refactored
- Extracted `workspaceTrust.ts`, `providerReachability.ts`, `constants.ts` — eliminated 3 duplicated patterns
- Path validation and display name helpers extracted

### Stats
- 879 total tests (66 test files)
- 22 built-in tools, 7 skills

## [0.38.0] - 2026-04-09

### Added
- **Retrieval-Augmented Generation (RAG)**: automatic discovery and keyword-based indexing of README, docs/, wiki/ folders. Relevant documentation sections injected into system prompt for every message. Configurable max entries per query and auto-refresh interval
- **Large file & monorepo handling**: streaming file reader with head+tail summary mode for files >50KB threshold. Lazy indexing for slow/large directories with progress tracking. Depth-limited traversal to prevent context bloat. Multi-root workspace support via `sidecar.workspaceRoots` setting. Configurable file size and traversal depth limits
- **Agent memory (persistent learning)**: JSON-based memory storage in `.sidecar/memory/agent-memories.json`. Tracks patterns (successful tool uses), decisions, and conventions with use-count/relevance scoring. Per-message search and context injection. Automatic recording during agent runs. LRU eviction when limit is reached (default 500 entries)
- **Configuration**: 8 new settings: `enableDocumentationRAG`, `ragMaxDocEntries`, `ragUpdateIntervalMinutes`, `enableAgentMemory`, `agentMemoryMaxEntries`, `fileSizeThreshold`, `maxTraversalDepth`, `workspaceRoots`

### Tests
- **Comprehensive executor tests**: expanded test coverage for tools.ts executor implementations with 115 focused tests covering file I/O, error handling, and tool execution flows. Coverage improved from 26.34% to 64.58%
- **RAG & memory tests**: 21 new tests for DocumentationIndexer and AgentMemory with persistence validation
- 871 total tests (up from 848)

## [0.37.0] - 2026-04-09

### Added
- **Streaming diff preview**: live diff editor for file changes in cautious mode with session-based Accept/Reject flow via inline confirmation cards
- **Plan mode**: `/plan` command toggles plan-first execution. Agent generates a structured plan (numbered steps, risks, scope) before touching files. Execute, Revise, or Reject buttons on plan output
- **Context compaction button**: `/compact` command and ✂ header button to manually trigger conversation summarization and free tokens on demand
- **Message copy button**: every message gets a copy button (⎘) that copies raw markdown to clipboard, not rendered HTML
- **Attach menu with skills browser**: 📎 button now opens a context menu showing "Attach File" plus all available skills with descriptions
- **Skills autocomplete**: loaded skills appear in the slash command autocomplete dropdown as you type
- **7 built-in skills**: create-skill, review-code, explain-code, refactor, debug, write-tests, break-this — ship with the extension, overridable by user/project skills
- **Persistent codebase indexing**: workspace file index cached to `.sidecar/cache/workspace-index.json` for near-instant startup on subsequent activations
- **`.sidecarignore` support**: custom exclude patterns (gitignore-style) merged with built-in defaults for workspace indexing
- **`/revise` command**: inline plan revision via chat input instead of `window.prompt()` dialog

### Changed
- **Attach button**: changed from single-action file picker to context menu with file attach + skills browser
- **Plan revision UX**: Revise button focuses chat input with `/revise ` prefix instead of `window.prompt()`
- **README**: updated competitive comparison with two tables (vs. Local Extensions, vs. Pro Tools) reflecting all v0.36.0+ features

### Tests
- 506 total tests (maintained)

## [0.36.0] - 2026-04-09

### Added
- **Tree-sitter AST parsing**: proper syntax-aware code analysis for TypeScript, TSX, JavaScript, Python, Rust, and Go via `web-tree-sitter` WASM runtime. Replaces regex-based parsing with accurate scope analysis, nested structure support, and syntax-aware element extraction. Falls back to regex parser if WASM loading fails
- **Built-in web search**: `web_search` tool lets the agent search the internet via DuckDuckGo (no API key needed). Returns up to 8 results with titles, URLs, and snippets. Checks internet connectivity on first use with clear offline warning
- **CodeAnalyzer abstraction**: new `CodeAnalyzer` interface with registry that dispatches to tree-sitter or regex analyzer per language. Consumers (`workspaceIndex`, `symbolIndexer`, `context`) use the registry transparently
- **SSRF protection**: URL fetching now blocks private/reserved IP ranges (10.x, 172.16-31.x, 192.168.x, 169.254.x, localhost) to prevent server-side request forgery
- **Anthropic output capacity**: `max_tokens` raised from 4096 to 8192, unlocking full Claude output capacity

### Fixed
- **OpenAI tool call ID collision**: replaced `Date.now()` with monotonic counter to prevent ID collisions when multiple tool calls flush in the same millisecond
- **edit_file search description**: now specifies uniqueness requirement and first-match-only behavior to prevent silent wrong-location edits

### Tests
- 506 total tests (maintained)

## [0.35.0] - 2026-04-09

### Security
- **readFile path traversal fix**: `read_file` tool now validates paths with `validateFilePath()`, blocking `../` traversal and absolute paths. Previously only `write_file` and `edit_file` had this protection
- **Sensitive file blocklist**: files matching `.env`, `.pem`, `.key`, `credentials.json`, `secrets.yaml`, and 12 other patterns are blocked from being read into LLM context
- **Workspace hook warning**: hooks defined in workspace-level `.vscode/settings.json` now trigger a one-time trust prompt before executing, protecting against supply-chain attacks via malicious repositories
- **Prompt injection sandbox**: SIDECAR.md, user system prompts, and skill content are now wrapped with a boundary instruction stating they cannot override core safety rules or tool approval requirements

### Fixed
- **Local model tool reliability**: system prompt for local models now includes a 4-step few-shot example (read → edit → diagnostics → fix), significantly improving tool call reliability for Ollama users
- **MCPManager process leak**: MCP manager now added to `context.subscriptions` so child processes are properly cleaned up on extension deactivate
- **Conversation summary API rejection**: summary insertion now includes an assistant acknowledgment message after the summary, preventing consecutive user messages that Anthropic API rejects
- **Sub-agent system prompt corruption**: sub-agents now save and restore the parent's system prompt in a `finally` block, with a dedicated sub-agent role instruction
- **Concurrent agent message race**: aborting a previous agent run now bumps `chatGeneration`, so the stale run's post-loop merge is discarded instead of corrupting `state.messages`
- **Mermaid diagram rendering hang**: diagrams no longer render twice (dedup guard), mermaid.js preloads when ```` ```mermaid ```` fence opens, detached containers skip rendering

### Accessibility
- **Keyboard navigation**: global `:focus-visible` outline style for all interactive elements
- **Model picker button**: changed from `<span>` to semantic `<button>` with `aria-haspopup`, `aria-expanded`, and `aria-label`
- **ARIA roles**: model panel and sessions panel (`role="dialog"`), messages container (`role="log"` with `aria-live="polite"`), slash autocomplete (`role="listbox"`), agent mode select (`aria-label`)
- **Light theme support**: hardcoded `rgba(255,255,255,0.1)` hover states and edit block colors replaced with VS Code theme variables (`--vscode-toolbar-hoverBackground`, `--vscode-diffEditor-*`)

### Tests
- 506 total tests (maintained)

## [0.34.0] - 2026-04-09

### Added
- **Spending budgets**: new `sidecar.dailyBudget` and `sidecar.weeklyBudget` settings (USD). Agent runs are blocked when the limit is reached, with a warning at 80% usage. Completes the cost tracking & budgets roadmap item
- **Per-run cost tracking**: each agent run now records its estimated cost in metrics history. `/usage` dashboard shows per-run cost column and a new Budget Status section with spent/limit/remaining
- **Kickstand provider support**: `kickstand` added as an explicit provider option alongside ollama/anthropic/openai
- **Dual-backend model discovery**: new `SideCar: Discover Available Models` command and startup discovery that probes both Ollama and Kickstand for available models. Respects configured base URLs instead of hardcoded ports
- **Streaming diff preview types**: added `StreamingDiffPreviewFn`, `EditBlock`, and `ProposedContentProvider` type infrastructure for upcoming streaming diff feature

### Fixed
- **Token compaction not triggering**: agent loop `totalChars` was initialized to 0 instead of summing existing conversation history, so the 70% compression threshold never fired for accumulated context
- **Pruned messages re-added**: after `pruneHistory` reduced the message array, the post-loop merge used the pruned length to slice `state.messages`, re-adding the very messages that pruning had removed
- **Model discovery hardcoded ports**: `discoverAllAvailableModels()` now accepts configurable URLs for both Ollama and Kickstand instead of hardcoding `localhost:11434` and `localhost:11435`
- **Unnecessary startup discovery**: model discovery on activation now only runs when the detected provider is `ollama` or `kickstand`, avoiding two 2-second timeout fetches for Anthropic/OpenAI users
- **TypeScript type errors**: added missing imports for `EditBlock`, `ProposedContentProvider` in executor.ts and `StreamingDiffPreviewFn` in loop.ts — zero type errors now

### Changed
- **`vsce` packaging**: `package` script now uses `npx @vscode/vsce package` instead of bare `vsce`

### Tests
- 506 total tests (up from 465)

## [0.33.0] - 2026-04-09

### Documentation
- **Roadmap cleanup**: marked 7 previously-completed features as COMPLETED with version numbers (Context pinning v0.27.0, Web page context v0.21.0, Onboarding walkthrough v0.22.0, Auto-fix on failure v0.20.0, and 3 others as PARTIALLY COMPLETED)
- **Expanded roadmap**: added 8 new planned feature categories:
  - Tool Discovery & Management: tool registries, versioning, dynamic loading
  - Security & Permissions: granular controls, sandboxing, audit logging
  - Advanced Agent Capabilities: multi-agent collaboration, planning, memory management
  - Integration & Provider Support: enhanced MCP, VS Code API, multi-provider optimization
  - Performance Optimizations: result caching, efficient context, parallel execution
  - User Experience Improvements: reasoning visualization, error handling, config management
  - Integration Improvements: CI/CD, project management tools, debugging, collaboration
  - Enterprise & Team: configuration sharing, privacy guarantees

### Tests
- 465 total tests (maintained)

## [0.32.0] - 2026-04-08

### Added
- **`display_diagram` tool**: agent can extract and display diagrams from markdown files, preserving the original diagram type (mermaid, graphviz, plantuml, dot)
- **`sidecar.contextLimit` setting**: user-configurable context token limit for local models (0 = auto-detect with 16K default cap). Increase if you have enough VRAM for longer conversations
- **Adaptive context pruning**: conversation history is now compressed even within a single turn when over budget — the latest turn's tool results and text are progressively truncated instead of blowing past the context window
- **Ollama `num_ctx` detection**: reads the actual runtime `num_ctx` from Ollama's model parameters instead of only trusting the model's advertised (often inflated) context length

### Fixed
- **Context overflow on small models**: local model context cap raised from 8K to 16K tokens; pruning budget floor now scales with context window instead of fixed 20K char minimum that prevented pruning on small models
- **Token warning undercounting**: context overflow warning now includes the system prompt in its estimate, not just conversation history
- **SVG XSS hardening**: mermaid diagram output is now sanitized (script tags, event handlers, style tags stripped) before innerHTML injection
- **File path hallucination guard**: `write_file`, `edit_file`, and `display_diagram` now validate paths — rejects backticks, control characters, excessive length, path traversal, and absolute paths
- **Duplicate tool registration**: `display_diagram` was registered twice in the tool definitions list
- **Co-author trailer**: commits now tag the SideCarAI-Bot GitHub account (`274544454+SideCarAI-Bot@users.noreply.github.com`) so SideCar appears as a contributor

### Changed
- **`agentMaxIterations` default**: increased from 25 to 50 to support longer agentic sessions

### Tests
- 465 total tests (up from 464)
- New test: `pruneHistory` compresses latest turn when over budget after dropping old turns

## [0.31.0] - 2026-04-08

### Added
- **Mermaid diagram rendering**: models can now generate diagrams in markdown mermaid code blocks. Chat displays diagrams natively with syntax highlighting, diagram source collapsible view, and copy-to-clipboard for SVG output. Lazy-loads mermaid.js on first diagram to minimize bundle size impact
- **Diagram block styling**: dedicated CSS for diagram containers with theme-aware background, border, and padding. Header shows "Diagram" label with Copy SVG button

### Tests
- 464 total tests (maintained)

## [0.30.1] - 2026-04-08

### Added
- **Configurable message ceiling**: new `sidecar.agentMaxMessages` setting (default 25, range 5-100) lets users tune message limit before agent wraps up. Agent loop now tracks and reports remaining message capacity each iteration
- **Backend fallback unit tests**: 2 new tests verifying consecutive failure counting and counter reset behavior
- **Dual-stage context compression**: conversation summarization + semantic tool result extraction for extended agent loops (30+ iterations vs 18-20 previously)

### Fixed
- **Model action button memory leak**: model list buttons now use event delegation instead of per-button listeners capturing model objects
- **Image upload preview button leak**: image remove buttons now use event delegation instead of capturing loop variable in closure
- **GitHub Pages styling**: corrected Jekyll CSS path from absolute to relative so `relative_url` filter properly applies `/sidecar` baseurl
- **Marketplace messaging**: clarified that SideCar is an autonomous AI agent, not just a chat client — updated README tagline and package.json description

### Tests
- 464 total tests (up from 462)

## [0.30.0] - 2026-04-08

### Added
- **Kickstand backend support**: connect to Kickstand inference server on `http://localhost:11435` with automatic token loading from `~/.config/kickstand/token`. Full streaming, tool use, and fallback support
- **Claude Code skill compatibility**: load and use existing Claude Code skills directly — no format conversion needed. Scans `~/.claude/commands/`, `<workspace>/.claude/commands/`, and `.sidecar/skills/` for markdown skill files. Trigger via `/skill-name` slash command or automatic keyword matching. New `/skills` command lists all loaded skills
- **Backend fallback**: configure a secondary provider via `sidecar.fallbackBaseUrl`, `sidecar.fallbackApiKey`, `sidecar.fallbackModel`. After 2 consecutive failures on the primary, SideCar auto-switches to fallback with a warning. Switches back on success
- **Docs redesign CSS**: extracted design system stylesheet for the docs site (coral/blue/purple palette, code blocks, callouts, mode grid, nav cards)
- **Redesigned landing page**: new standalone landing page with terminal mockup, feature comparison table, stat strip, and quickstart guide

### Fixed
- **Code block button memory leak**: Run/Save/Copy buttons now use event delegation with `data-action` attributes instead of per-button listeners that captured code in closures
- **Repetitive model responses**: added anti-repetition rules to system prompts ("NEVER repeat information", "no lists unless asked", "only add new info after tool calls")
- **Marketplace publish blocking releases**: publish step now uses `continue-on-error` so re-runs can create the GitHub Release even if the VSIX was already published

### Performance
- **parseThinkTags**: index tracking instead of string slicing — eliminates intermediate string allocations
- **parseTextToolCalls**: consolidated 3 sequential regex passes into single combined regex with priority tracking
- **OpenAI backend stream tests**: 6 new tests for SSE parsing, malformed JSON, partial chunks, think tags, error responses

### Tests
- 403 total tests

## [0.29.0] - 2026-04-08

### Added
- **`.sidecar/` project directory**: persistent project storage for cache, logs, sessions, plans, memory, and scratchpad. Auto-generates `.gitignore` for ephemeral subdirs. `SIDECAR.md` is now loaded from `.sidecar/SIDECAR.md` first with fallback to root
- **Agent loop cycle detection**: tracks the last 4 tool call signatures and halts if the model repeats the same call consecutively — prevents infinite loops
- **`sidecar.agentTemperature` setting**: task-specific temperature (default 0.2) applied when tools are present. Lower values produce more deterministic tool selection across all three backends
- **Tool support auto-detection**: runtime tracking of models that fail to use tools. After 3 consecutive failures, tool definitions are no longer sent — saves context and avoids empty responses
- **Smart context for multi-language files**: AST-based extraction now supports Python (`def`/`class`), Rust (`fn`), Go (`func`), Java/Kotlin methods with full body capture via brace/indent tracking
- **`enhanceContextWithSmartElements`**: post-processing pass for glob-based context that applies AST extraction to code files before injection
- **GitHub Actions workflows**: bot-powered GitHub Releases with VSIX artifacts, issue auto-labeling by keywords (12 labels), and PR test result comments — all via SideCarAI-Bot
- **Support & Contact section**: email (sidecarai.vscode@gmail.com) and links in README and package.json

### Fixed
- **Typing indicator persists after response**: `showTypingIndicator()` now removes any existing indicator before creating a new one; `setLoading: false` sent in `finally` block as safety net
- **Resource leaks on extension deactivate**: dispose `sidecarMdWatcher` file watchers, abort running agent loops, clear pending confirmations, shell session SIGTERM → SIGKILL with 3s timeout
- **Inconsistent error messages**: all three backends now prefix errors with service name (Ollama/OpenAI/Anthropic) and use consistent `request failed: {status} {statusText}` format
- **Error classification gaps**: added ENOTFOUND, EADDRNOTAVAIL, EHOSTUNREACH, ECONNRESET to connection error patterns
- **Smart context bugs**: regex `\Z` → `$` (invalid JS), strip code fences before AST parsing, deduplicate identical branches, copy elements instead of mutating scores
- **Dead code**: removed unused `SmartWorkspaceIndex` stub and its imports

### Changed
- **System prompts restructured**: numbered rules for clearer instruction following; positive instructions ("Read files before editing") instead of negative; multi-step task guidance for cloud models
- **Context injection reordered**: pinned files and relevant content come before the workspace tree — high-value context gets priority in limited context windows. Tree is appended last and truncated if budget is tight
- **Race condition fix**: abort previous agent run BEFORE pushing new user message to prevent concurrent reads/writes on the messages array
- **Config validation**: `clampMin()` helper validates all numeric settings; empty model/URL fall back to defaults

### Performance
- **`parseFileContent` language branching**: detect language once, test only relevant regex patterns per line — O(L×P) → O(L×1)
- **Partial sort in `getRelevantContext`**: filter relevant files first, sort only those instead of full O(n log n) sort
- **Pre-built pinned file Set**: O(1) lookups instead of O(p×f) filter per pinned path
- **`pruneHistory` incremental tracking**: compute chars incrementally and flatten once at end instead of O(m²) repeated `.flat()` calls
- **Shared backend utilities**: `parseThinkTags()` and `toFunctionTools()` extracted into `streamUtils.ts`, removing ~80 lines of duplication
- **Scroll handler debounce**: `requestAnimationFrame` with cached element reference instead of raw scroll event
- **O(1) message delete**: `data-msg-index` attribute instead of O(n) `querySelectorAll` + `indexOf`
- **Workspace excludes**: added `coverage/`, `build/`, `.turbo`, `.cache` to prevent generated files in context

### Tests
- 397 total tests (370 → 397)
- New: streamUtils (parseThinkTags, toFunctionTools), config validation (clampMin), agent loop (timeout, normal completion, empty response), pruneHistory aliasing regression, Ollama backend stream errors (malformed JSON, partial chunks, cross-chunk think tags, empty body, unclosed think tags)

## [0.28.1] - 2026-04-07

### Fixed
- **User message dropped by history pruning**: `pruneHistory()` returns the same array reference when short-circuiting (≤2 messages), so the subsequent `chatMessages.length = 0; chatMessages.push(...prunedMessages)` cleared both arrays — silently dropping the user's message. The model received only a system prompt with no question, returning empty content. Fixed by copying the pruned array before clearing
- **Workspace context exceeding model capacity**: the workspace index injected up to 20K chars of file content into the system prompt regardless of the model's context window, causing local models to return empty responses or extreme latency. Added a context cap for local models (8K tokens) and tool overhead reservation (10K chars) to keep total prompt size manageable
- **No request timeout**: agent loop requests had no timeout — if the model hung (loading, oversized prompt, connection stall), SideCar would wait forever. Added per-request timeout using `Promise.race` on each stream event, defaulting to 120 seconds

### Added
- **`sidecar.requestTimeout` setting**: configurable timeout in seconds for each LLM request (default: 120). If no tokens arrive within this window, the request is aborted with a user-friendly message. Set to 0 to disable
- **`abortableRead` stream helper**: races `reader.read()` against the abort signal so stream body reading can be cancelled — `fetch` only controls the initial request, not ongoing body reads

### Changed
- **Local model context cap**: local models now cap at 8K tokens for context budget calculations instead of trusting the model's advertised context length (e.g. qwen3-coder reports 262K but Ollama's actual `num_ctx` is much smaller)
- **Workspace context budget enforcement**: indexed and glob-based workspace context is now truncated to the remaining system prompt budget, preventing it from exceeding `maxSystemChars`

## [0.28.0] - 2026-04-07

### Added
- **OpenAI-compatible API backend**: works with any server exposing `/v1/chat/completions` — LM Studio, vLLM, llama.cpp, text-generation-webui, OpenRouter, and more. SSE streaming, incremental tool call accumulation, `<think>` tag parsing, and `/v1/models` listing. Set `sidecar.baseUrl` to your server and SideCar auto-detects the protocol
- **`sidecar.provider` setting**: explicit provider selection (`auto`, `ollama`, `anthropic`, `openai`) when auto-detection doesn't match your setup
- **Context pinning**: `@pin:path` syntax in chat and `sidecar.pinnedContext` array setting to always include specific files or folders in context regardless of relevance scoring. Supports folder pinning (includes all files under the prefix)
- **Auto-fix on failure**: `sidecar.autoFixOnFailure` checks VS Code diagnostics after agent writes/edits and feeds errors back to the model for self-correction, up to `sidecar.autoFixMaxRetries` attempts
- **Web page context**: paste a URL in chat and SideCar auto-fetches the page, strips HTML, and includes readable content in context. Configurable via `sidecar.fetchUrlContext`. Max 3 URLs per message, 5000 chars per page
- **Onboarding walkthrough**: first-run "Welcome to SideCar" card with feature overview and "Got it" dismiss. Stored in globalState, never shows again after dismissal
- **Reconnect button**: error card shows "Reconnect" with auto-retry (3 attempts with 2s/4s/8s backoff) before prompting. On success, automatically resends the last user message
- **Typing status line**: descriptive status below bouncing dots — "Connecting to model...", "Building context...", "Sending to model...", "Reasoning...", "Running tool: X...", "Agent step N/M..."
- **Wall-clock timer**: elapsed time counter on the typing indicator so users know SideCar isn't stuck
- **Verbose log blocks collapsed**: system prompt and verbose logs now render collapsed by default instead of expanded
- **Troubleshooting docs**: "Slow model loading" section with macOS Launch Agent setup instructions for pre-warming models at startup

### Changed
- **Three-way backend dispatch**: `SideCarClient.createBackend()` now uses `detectProvider()` with Ollama, Anthropic, and OpenAI backends instead of a binary Ollama/Anthropic check. Non-Ollama, non-Anthropic URLs now default to OpenAI-compatible instead of Anthropic
- **Reachability checks**: both `chatHandlers` and `modelHandlers` use provider-aware endpoint checks (`/api/tags` for Ollama, base URL for Anthropic, `/v1/models` for OpenAI)
- **Model listing**: `listInstalledModels()` uses `GET /v1/models` for OpenAI backends; `listLibraryModels()` skips Ollama library suggestions for non-Ollama providers

### Tests
- 370 total tests (287 → 370)
- New test files: metrics, logger, debounce, parser, apply, git, workspace
- Updated: settings (provider, isAnthropic, detectProvider), workspaceIndex (pinning)
- VS Code mock expanded: Position, Range, WorkspaceEdit, StatusBarAlignment

## [0.27.0] - 2026-04-07

### Added
- **Model pre-warm**: on activation, SideCar sends an empty request to Ollama to load the configured model into memory, eliminating the cold-start delay on the first chat message
- **Typing status line**: the typing indicator now shows a descriptive status below the bouncing dots — "Connecting to model...", "Reasoning...", "Generating response...", "Running tool: Read File...", "Agent step 2/10...", etc.
- **Version and links in system prompt**: SideCar now tells the model its own version, GitHub repo URL, and documentation URL so it can answer user questions about itself
- **Roadmap additions**: large file & monorepo handling, agent action audit log, extension/plugin API, agent run debugger/replay

### Fixed
- **Scroll truncation**: added `min-height: 0` to the messages container to fix a flexbox bug where the scrollbar was cut off when scrolling up
- **Streaming renderer stale state**: `startAssistantMessage` now resets `lastRenderedLen`, `renderTimer`, and `streamingSpan` to prevent stale state from a previous message or error breaking the next render
- **Invalid HTML in streaming span**: changed the streaming container from `<span>` to `<div>` — block elements (`<h3>`, `<p>`, `<ol>`) inside inline elements caused browser rendering quirks
- **Error handler cleanup**: the error handler now properly resets all streaming state (`lastRenderedLen`, `renderTimer`, `streamingSpan`) to prevent cascading render failures
- **Markdown post-processing**: added a DOM post-processing pass that catches un-rendered `**bold**` and `` `code` `` in text nodes using simple string splitting as an independent fallback
- **Silent render failures**: `finishAssistantMessage` is now wrapped in try-catch with a plaintext fallback so rendering errors don't silently lose message content

### Changed
- **Assistant message CSS**: `.message.assistant` now uses `white-space: normal` instead of inheriting `pre-wrap` from `.message`, since the markdown renderer handles line breaks via DOM elements. Block elements inside messages get explicit `white-space: normal` and `display: block`
- **Explicit inline markdown styles**: added CSS rules for `.message strong`, `.message em`, `.message del` to ensure bold, italic, and strikethrough render visibly regardless of inherited styles
- **Docs site redesign**: new custom CSS theme matching the SideCar logo gradient palette (coral → peach → sky blue → steel blue), animated hero section with floating logo, feature card grid, and themed tables/code blocks/nav

## [0.26.0] - 2026-04-07

### Fixed
- **Parallel tool call matching**: tool calls executed in parallel (e.g., multiple file reads) now correctly match results to their originating call via unique IDs. Previously a singleton `active-tool` element caused race conditions — results updated the wrong tool or created duplicate entries
- **Markdown rendering during streaming**: pending (in-progress) text now renders with full markdown (bold, lists, headings) instead of raw `textContent`. Numbered and bullet lists separated by blank lines are now parsed as a single list with multi-line item support

### Performance
- **Incremental DOM rendering**: streaming no longer clears `innerHTML` on every 80ms tick. Only the new slice of safe content is appended, reducing render cost from O(total_content) to O(new_chunk)
- **Message history memory bounds**: in-memory history capped at 200 messages / 2MB. Prevents unbounded memory growth in long agent sessions
- **Search result limits**: `grep` and `search_files` results bumped from 50 to 200, so the agent discovers more context in large codebases
- **stripRepeatedContent O(n) rewrite**: replaced nested-loop paragraph matching with a hash set for O(1) lookups instead of O(n²) scanning
- **Dispatch handler map**: converted 41-case `switch` statement to an object map for O(1) command lookup
- **Token estimation**: improved from `chars / 4` to `chars / 3.5` for more accurate budget tracking; removed unnecessary `JSON.stringify` allocations in tool call and content length sizing
- **Config caching**: `getConfig()` now caches results and invalidates only on `workspace.onDidChangeConfiguration`, eliminating 30+ redundant VS Code config reads per message cycle
- **DOM batching**: session list and diff rendering now build in `DocumentFragment` before a single append; session list uses event delegation instead of per-item listeners
- **Workspace indexing progress**: status bar shows spinning indicator during workspace scan, then file count on completion

## [0.25.0] - 2026-04-07

### Added
- **Persistent shell session**: `run_command` and `run_tests` now use a long-lived shell process. Environment variables, working directory, and shell state persist between commands — just like a real terminal. Supports configurable timeouts (`sidecar.shellTimeout`, default 120s), background commands (`background: true` + `command_id` to check later), and up to 10MB output (`sidecar.shellMaxOutputMB`)
- **Streaming tool output**: shell command output streams to the UI in real-time as it arrives, instead of waiting for the command to finish. The active tool call card auto-opens and shows live output
- **Between-turn context pruning**: conversation history is now automatically compressed before each agent turn. Older turns get progressively heavier compression (tool results truncated, thinking blocks stripped, text summarized). Prevents local models from choking on accumulated context from prior turns
- **Clean tool display**: tool calls now show as `📖 Read src/foo.ts` with icons and spinners instead of raw `read_file(path: src/foo.ts)`. Successful results fold into the tool call card; errors show separately. Matches the polish of Claude Code and Copilot
- **Streaming markdown renderer**: replaced the per-token full re-render with boundary-aware incremental rendering. Only completed markdown blocks are rendered; in-progress text shows with a blinking cursor. Renders debounced at 80ms to reduce DOM thrashing
- **Compact system prompt for local models**: local Ollama models get a ~60% shorter system prompt, saving precious context window for conversation and tool results

### Fixed
- **`getRootUri()` null crash**: now throws a clear error when no workspace folder is open instead of crashing with a null reference
- **`Promise.all` tool execution crash**: one tool failure no longer aborts all parallel tool executions. Uses `Promise.allSettled` and converts rejected promises into error tool results
- **Grep command injection**: user-provided search patterns were interpolated into a shell string. Now uses `execFile` with an args array to prevent shell metacharacter injection
- **MCP async dispose**: `dispose()` was dropping the async `disconnect()` promise. Now catches and logs errors
- **File watcher thrashing**: rapid file creation/deletion triggered `rebuildTree()` on every event. Now debounced to 300ms
- **Unbounded retry backoff**: exponential backoff had no ceiling. Added `maxDelayMs` (default 30s) to cap delay between retries
- **Within-loop compression too conservative**: old `compressMessages()` used a flat 100-char truncation. Now uses distance-based tiers (1000 chars for recent, 200 chars for old) and drops old thinking blocks

### Changed
- `run_command` tool description updated to document persistent session, timeout, and background parameters
- `ToolExecutor` interface now accepts optional `ToolExecutorContext` for streaming callbacks and abort signals
- Agent loop `onToolOutput` callback added to `AgentCallbacks` for streaming tool output to the UI

## [0.24.2] - 2026-04-07

### Added
- **LimitedCache utility**: TTL-based cache with size limits for workspace and AST caches, replacing unbounded `Map` instances that could grow without limit

### Fixed
- **Block markdown infinite loop**: lines with `\r\n` endings caused `appendBlockMarkdown` to loop forever — heading regex failed (JS `.` doesn't match `\r`) but the line was still excluded from paragraph collection, so `i` never advanced. Fixed by normalizing `\r\n` → `\n` before parsing and adding a fallback that always advances the line index
- **Unbounded cache growth in workspace index**: file content and parsed AST caches used plain `Map` with no eviction — replaced with `LimitedCache` (100 entries, 5-minute TTL)
- **Unbounded cache in SmartWorkspaceIndex**: parsed file cache had no size or TTL limits — replaced with `LimitedCache` (50 entries, 5-minute TTL)

## [0.24.0] - 2026-04-07

### Added
- **Block-level markdown rendering**: assistant messages now render headings (`#`–`####`), bullet lists, numbered lists, blockquotes, and horizontal rules. Previously only inline markdown (bold, italic, code, links) was supported
- **Smart context selection**: AST-based code element extraction for JS/TS files in workspace context. Parses functions, classes, imports, and exports, scores them by query relevance, and includes targeted code snippets instead of whole files

### Fixed
- **Autonomous mode ignored pending confirmations**: switching to autonomous mode while the agent was blocked on a confirmation prompt left it stuck. Now auto-resolves all pending confirmations and dismisses the UI cards
- **Agent mode setting not persisted before next message**: `agentMode` config update was fire-and-forget (not awaited), so the next `getConfig()` call could read the stale value
- **Duplicate file parsing in workspace index**: JS/TS files were parsed twice per context request — the first pass was dead code from an earlier stub. Removed the duplicate
- **Redundant string split in extractRelevantContent**: `content.split('\n')` was called inside a loop for every element instead of once. Hoisted above the loop

### Changed
- **`expandThinking` setting description**: clarified wording from "expanded by default" to "expanded instead of collapsed" to avoid implying the setting is enabled by default

## [0.23.0] - 2026-04-06

### Added
- **`<think>` tag parsing**: Ollama reasoning models (qwen3, deepseek-r1) now route `<think>...</think>` content to collapsible "Reasoning" blocks instead of showing raw tags
- **Verbose mode** (`sidecar.verboseMode`): shows system prompt, per-iteration summaries, and tool selection context during agent runs
- **`/verbose` slash command**: toggle verbose mode from the chat
- **`/prompt` slash command**: inspect the full assembled system prompt
- **Expand thinking setting** (`sidecar.expandThinking`): show reasoning blocks expanded by default instead of collapsed

### Fixed
- **Agent used tools on every message**: system prompt told the model to always use tools. Now only uses tools when the user asks for an action — questions get direct text responses
- **Lost messages on concurrent runs**: if user sent a message while the agent was running, it was overwritten. Now merges messages and aborts the previous run
- **Token budget exceeded by 30-50%**: tool call names, inputs, and results weren't counted. Now included in budget tracking
- **Context overflow on large projects**: SIDECAR.md and user system prompt are now capped at 50% of model context with truncation warnings
- **Infinite loop on stripped content**: agent loop could spin when `stripRepeatedContent` emptied the response. Now breaks cleanly
- **Metrics not ended on error**: `metricsCollector.endRun()` moved to `finally` block so it always fires
- **System prompt ordering**: constraints ("only use tools when asked") now appear before tool descriptions so models weight them properly
- **Unclosed `<think>` tags**: stream ending mid-think-tag now emits a closing marker
- **stripRepeatedContent false positives**: threshold raised from 100 to 200 chars; code blocks are now excluded from stripping

## [0.22.2] - 2026-04-06

### Fixed
- **CI publish workflow**: added missing build step before marketplace publish

## [0.22.1] - 2026-04-06

### Fixed
- **Repeated content in model output**: automatically strips verbatim blocks (100+ chars) that the model echoes from earlier assistant messages in the conversation history
- **Per-message delete**: hover-visible delete button on each message for manual cleanup of stuck or unwanted messages

## [0.22.0] - 2026-04-06

### Added
- **Multi-file change summary**: after an agent run, a collapsible panel lists all modified files with inline unified diffs, per-file Revert buttons, and an Accept All button
- **Line-based diff engine**: new `src/agent/diff.ts` computes unified diffs (LCS algorithm) with no external dependencies, truncates at 500 lines
- **GitHub Pages documentation site**: comprehensive docs at `docs/` with 12 pages covering getting started, agent mode, configuration, MCP servers, slash commands, security scanning, SIDECAR.md, hooks, inline chat, GitHub integration, and troubleshooting
- **VS Code Marketplace badge**: README links to the published extension
- **GitHub repo homepage**: repo description and homepage URL point to the marketplace listing

### Changed
- **Package name**: `sidecar` renamed to `sidecar-ai` to avoid VS Code Marketplace naming conflict (display name remains "SideCar")
- **Auto-publish workflow**: GitHub Actions workflow publishes to the marketplace on version tags (`v*`)

## [0.21.0] - 2026-04-06

### Added
- **Inline markdown rendering**: assistant messages now render **bold**, *italic*, ~~strikethrough~~, `inline code`, and [links](url) instead of showing raw markdown syntax
- **Competitive comparison in README**: "Why SideCar?" section with feature comparison table vs Continue, Llama Coder, Twinny, and Copilot

### Fixed
- **Raw markdown in chat**: `**bold**` and other inline markdown was displayed as literal text instead of rendered formatting

### Security
- **XSS-safe markdown renderer**: uses DOM node construction (`createElement` + `textContent`) instead of `innerHTML` — no injection vectors
- **Link URL validation**: only `https://` and `http://` links are rendered as clickable; `javascript:`, `data:`, and other dangerous URIs are displayed as plain text

## [0.20.0] - 2026-04-06

### Added
- **Chat-only model support**: models like gemma2, llama2, and mistral that don't support function calling now work gracefully in chat-only mode
- **Tool support detection**: models are automatically classified as "Full Features" (tool-capable) or "Chat-Only" in the model dropdown
- **Model categorization UI**: model list organized into two sections with dedicated headers and tooltips explaining capabilities
- **Chat-only badge**: `ℹ️ Chat-Only` indicator in the header when using a non-tool-capable model, with interactive tooltip listing available tools
- **Tool calling warning**: warning message displayed when attempting to use tools with unsupported models
- **Code block webview rendering**: code blocks are shown in the webview for chat-only models (with Save/Run buttons) while tool-enabled models silently create files

### Changed
- **Tool support status**: OpenAI backend always supports tools; Ollama backend filters unsupported models (gemma, gemma2, llama2, mistral, neural-chat, starling-lm)
- **Stream event handling**: agent loop now handles warning events from streaming backends

## [0.19.1] - 2026-04-06

### Fixed
- **Webview crash on `/commit` command**: resolved crash when receiving `/commit` or error messages in the webview

## [0.19.0] - 2026-04-06

### Added
- **Conversation history panel**: browse, load, and delete saved conversations from a visual panel. Click the hamburger button or type `/sessions` to open. Conversations auto-save after each assistant response, on new chat, and when VS Code closes
- **Git toolset**: 8 dedicated agent tools (`git_status`, `git_stage`, `git_commit`, `git_log`, `git_push`, `git_pull`, `git_branch`, `git_stash`) backed by a unified `GitCLI` class — replaces ad-hoc `run_command` usage for git operations
- **`/commit` slash command**: generates a commit message from the current diff, stages all changes, and commits — all from the chat input
- **SideCar co-author attribution**: commits made by SideCar automatically include a `Co-Authored-By: SideCar` trailer

### Fixed
- **Abort button**: properly interrupts streaming and batch operations. Extension now sends `done`/`setLoading` on abort so the webview finalizes partial responses and cleans up progress indicators
- **Batch abort handling**: `runBatch` wrapped in try/catch to handle `AbortError` gracefully instead of throwing uncaught
- **Duplicate `updateConnection`** method removed from `SideCarClient`

### Changed
- **`get_git_diff` renamed to `git_diff`** for consistency with the new git tool family
- **Git tools consolidated**: agent tools and slash command handlers now share the `GitCLI` class — no more duplicate implementations
- **Auto-save sessions**: conversations persist automatically to global state. Named from the first user message. Updated in place on subsequent saves

## [0.17.0] - 2026-04-05

### Added
- **Automated test generation**: `/test` command generates tests for the active file or selection. Auto-detects framework (Vitest, Jest, pytest, Go test, JUnit) and creates a properly named test file via code block
- **Lint-fix integration**: `/lint` command auto-detects the project's linter (ESLint, Ruff, golangci-lint) from config files and runs it. Optionally pass a custom command: `/lint npx eslint --fix .`
- **Dependency analysis**: `/deps` command analyzes project dependencies — shows counts, lists, checks for unused packages (Node.js), outdated versions, with Python and Go support
- **Code generation templates**: `/scaffold <type>` generates boilerplate for common patterns (component, api, test, model, cli, hook, middleware, service). Run `/scaffold` with no args to see available templates

## [0.16.0] - 2026-04-05

### Added
- **Diff preview before apply**: in cautious mode, `write_file` and `edit_file` open VS Code's built-in diff editor showing proposed changes before writing to disk. User accepts or rejects via inline confirmation card
- **Token usage & cost dashboard**: `/usage` command shows cumulative token consumption, estimated Anthropic API cost, per-run history, and tool usage breakdown
- **Context window visualization**: `/context` command shows what's in the context window — system prompt, SIDECAR.md, workspace files, conversation history — with token counts per section and a visual usage bar

## [0.15.0] - 2026-04-05

### Added
- **Security scanning**: automatic secrets detection and vulnerability scanning on files written/edited by the agent. Detects AWS keys, GitHub tokens, API keys, private keys, JWTs, connection strings, and more. Flags SQL injection, command injection, XSS (innerHTML), eval usage, and insecure HTTP URLs
- **Diagnostics integration**: `get_diagnostics` tool now includes security scan results alongside compiler errors and warnings
- **Pre-commit secrets gate**: `/scan` slash command and `sidecar.scanStaged` command scan staged git files for secrets before committing. Reads the staged version via `git show` and reports findings in a markdown panel
- **27 new tests** (204 total)

## [0.14.0] - 2026-04-05

### Added
- **Prompt caching (Anthropic API)**: stable system prompt prefix (base + SIDECAR.md + user config) marked with `cache_control: { type: 'ephemeral' }` for server-side caching — ~90% input token cost reduction on cache hits
- **Local SIDECAR.md cache**: file content cached in memory with `FileSystemWatcher` invalidation, eliminates redundant reads per message
- **Inline confirmation cards**: tool approvals, file overwrites, command execution, and undo confirmations now render as styled cards in the chat UI instead of system modal pop-ups

## [0.13.0] - 2026-04-05

### Added
- **Slash command autocomplete**: dropdown appears as you type `/` in the chat input, with command descriptions, arrow key navigation, Tab/Enter to select, Escape to dismiss
- **Keyboard shortcuts**: `Cmd+L` / `Ctrl+L` to clear chat, `Cmd+Shift+U` / `Ctrl+Shift+U` to undo changes, `Cmd+Shift+E` / `Ctrl+Shift+E` to export chat
- **Conversation-aware workspace index**: agent file access (read_file, write_file, edit_file) is tracked and used to boost relevance scores — files the agent touches rank higher in subsequent context. Write access boosts more than read. Relevance decays over time so stale accesses fade

## [0.12.0] - 2026-04-05

### Added
- **Stop button**: Send button toggles to red Stop button during processing to abort the agent loop
- **Activity bar**: animated progress bar below header showing SideCar is actively working
- **Tool execution animation**: pulsing indicator on tool calls while they're running
- **Agent mode dropdown**: header badge replaced with a dropdown to switch between cautious/autonomous/manual modes directly from the UI
- **42 new handler tests**: chatHandlers, githubHandlers, sessionHandlers (170 total)

### Changed
- **Settings cleanup**: removed all 18 deprecated individual settings getters, migrated all callers to `getConfig()`
- Stale `[message with images]` entries filtered from persisted history

## [0.11.0] - 2026-04-05

### Added
- **Slash commands**: `/reset`, `/undo`, `/export`, `/model <name>`, `/help` in chat input
- **Agent progress indicators**: step count, elapsed time, and token usage shown during agent runs
- **Actionable error cards**: classified errors (connection, auth, model, timeout) with retry and settings buttons
- **Stop button**: Send button toggles to red Stop button during processing to abort the agent loop
- **Activity bar**: animated progress bar below header showing SideCar is actively working
- **Tool execution animation**: pulsing indicator on tool calls while they're running
- **Workspace indexing**: persistent in-memory file index with relevance scoring, replaces per-message glob scan. Uses `FileSystemWatcher` for incremental updates
- **Agent mode dropdown**: header badge replaced with a dropdown to switch between cautious/autonomous/manual modes directly from the UI
- **70 new tests**: executor, MCP manager, workspace index, chatHandlers, githubHandlers, sessionHandlers (170 total)

### Changed
- **Sticky scroll**: auto-scroll stops when user scrolls up, floating scroll-to-bottom button appears
- **Incremental streaming**: only re-renders full DOM when code blocks change; plain text updates the trailing span
- **Agent progress pulse**: progress bar and tool calls animate to show SideCar is alive during intensive tasks
- **Settings migration**: all callers migrated from 18 deprecated individual getters to consolidated `getConfig()`, deprecated functions removed from `settings.ts`

### Fixed
- Messages with image content showing `[message with images]` placeholder instead of actual text
- Stale `[message with images]` entries in persisted history from pre-v0.11.0 sessions filtered on load
- Removed `@rolldown/binding-darwin-arm64` from production dependencies (platform-specific dev dep)

## [0.10.0] - 2026-04-05

### Added
- **Dual API backend**: local Ollama models now use native `/api/chat` endpoint with NDJSON streaming and native tool calls; Anthropic API uses `/v1/messages` — backend selected automatically based on URL
- **Text tool call fallback**: models that output tool calls as text (`<function=...>`, `<tool_call>`, JSON fences) are parsed and executed automatically
- **Retry with backoff**: API calls retry on 429/5xx with exponential backoff and Retry-After header support
- **Code quality infrastructure**: Vitest (87+ tests), ESLint, Prettier, husky pre-commit hooks, GitHub Actions CI

### Changed
- **Unified file attachment**: paperclip button now handles both files and images (camera button removed)
- **ChatViewProvider refactored**: split from 1,099-line god class into thin dispatcher (210 lines) + 5 handler modules + ChatState
- **Webview JS extracted**: inline script moved from chatWebview.ts (1,120 lines) to external media/chat.js (163-line template remains)
- **Config consolidated**: typed `SideCarConfig` interface with single `getConfig()` accessor
- **Client factory**: `createClient()` replaces 5 duplicate `new SideCarClient(...)` calls
- **isLocalOllama**: shared helper replaces 3 inline URL checks

### Fixed
- Stale `pendingPlan` state not cleared on new chat
- Hidden file input (`<input type="file">`) rendering visibly due to missing CSS rule
- 6 pre-existing lint warnings (unused imports, let vs const)

## [0.9.0] - 2026-04-05

### Added
- **@ references**: `@file:path`, `@folder:path`, `@symbol:name` syntax in chat messages for precise context inclusion
- **Status bar integration**: shows current model and provider (Ollama/Anthropic), click to toggle chat panel, updates on model/config changes
- **Documentation generation**: `/doc` command generates JSDoc/docstrings for active file or selection
- **Multi-model mid-chat switching**: changing models preserves conversation, updates status bar and config

## [0.8.0] - 2026-04-05

### Added
- **Spec-driven development**: `/spec` command generates structured requirements (EARS notation), design, and dependency-sequenced tasks. Specs saved to `.sidecar/specs/`
- **Event-based hooks**: trigger shell commands on file save, create, or delete events via `sidecar.eventHooks` setting
- **Git commit message generation**: `sidecar.generateCommitMessage` command generates conventional commit messages from staged/unstaged changes
- **Per-prompt cost estimation**: `estimateCost()` utility for Anthropic models (Claude Opus/Sonnet/Haiku pricing)

## [0.7.0] - 2026-04-05

### Added
- **Plan Mode**: generate a plan for review before executing tools (`sidecar.planMode` setting)
- **Danger Mode UX**: autonomous mode shows "Danger Mode" badge, autonomous tool calls audit-logged
- **Batch Processing**: `/batch` command for running multiple tasks sequentially or in parallel (`--parallel`)
- **Session Management**: `/save name` and `/sessions` commands, save/load/delete named sessions across workspaces
- **Custom Skills**: user-defined tools via `sidecar.customTools` setting — shell commands registered as agent tools
- **Insight Reports**: `/insight` command generates activity analytics (tool usage, error rates, token stats)
- **PR Summaries**: `sidecar.summarizePR` command generates PR description from git diff
- **Metrics Collector**: tracks tool calls, durations, tokens, and errors per agent run
- `.vscodeignore` for cleaner extension packaging

## [0.6.0] - 2026-04-05

### Added
- **Per-tool permissions**: allow, deny, or force-ask per tool via `sidecar.toolPermissions`
- **Pre/post execution hooks**: run shell commands before/after tool execution via `sidecar.hooks`. Passes tool name, input, and output as env vars
- **Scheduled tasks**: recurring agent runs on interval via `sidecar.scheduledTasks`. Runs autonomously with output channel logging

## [0.5.0] - 2026-04-05

### Added
- **MCP (Model Context Protocol) client**: connect to any MCP server for external tools
- `sidecar.mcpServers` setting for configuring MCP server connections (stdio transport)
- MCP tools appear transparently alongside built-in tools in the agent loop
- Auto-reconnect when MCP server settings change
- MCP tool calls go through the existing approval flow
- **SIDECAR.md** project instructions: create a `SIDECAR.md` in your project root for persistent project-specific context (like CLAUDE.md for Claude Code)

## [0.4.0] - 2026-04-05

### Added
- **Inline chat** (Cmd+I / Ctrl+I): edit code in place or insert at cursor
- **Enhanced completions**: better FIM prompts, next-edit prediction from recent edits, configurable debounce
- **Extended thinking**: collapsible "Reasoning" blocks from models that support thinking
- **Context compression**: auto-truncates old tool results at 70% of token budget
- **Code review**: `sidecar.reviewChanges` command — AI reviews git diff, opens results as markdown
- `get_git_diff` tool for agent access to git changes
- **Sub-agents**: `spawn_agent` tool lets the model spawn parallel workers for complex tasks
- `sidecar.completionDebounceMs` setting

### Changed
- Completion provider tracks recent edits for next-edit prediction context
- Prefix/suffix limits (8K/2K) for completions to avoid context overflow

## [0.3.0] - 2026-04-04

### Added
- **Agent mode settings**: cautious, autonomous, manual approval modes
- **Safety guardrails**: configurable max iterations (default 25) and token budget (default 100K)
- **Agent mode indicator** in webview header (color-coded badge)
- **Inline chat** (Cmd+I / Ctrl+I): edit code in place or insert at cursor
- `get_diagnostics` tool: read compiler errors and warnings from VS Code
- `run_tests` tool: run test suites with auto-detection (npm, pytest, cargo, go, gradle)
- **Undo/rollback**: revert all AI-made file changes with one click
- ChangeLog tracks file snapshots before modifications

## [0.2.0] - 2026-04-04

### Added
- **Tool use foundation**: structured tool calls via Anthropic Messages API
- **Agent loop**: autonomous multi-step execution (read, edit, test, fix)
- 7 built-in tools: read_file, write_file, edit_file, search_files, grep, run_command, list_directory
- **Tool executor** with approval flow (auto for reads, confirm for writes)
- **Observability**: AgentLogger with VS Code Output Channel ("SideCar Agent")
- **Collapsible tool calls** in chat UI with expandable details

### Changed
- Client streaming overhauled: yields StreamEvent (text + tool_use + stop) instead of raw strings
- Replaced regex-based action detection with proper tool use
- System prompt simplified (tools are self-describing)

## [0.1.0] - 2026-04-04

### Added
- **Anthropic Messages API**: switched from Ollama /api/chat to /v1/messages for dual-provider support
- **Dual backend**: works with local Ollama or Anthropic API (Claude)
- New settings: sidecar.baseUrl, sidecar.apiKey
- **Inline code completions** (Copilot-like, opt-in) with FIM for Ollama
- **File editing**: search/replace format with diff preview
- **Multi-file edits**: atomic WorkspaceEdit application
- **Terminal integration**: commands run in VS Code terminal with output capture
- **Diff preview**: virtual URI scheme with VS Code's built-in diff viewer
- **Chat history persistence** via workspaceState (per-workspace)
- **Active file context**: auto-includes current file and cursor position
- **Context-aware file reading**: detects file paths in messages
- **Code actions**: right-click Explain, Fix, Refactor with SideCar
- **Image support**: paste or attach images for vision models
- **Keyboard shortcut**: Cmd+Shift+I to toggle SideCar panel
- **Streaming indicator**: token count and tok/s display
- **Conversation management**: New Chat (+) and Export as Markdown buttons
- Broadened default file patterns (25+ languages)
- Context window warning for small models

### Changed
- Renamed all IDs from ollama.* to sidecar.*
- Default model changed to qwen3-coder:30b
- Workspace context moved to system field for better model compliance

## [0.0.1] - 2026-04-03

### Added
- Interactive AI chat sidebar with streaming responses from Ollama
- Model selection, switching, and on-demand installation
- Workspace context injection
- File attachment from active editor or file picker
- Code block rendering with Save button
- File move/rename via chat commands
- GitHub integration (clone, PRs, issues, commits, diffs, push/pull, browse)
- Auto-start Ollama when not running
- VS Code theme-aware styling
