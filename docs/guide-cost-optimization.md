---
title: Reducing API Costs
layout: docs
nav_order: 4
nav_section: 'Guides'
---

# Reducing API Costs

This guide is for developers using SideCar with Anthropic or OpenAI APIs who want to understand where tokens go and how to cut the bill without sacrificing quality.

---

## Understanding where tokens go

Every API request bills you for two token pools: **input** and **output**.

| Source                                           | Typical token count | Relative cost                          |
| ------------------------------------------------ | ------------------- | -------------------------------------- |
| System prompt (base rules + SIDECAR.md sections) | 2,000–6,000         | Input — expensive if repeated uncached |
| Tool schemas (87 built-in tools)                 | ~4,000–6,000        | Input — constant, ideal for caching    |
| Workspace context (RAG hits, pinned files)       | 1,000–20,000        | Input — varies by query                |
| Prior conversation history                       | grows per turn      | Input — compressible                   |
| Tool results (file reads, shell output, etc.)    | 500–8,000 each      | Input — prunable                       |
| Assistant output                                 | 200–2,000 per turn  | Output — most expensive per-token      |

Output tokens cost 4–5x more per token than input tokens on most Claude models, but they are also the shortest part of most turns. The biggest savings come from reducing **repeated input tokens** across turns — system prompt, tool schemas, and conversation history.

### How to check your spend

The `$(credit-card) $0.12` status bar item appears as soon as your first Anthropic request completes. Click it to open a per-model breakdown showing total spend, request count, input tokens, output tokens, and cache metrics for the session.

Two commands are also available from the Command Palette:

- `SideCar: Show Session Spend` — full breakdown with per-model token counts
- `SideCar: Reset Session Spend` — zero the session tally (does not affect Anthropic Console totals)

Run `/usage` in chat to see current spend alongside budget status (spent / limit / remaining per active budget).

To keep permanent per-request records for auditing:

```json
"sidecar.verboseLogs": true
```

This appends `runId`, `model`, `inputTokens`, `outputTokens`, `stopReason`, and `timestamp` to `.sidecar/logs/api.jsonl` for every API call.

---

## Prompt caching (Anthropic)

SideCar applies three `cache_control: { type: "ephemeral" }` breakpoints automatically on every Anthropic request. You do not configure anything — this is always on.

**What gets cached and where the breakpoints land:**

1. **System prompt stable prefix** — everything before the `## Workspace Structure` section (the base rules, SIDECAR.md injections, and user config). This block is marked cached on every request. The dynamic workspace context section is left uncached because it changes per query.

2. **Tool schemas** — all 79 tool definitions are sent with `cache_control` on the last entry. The API caches the entire tool block as a unit. Tool schemas are identical across every turn of an agent loop, so after the first turn you pay only the 10% cache-read rate (~$0.30/1M tokens instead of $3/1M for Sonnet inputs).

3. **Conversation history** — the last content block of the last assistant message is marked cached. This means the growing conversation history (assistant reasoning + tool_use blocks from prior turns) enters the cached prefix immediately, and only the current user turn (tool results) is sent uncached.

**Practical implication:** Turn 1 of a session creates all three cache entries. From turn 2 onward, you pay cache-read rates (~10% of normal input cost) for the system prompt, tools, and prior turns. On a 20-turn agent session, the actual input-token cost is typically 15–20% of what it would be without caching. The longer your session, the cheaper each additional turn becomes.

Cache entries last 5 minutes of inactivity. If you go idle for more than 5 minutes mid-session, the next turn recreates the cache entries (visible as `cache_creation_input_tokens` in the spend breakdown rather than `cache_read_input_tokens`).

---

## Prompt pruning

`sidecar.promptPruning.enabled` is `true` by default. Before every request to a paid backend, SideCar runs the prompt pruner, which does three things:

1. **Collapses whitespace** in tool results — removes runs of blank lines and leading/trailing padding.
2. **Head+tail truncates oversized tool results** — any `tool_result` block over `maxToolResultTokens` is replaced with the first N tokens, an elision marker (e.g. `[...elided 1,240 tokens...]`), and the last N tokens.
3. **Deduplicates repeated file content** — if the agent read the same file multiple times in a session, earlier identical reads are collapsed to a reference marker, unless the tool is flagged `nondeterministicOutput` (e.g. `git_diff`, `read_file` are exempt — you always get the full content of the most recent read).

**Tuning `maxToolResultTokens`:**

```json
"sidecar.promptPruning.maxToolResultTokens": 4000
```

The default is 4,000 tokens. This is appropriate for most tasks. Adjust it when:

- **Lower (1,000–2,000):** You are doing exploration-heavy work (many `read_file`, `search_files`, `run_command` calls) where the agent is gathering information but doesn't need the full output of every call in the context window. Good for large codebases where grep results or file listings are verbose.
- **Higher (6,000–8,000):** The agent is making decisions based on long structured outputs — large JSON responses, full test output, diff output for big refactors. Truncation at 4,000 can cause the agent to miss the error at the bottom of a long stack trace.

