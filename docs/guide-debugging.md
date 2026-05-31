---
title: Debugging Agent Issues
layout: docs
nav_order: 7
nav_section: "Guides"
---

# Debugging Agent Issues

This guide covers the most common failure modes when SideCar's agent doesn't behave as expected. Each section starts with the symptom, explains what's happening, and tells you what to do.

---

## The agent is looping or repeating the same action

**What's happening.** SideCar has two layers of cycle detection. The first is an exact-match ring buffer: if the same tool call (same tool, same inputs) fires 4 times consecutively, the loop trips. The second is a normalized-signature ring buffer: it strips secondary arguments and compares `name:primaryResource` forms, so "same tool, same file, different edit content" still trips after 3 matches. This catches loops the exact-match check misses — for example, an agent that keeps editing the same file with slightly different content on each pass.

When either detector trips, the agent halts with a message in chat explaining the pattern it detected.

There is also a burst cap on individual tools — no single tool may be called more than N times per session regardless of whether a cycle is detected.

**What to do.**

The fastest fix is to steer mid-run. The chat input stays live while the agent is working. Type a follow-up that redirects the agent:

```
Stop trying to edit that file. Read the test output first and tell me what's failing.
```

Sending the message aborts the current run immediately and starts a new one with your instruction.

If the agent has already stopped on its own, start a new message that rephrases the task. Cycle detection usually fires when the model has lost track of its goal — a cleaner, more specific prompt breaks the pattern:

- Too vague: "Fix the tests"
- Better: "The test `auth.test.ts` is failing because `validateToken` returns `null` on expired tokens — fix the return value in `src/auth/validateToken.ts`"

If cycles keep happening on large tasks, consider using Shadow Workspaces (`sidecar.shadowWorkspace.mode: "always"`) so failed attempts don't accumulate state, or `/fork` to run a few parallel attempts and pick the one that succeeds.

---

## The agent declared it is done but the task is incomplete

**What's happening.** The completion gate (`sidecar.completionGate.enabled`, default on) tracks which files the agent edited against which test and lint commands it ran. If the agent tries to finish a turn without having run lint or the colocated tests for a file it touched, the gate injects a synthetic message into the loop demanding those checks. It fires at most twice per turn, then lets the loop terminate rather than hang.

The gate catches the most common case — claiming code is "ready" without running checks — but it cannot catch every possible gap:

- The agent ran the wrong test suite, not the one for the file it edited
- The test ran but the agent misread the output
- The task involved something with no automated test coverage
- `sidecar.completionGate.enabled` is `false`

**What to do.**

Send a follow-up that names what was missed:

```
You didn't update the error message in parseUserInput. The test at line 42 of parseUserInput.test.ts still expects the old string.
```

The agent picks up the conversation history and continues without you needing to re-explain the whole task.

If the completion gate keeps missing things for a specific project, you can define a regression guard that runs after every write. See [Regression guards keep blocking](#regression-guards-keep-blocking) for the schema — the same mechanism works in reverse to enforce checks the default gate doesn't cover.

---

## The agent is editing the wrong files

**What's happening.** SideCar builds context automatically using semantic search and file scoring, but on large codebases or when your question is ambiguous, it guesses. The most common scenario is the agent reading a file that has a similar name or content to what you meant, then editing the wrong one.

**Immediate fix: reference the file explicitly.**

Use `@file:` in your prompt to pin the file you want the agent to work with:

```
@file:src/auth/validateToken.ts The token expiry check on line 38 is off by one — fix it.
```

You can pin a file permanently so it's always in context regardless of the task:

```
@pin:src/auth/validateToken.ts
```

Pinned files appear in a dedicated "Pinned Files" section before relevance-scored files and survive context compaction.

**Longer-term fix: path-scoped sections in SIDECAR.md.**

If the agent keeps confusing files across a subsystem, add a path-scoped section to `.sidecar/SIDECAR.md`:

```markdown
## Auth module
<!-- @paths: src/auth/** -->

Token validation lives in `src/auth/validateToken.ts`. The JWT secret is read from `src/config/secrets.ts` — never from environment variables directly. The session model is in `src/models/session.ts`.
```

The `<!-- @paths: glob -->` sentinel tells SideCar to inject this section only when the active file or a mentioned path matches `src/auth/**`. The agent stops guessing and reads the right files from the start.

If your SIDECAR.md is large (20+ sections), switch to retrieval mode so sections are scored by semantic relevance instead of path matching:

```json
"sidecar.sidecarMd.mode": "retrieval"
```

---

## The agent is not using tools at all (just responding in text)

**What's happening.** If a model fails to produce valid tool calls after 3 attempts, SideCar stops sending tool definitions to avoid wasting context on a model that won't use them. The agent falls back to prose responses. You'll see normal-looking chat replies for tasks that should involve file reads or edits.

This happens because:

1. The model doesn't support function calling reliably (most common)
2. The model is an instruction-tuned variant that was trained to refuse tool use
3. The prompt is confusing the model into treating the task as a conversation

**How to check.** Run `/verbose` (or set `sidecar.verboseMode: true`) and start a new message. The verbose output will show whether tool definitions were sent and, if so, what the model returned instead of a tool call.

**Fix: switch to a model with reliable function calling.**

Open [model-recommendations.md](model-recommendations) to see which models are verified for agentic use. For local models, `qwen3-coder:8b` and larger are reliable. For cloud, any Claude Sonnet or Haiku 4.x works.

Switch mid-conversation:

```
/model qwen3-coder:8b
```

Or change the default in settings:

```json
"sidecar.model": "qwen3-coder:8b"
```

**If you want to keep the model.** Some models produce tool calls only when prompted explicitly. Try prefixing your message:

```
Use the read_file tool to read src/auth/validateToken.ts, then explain the expiry logic.
```

This often unsticks models that default to prose when the intent is ambiguous.

---

## The agent produces placeholder code (TODOs, not-implemented stubs)

**What's happening.** After every `write_file` or `edit_file`, the stub validator scans the output for placeholder patterns:

- `TODO`, `FIXME`, `HACK` comments
- "implement this", "placeholder", "stub" comments
- "real implementation" / "actual implementation" deferrals
- `throw new Error('Not implemented')` / `raise NotImplementedError`
- "for now" hedging, "would need" future deferral
- Python `pass`-only function bodies, ellipsis-only bodies (`...`)

When it detects placeholders, SideCar automatically reprompts the model to replace them with complete code. You'll see a message in chat when this fires. Issue tracker references like `TODO(#123)` are excluded from detection.

The stub validator fires once (one retry). If the model produces stubs again on the retry, the output lands as-is with a warning.

**If it keeps happening.** The model doesn't have enough capacity to implement what you're asking. The stub validator is a symptom surface — the root cause is the model giving up instead of working through a hard problem.

Options, in order of least to most disruptive:

1. Break the task into smaller pieces. Ask the agent to implement one function at a time instead of an entire module.

2. Add a custom mode that makes the instructions explicit:

   ```json
   "sidecar.customModes": [
     {
       "name": "no-stubs",
       "description": "Never produce placeholder code",
       "systemPrompt": "Never write TODO comments, never write placeholder code, never defer implementation. If you cannot implement something fully, ask for clarification instead.",
       "approvalBehavior": "cautious"
     }
   ]
   ```

3. Switch to a larger model for the task. `/model claude-sonnet-4-6` or a 30B+ local model handles complex implementations that smaller models defer on.

---

## I cannot see what the agent is doing

**Verbose mode: system prompt, token counts, and tool selection.**

Run `/verbose` to toggle verbose mode. With verbose on, each agent run shows:

- The full assembled system prompt at the start of the run (so you can see what context the agent actually has)
- Per-iteration summaries: elapsed time and token counts
- Tool selection explanations before each tool call

Verbose output appears in yellow-bordered collapsible blocks, visually separate from the agent's normal responses.

To enable it permanently:

```json
"sidecar.verboseMode": true
```

**Inspect the system prompt at any time.**

```
/prompt
```

This shows the base prompt, SIDECAR.md content, and any custom system prompt you've configured — without starting an agent run. Use this to verify that your SIDECAR.md sections are being injected and that your custom mode or `sidecar.systemPrompt` is taking effect.

**See context window usage.**

```
/context
```

Renders a breakdown of the current context window: system prompt size, SIDECAR.md content, workspace files with individual token counts, conversation history, and a visual usage bar. If the bar is near full, the agent is running in a compressed context — use `/compact` to reclaim space.

**See reasoning blocks.**

For models that produce thinking output (Claude with extended thinking, Qwen3, DeepSeek-R1), reasoning renders as a numbered timeline in the chat:

```
[1. 🧠 Reasoning — 2.3s]
[2. 🔧 read_file — 180ms]
[3. 🧠 Reasoning — 1.1s]
```

Reasoning segments are collapsed by default. To expand them:

```json
"sidecar.expandThinking": true
```

**Audit log.**

For a structured record of every tool call the agent made, including inputs, outputs, durations, and errors:

```
/audit
```

Filter by tool or status:

```
/audit tool:edit_file
/audit errors
/audit last:20
```

---

## The agent is slow

**Large context.** The most common cause. As the conversation grows, each turn sends more tokens to the model, which slows inference and increases cost. Check `/context` to see how full the window is.

Fix:

```
/compact
```

This summarizes older turns and compresses the conversation history. The agent retains the task context via episodic memory (summaries are embedded and retrieved in future turns), but the raw message count drops significantly.

**Slow model or missing speculative decoding.**

For local models, speculative decoding delivers near-main-model quality at draft-model latency by having a smaller draft model propose tokens in parallel:

```json
"sidecar.speculativeDecoding.enabled": true,
"sidecar.completionDraftModel": "qwen2.5-coder:0.5b"
```

The draft model should be from the same model family as your main model and at least 10x smaller. SideCar auto-discovers the smallest available model on the backend if you leave `completionDraftModel` empty.

**Two-model split for agent runs.**

On paid backends, planning turns (where the agent is thinking about what to do) and execution turns (where it's calling tools) have different complexity. Use a cheaper model for execution turns:

```json
"sidecar.editorModel": "claude-haiku-4-5"
```

With this set, `sidecar.model` handles planning turns; `claude-haiku-4-5` handles execution turns. The agent stays smart where it matters and fast where it doesn't.

**Flash Attention (Kickstand only).**

If you're using Kickstand, Flash Attention gives a 2–4x speedup on long contexts:

```json
"sidecar.kickstand.flashAttn": true
```

Requires a Metal (macOS) or CUDA build. Silently ignored on CPU-only.

---

## The agent broke something and I want to undo

**Undo all changes from this session.**

```
/undo
```

Or press `Cmd+Shift+U` / `Ctrl+Shift+U`. SideCar snapshots every file before modifying it, so undo restores the exact original content.

**Undo changes to a specific file.**

After an agent run, a change summary panel shows all modified files with inline diffs. Click the revert icon on any file to restore just that file without reverting the others.

In review mode (`sidecar.agentMode: "review"`), changes are buffered and never hit disk until you accept them. Use the Pending Agent Changes panel to accept individual files or discard the whole batch.

**Use git.**

All of SideCar's writes go through the normal filesystem and appear in `git status`. If `/undo` isn't available (for example, after a VS Code restart), the standard git tools work:

```
git diff                          # see what changed
git checkout -- src/auth/token.ts # revert one file
git checkout .                    # revert everything
```

If you're using Shadow Workspaces (`sidecar.shadowWorkspace.mode`), the agent's writes land in an ephemeral git worktree at `.sidecar/shadows/<task-id>/` and never touch your main tree until you accept the diff. Rejecting at the accept/reject prompt leaves your working tree completely untouched.

---

## The agent is using too many tokens or costing too much

See the [Cost Optimization guide](guide-cost-optimization) for the full walkthrough. The short version:

- `/compact` to shrink the context window mid-session
- `sidecar.editorModel` to route execution turns to a cheaper model
- `sidecar.promptPruning.enabled: true` (default on) to truncate large tool results before they're sent to a paid backend
- `sidecar.dailyBudget` / `sidecar.weeklyBudget` to set hard spending limits
- `/usage` to see a per-run token and cost breakdown

---

## Regression guards keep blocking

**What regression guards are.** Regression guards run shell commands after specific agent actions (a file write, a turn end, or before the agent declares done) and block the turn with a reprompt if the command exits non-zero. They're configured in `sidecar.regressionGuards`:

```json
"sidecar.regressionGuards": [
  {
    "name": "lint",
    "command": "npm run lint",
    "trigger": "post-write",
    "mode": "blocking",
    "scope": ["src/**/*.ts"],
    "maxAttempts": 5
  }
]
```

Run `/guards` in chat to see which guards are active and what their current status is.

**Reading a failure message.** When a guard blocks a turn, the chat shows:

- The guard name (`lint`)
- The exit code
- The first lines of stdout/stderr from the failed command

This is the same output you'd see running the command yourself. The agent is also shown the output and will attempt to fix the issue before the turn can proceed. After `maxAttempts` retries (default 5), the loop terminates with a warning rather than running forever.

**If a guard is blocking on something unrelated to your task.** Two options:

1. Fix the underlying issue first. Guards often catch pre-existing failures that the agent's edit didn't cause but that are now blocking it from finishing. Run the guard command yourself (`npm run lint`), fix the errors, then re-run your task.

2. Temporarily set a guard to advisory mode so it logs but doesn't block:

   ```json
   {
     "name": "lint",
     "command": "npm run lint",
     "trigger": "post-write",
     "mode": "advisory",
     "scope": ["src/**/*.ts"]
   }
   ```

   Change it back to `"blocking"` when the pre-existing failures are resolved. Avoid disabling guards entirely — they exist to catch regressions, and the cost of disabling them is exactly the regressions they would have caught.

**Global mode override.** To pause all guards for a session without editing each one:

```json
"sidecar.regressionGuards.mode": "warn"
```

`"warn"` logs failures but never blocks. Set it back to `"strict"` when you're done.