The setting is clamped between 200 and 20,000. Raising it above ~6,000 on Claude Sonnet starts to noticeably increase per-turn cost because tool results are the uncached part of the input.

---

## The architect/editor split

This is the single highest-impact cost reduction for agent runs. Instead of using one expensive model for every turn, you use:

- **Planner (expensive model):** turns where no tools have been called yet — reading the task, planning the approach, writing the initial code outline.
- **Editor (cheap model):** turns where tools are already in flight — `edit_file`, `write_file`, `run_tests`, `run_command`, and follow-up reasoning based on tool results.

In a typical 15-turn agent run, roughly 2 turns are planning turns and 13 are execution turns. Execution turns make up 85–90% of total token spend. Routing them to Haiku instead of Sonnet cuts the cost of those turns by ~73% (Haiku input: $0.80/1M vs. Sonnet: $3/1M; output: $4/1M vs. $15/1M).

Configure it:

```json
{
  "sidecar.model": "claude-sonnet-4-6",
  "sidecar.editorModel": "claude-haiku-4-5-20251001"
}
```

The agent loop routes automatically: turns where `messages` contains no prior tool calls go to `sidecar.model`; turns following at least one tool call go to `sidecar.editorModel`. You do not need to think about which model is active.

**Expected savings:** 60–80% reduction in total cost per agent run compared to using Sonnet for all turns. The exact number depends on task complexity — tasks that require more planning turns (architectural work, novel feature design) see smaller savings; tasks that are mostly mechanical execution (refactoring, test generation, formatting) see larger savings.

**Alternative pairing for hybrid cloud/local setups:**

```json
{
  "sidecar.model": "claude-haiku-4-5-20251001",
  "sidecar.editorModel": "qwen2.5-coder:7b"
}
```

This uses Haiku for planning and a free local Ollama model for all execution turns, reducing API spend by ~90% compared to Haiku-only.

---

## Hybrid delegation

When `sidecar.delegateTask.enabled` is `true` (the default), the orchestrating cloud model can offload read-only research sub-tasks to a local Ollama worker using the `delegate_task` tool. The frontier model receives only the worker's compact summary — never the raw file contents, grep results, or tool outputs that the worker consumed.

**When it fires:** the agent decides autonomously whether to delegate. Tasks that trigger delegation most often:

- "Read all the test files and summarize what's covered"
- "Find all places where X is called and list the call sites"
- "Scan the dependency tree and identify circular imports"

These are token-expensive for a frontier model (many `read_file` and `search_files` calls, large results) but don't require frontier reasoning quality. A local Qwen or DeepSeek model handles them adequately and sends back a 300-token summary instead of 15,000 tokens of raw output.

**Configure it:**

```json
{
  "sidecar.delegateTask.enabled": true,
  "sidecar.delegateTask.workerModel": "qwen3-coder:30b",
  "sidecar.delegateTask.workerBaseUrl": "http://localhost:11434",
  "sidecar.delegateTask.maxIterations": 10
}
```

Leave `workerBaseUrl` at the default `http://localhost:11434` unless Ollama is running on a different machine. Set `workerModel` to the best local model you have — `qwen3-coder:30b` or `deepseek-coder-v2:16b` for high quality, `qwen2.5-coder:7b` if you are on a low-RAM machine.

Delegation is a no-op if you are already on a local-only setup (Ollama or Kickstand) — the setting only affects paid-backend sessions.

---

## Budgets and alerts

Set daily or weekly caps to prevent runaway spend during long sessions or automated runs:

```json
{
  "sidecar.dailyBudget": 5.0,
  "sidecar.weeklyBudget": 25.0
}
```

Both default to `0` (disabled). At `0`, no cap is enforced.

**What happens at each threshold:**

- **80% of budget reached:** a warning message appears in chat before the next agent run starts. The run proceeds — this is a heads-up, not a block.
- **100% of budget reached:** the agent run is blocked. A message indicates which budget was hit and which setting to adjust. You can raise the limit or reset the session spend counter to continue.

Budgets reset on calendar boundaries: daily budgets reset at midnight local time, weekly budgets reset on Monday midnight.

Run `/usage` in chat at any time to see a Budget Status table: spent, limit, and remaining for each active budget alongside the per-model token breakdown for the session.

---

## Using cheaper models strategically

Model routing lets you define rules that swap the active model based on task role, complexity, or prompt content — without changing `sidecar.model` globally.

Enable it:

```json
{
  "sidecar.modelRouting.enabled": true,
  "sidecar.modelRouting.defaultModel": "claude-haiku-4-5-20251001"
}
```

Then define rules. Rules are evaluated in order; the first match wins:

```json
{
  "sidecar.modelRouting.rules": [
    {
      "when": "agent-loop.complexity=high",
      "model": "claude-sonnet-4-6",
      "fallbackModel": "claude-haiku-4-5-20251001",
      "sessionBudget": 2.0
    },
    {
      "when": "agent-loop",
      "model": "claude-haiku-4-5-20251001"
    },
    {
      "when": "chat.prompt~=/architect|design|tradeoff/i",
      "model": "claude-sonnet-4-6"
    },
    {
      "when": "summarize",
      "model": "claude-haiku-4-5-20251001"
    }
  ]
}
```

This config routes complex agent tasks to Sonnet (with a $2 session cap per Sonnet rule before it downgrades to Haiku), all other agent turns to Haiku, architectural chat questions to Sonnet, and summarization to Haiku.

**Per-rule budget caps:** add `sessionBudget`, `dailyBudget`, or `hourlyBudget` (in USD) to any rule. When the rule's budget is exhausted, `fallbackModel` is used instead. This lets you say "use Sonnet, but fall back to Haiku after $2 of Sonnet spend today."

Enable `sidecar.modelRouting.dryRun` first to log routing decisions without applying them — useful for calibrating rules before you go live.

**Cost profile for the Claude family (approximate list prices):**

| Model                       | Input / 1M | Output / 1M |
| --------------------------- | ---------- | ----------- |
| `claude-opus-4-7`           | $15        | $75         |
| `claude-sonnet-4-6`         | $3         | $15         |
| `claude-haiku-4-5-20251001` | $0.80      | $4          |

Haiku has a 96% eval score on SideCar's 92-case harness — essentially identical to Sonnet on agentic tasks. Use Sonnet or Opus only for tasks that genuinely require deeper reasoning (novel architectural design, complex debugging with ambiguous root causes, security audits).

---

## Compression

Context compression is the last line of defense against per-turn cost growth in very long sessions. As conversation history grows, every turn re-sends more tokens. When the estimated token usage hits **70% of the model's context budget** (`CONTEXT_COMPRESSION_THRESHOLD = 0.7`), SideCar fires `ConversationSummarizer` automatically:

1. The oldest turns are summarized into a compact text block by the model.
2. The summary is embedded into `EpisodicMemoryStore` (session-scoped RAG) so the agent can retrieve relevant decisions from those turns if needed later.
3. The raw turns are removed from the active message window, replacing them with the compact summary.

This keeps the per-turn input token count from compounding across a long session.

**Manual compression with `/compact`:** before starting a long task in an existing session, run `/compact` in chat. This triggers compression immediately regardless of where you are in the context budget. Use it when you are about to kick off a 30+ iteration agent run and the session already has background context from earlier chat you do not need in the active window.

**What you lose and what you keep:** compression is lossy on the raw exchange but the episodic memory layer means important decisions stay recoverable. Before compressing, the agent injects a `<prior_context>` block when the current user query is semantically similar to something in the compressed history. This works well for "remember that decision we made about X" queries but is not a substitute for having the full history when the agent is mid-task. Do not manually trigger `/compact` in the middle of an active agent run — wait until it finishes.

---

## Quick wins checklist

Ordered by savings impact, highest first:

1. **Enable the architect/editor split** (`sidecar.editorModel`) — routes ~85% of execution turns to a cheap model. 60–80% cost reduction per agent run. Do this first.

2. **Enable hybrid delegation** (`sidecar.delegateTask.workerModel`) — offloads read-heavy research to a free local model. Impact depends on task type; highest on codebase-scanning and exploration tasks.

3. **Set a daily budget** (`sidecar.dailyBudget`) — prevents a single runaway session from wiping out a week's budget. Set this before you start any automation or overnight runs.

4. **Use Haiku as the default model** — if you are currently using Sonnet as your main model for chat and light agent tasks, switch to `claude-haiku-4-5-20251001`. It scores 96% on the SideCar eval harness and costs ~4x less per input token and ~4x less per output token than Sonnet. Reserve Sonnet for routing rules that target genuinely complex tasks.

5. **Lower `maxToolResultTokens` on exploration tasks** — if you are scanning a large codebase with many file reads and searches, drop `sidecar.promptPruning.maxToolResultTokens` to 1,500–2,000. The agent gets the important parts of each result without accumulating thousands of tokens per turn from verbose grep output.

6. **Add a `.sidecarignore` file** — excluding `dist/`, `build/`, `node_modules/`, and other generated directories prevents them from appearing in workspace context RAG hits. Fewer irrelevant files means fewer tokens injected into the system prompt per turn.

7. **Use `sidecar.sidecarMd.mode: "retrieval"`** for large SIDECAR.md files — in `sections` mode, path-scoped sections always inject their full content; in `retrieval` mode only semantically relevant sections inject per turn. If your SIDECAR.md is >20 sections, this can cut system-prompt size by 40–60%.

8. **Run `/compact` before long agent tasks** — clears accumulated chat history from the active window before a heavy multi-file refactor. Frees context budget so the agent does not compress mid-task when you need its full attention on the work.

9. **Disable the critic during development** (`sidecar.critic.enabled: false`, which is the default) — the critic fires an additional LLM call after every file edit. If you have it on, set `sidecar.critic.model` to `claude-haiku-4-5-20251001` rather than leaving it blank (which inherits your potentially more expensive main model).

10. **Disable inline completions on paid backends** — `sidecar.enableInlineCompletions` is `false` by default. If you have enabled it while on Anthropic, each keystroke-debounced completion fires a full API call. Use inline completions only with a local Ollama backend or set `sidecar.completionModel` to a local model even when your chat backend is Anthropic.
