---
title: Your First Multi-file Refactor
layout: docs
nav_order: 19
---

# Your First Multi-file Refactor

This guide walks you through using SideCar's agent to execute a real multi-file refactor — not just a chat about code, but autonomous edits across your workspace. If you've used SideCar for Q&A but haven't let it write files, start here.

---

## Before you start

### Commit or stash your current changes

The agent is going to write files. If your working tree has uncommitted changes mixed in, the diff at the end will be hard to read and you'll have trouble selectively reverting. Before you send the task:

```bash
git add -A && git commit -m "wip: before sidecar refactor"
# or
git stash
```

This gives you a clean baseline. If anything goes wrong you can `git checkout .` or `git stash pop` and be back to exactly where you started.

### Choose the right mode

Open the mode dropdown in the chat header (defaults to **Cautious**) and pick the tier that matches your confidence:

| Mode | What it means for a refactor |
|------|-------------------------------|
| **Cautious** | Every file write opens a diff editor; you accept or reject before the agent moves on. Slower but you review each change in-flight. |
| **Review** | All writes are buffered in memory — nothing lands on disk until you audit the whole batch in the **Pending Agent Changes** panel. Best for large refactors where per-file interruptions would break your concentration. |
| **Autonomous** | The agent writes freely; you review after via `git diff`. Use only when you have a clean stash and trust the task scope. |

For a first refactor, start with **Review** mode. You get full autonomy during the run and a single review session at the end.

Set it in `.vscode/settings.json` if you want it sticky for this project:

```json
"sidecar.agentMode": "review"
```

### Enable Shadow Workspaces for full isolation

Shadow Workspaces run the entire agent task in an ephemeral `git worktree` branched off your current `HEAD`. Your main working tree is untouched until you explicitly accept. This is the safest option — if the result isn't what you wanted, one click discards everything.

```json
"sidecar.shadowWorkspace.mode": "always"
```

With this set, every agent task automatically gets its own shadow at `.sidecar/shadows/<task-id>/`. At the end you'll see a QuickPick with the diff summary (file count, line count) and an **Accept / Reject** choice. Accept stages the diff onto your main tree; Reject leaves it untouched.

Shadow Workspaces and Review mode work together: you can have shadow isolation (nothing on disk until accept) and still get the per-file Pending Changes panel after the accept step.

---

## Writing the task prompt

The quality of the plan the agent builds is directly proportional to the specificity of your prompt. Vague prompts lead to vague plans, partial work, and unnecessary back-and-forth.

### What a good task description contains

- **What to change** — the specific symbol, pattern, or structure being modified
- **Where** — the files or directories in scope, or a constraint that limits scope
- **The goal** — why this change matters (rename for clarity, extract for reuse, etc.)
- **What not to touch** — test files only, generated files off-limits, public API must stay stable

### Three versions of the same task

**Bad prompt:**
```
Refactor the error handling
```

This gives the agent nothing to work with. It doesn't know which error handling, which files, what "refactor" means in this context, or what done looks like. Expect either a long clarifying-question loop or a random partial change.

**Mediocre prompt:**
```
Change all the places where we throw Error objects to use our custom AppError class instead
```

Better — there's a clear goal. But "all the places" is unbounded (does that include tests? third-party adapters? generated code?), and there's no constraint on the public API surface or migration notes.

**Good prompt:**
```
Replace all `throw new Error(...)` calls in `src/` (not tests, not generated files under `src/generated/`) with `throw new AppError(...)`. AppError is defined in `src/errors/appError.ts`. Keep the message string as-is; just change the constructor. Don't touch `src/generated/` or any `.test.ts` file. When you're done, run `npm test` to verify nothing regressed.
```

This prompt tells the agent exactly what to change, the precise scope, what to preserve, and the verification step. The agent can build a complete edit plan without asking a single clarifying question.

---

## Watching the planned-edits card

When your task touches 3 or more files (the default threshold), SideCar runs a planner pass before writing anything. A collapsible **Planned edits** card appears in chat. The agent will not start writing until you've had a chance to see it.

### What the card shows

Each row in the card represents one file operation:

- **Operation badge** — `create`, `edit`, or `delete`
- **File path** — workspace-relative path
- **Rationale** — one sentence from the planner explaining why this file is in scope
- **Dependency references** — if this file depends on another in the batch completing first, the dep is listed here
- **Status indicator** — starts at `pending`, transitions to `writing`, then `done`, `failed`, or `aborted`
- **Cancel button** — per-file abort (see below)

### How to read it before writing starts

Before the first write fires, scan the list and ask:

- Are all the listed files ones you expected? If the planner pulled in a file you didn't intend to touch, steer now (see [Steering mid-run](#during-execution)).
- Are there files missing that should be in scope? Type a follow-up with the missing path before execution starts.
- Do the rationales make sense? A vague or wrong rationale is a signal the agent misunderstood the task.

If the plan looks wrong, type a correction in the chat box. The agent will revise the plan before writing.

### Skipping the planner

If you already know exactly what needs to change and don't want the overhead of the planning pass, add `@no-plan` anywhere in your message:

```
Replace ErrorCode with StatusCode everywhere in src/types/. @no-plan
```

The agent skips the manifest and streams writes directly. Useful for narrow, well-understood changes where the planning turn would just slow you down.

You can tune the threshold or disable the planner for larger batches via settings:

```json
"sidecar.multiFileEdits.minFilesForPlan": 5,
"sidecar.multiFileEdits.planningPass": true
```

Setting `minFilesForPlan` to `1` plans everything; `0` disables planning entirely.

---

## During execution

### Streaming diff previews

In **Cautious** mode, each file write opens VS Code's native diff editor the moment the agent begins writing it — the proposed content streams in on the right while the original sits on the left. An Accept/Reject card appears in both the editor notification and the chat panel. Click either; the first click wins.

In **Review** mode, the diff editor is available but nothing requires your action during the run. The Pending Agent Changes panel (in the SideCar activity bar, below the chat) updates live as each file completes. You review at the end, not in the middle.

In **Autonomous** mode, files are written immediately with no diff preview. Review via `git diff` afterward.

### Per-file cancel

Each row in the planned-edits card has a cancel button. Clicking it mid-stream aborts that specific file's write without touching the rest of the batch. Use it when:

- The agent is writing a file you realize is out of scope
- The file is large and streaming slowly; you'd rather redirect the agent
- The rationale was wrong and you want to guide the agent to a different approach for this file

The cancelled file's status changes to `aborted`. Other in-flight files continue normally. After the batch completes, you can steer the agent to handle the cancelled file differently in a follow-up turn.

### Steering mid-run

The chat input stays active while the agent is running. You can type and send a message at any time. This aborts the current run and starts a new one with your steer as the next user message.

Use this when:

- You see the planned-edits card and want to add or remove a file before writing starts
- The agent is mid-execution and you realize the approach is wrong
- You want to narrow or expand scope based on what you see streaming

To steer without a full restart, send a short correction. The agent picks up from the context of what it's already done:

```
Actually, keep the old ErrorCode export as a re-export alias so callers don't break.
```

The agent pauses, reads your steer, and adjusts. If you want a hard stop instead, press **Escape** or click **Stop** (the button that replaces Send while the agent is running).

---

## Accepting or rejecting the result

### Review mode: per-file accept

When the agent finishes in Review mode, the **Pending Agent Changes** panel shows every buffered write with a before/after diff. Click any file to open the VS Code diff editor with the full change. Then:

- **✓ (accept)** — writes the pending content to disk for that file
- **✕ (discard)** — drops the buffered change; the file on disk is unchanged
- **Accept All** in the panel title bar — writes every pending file atomically
- **Discard All** — drops all pending changes (prompts for confirmation since it can't be undone)

The panel also supports Command Palette actions: `SideCar: Accept All Pending Changes`, `SideCar: Discard All Pending Changes`, `SideCar: Show Pending Diff`.

`reviewGranularity` controls whether you see per-file controls or just a bulk Accept/Reject pair:

```json
"sidecar.multiFileEdits.reviewGranularity": "per-file"
```

### Shadow Workspaces: accept the diff

If you ran with `sidecar.shadowWorkspace.mode: "always"`, the agent's work is in a git worktree off `HEAD`. At the end of the run a QuickPick appears with:

- File count and line change summary
- **Accept** — applies the diff to your main tree as staged changes (visible in `git status`)
- **Reject** — discards the shadow; your main tree is completely untouched

### Undo if you accepted and changed your mind

If you accepted changes and immediately regret it:

- Type `/undo` in the chat, or press `Cmd+Shift+U` / `Ctrl+Shift+U`

This reverts all files modified in the last agent run. SideCar snapshots every file before modifying it, so undo is always available immediately after a run regardless of mode.

### Reviewing the git diff

After accepting, do a final review in your normal git workflow:

```bash
git diff HEAD
# or open the VS Code Source Control panel
```

This is the ground truth. The planned-edits card and the Pending Changes panel give you an agent-structured view; the raw git diff shows you exactly what landed on disk.

---

## When things go wrong

### Agent declares done but missed files

The completion gate (`sidecar.completionGate.enabled`, default on) forces the agent to run lint and colocated tests before declaring a turn done. But it can't catch files that were never in scope to begin with.

If the agent stops but you can see that certain files weren't touched:

1. Don't start a completely new conversation — the agent still has context from the run.
2. Type a follow-up describing the gap: `"You didn't update src/api/handlers.ts — that also uses ErrorCode."` The agent will continue from where it left off, treating your message as a steer.

Multiple agent turns in the same conversation share history. In Review mode, new edits from the follow-up turn add to the same Pending Changes panel rather than replacing it — carry-forward is intentional so you review the full batch at once.

### Agent is looping

Cycle detection fires automatically. SideCar tracks exact-match repetitions (same tool call 4 times in a row) and normalized-signature repetitions (same tool + same file with different content, 3 times). When either trips, the loop halts and a message appears in chat.

If cycle detection fires before the task is done, steer out:

```
Stop trying to run the tests. The test failures are expected — the test file hasn't been updated yet. Move on to updating src/handlers/userHandler.ts.
```

Giving the agent a specific next file or action breaks it out of the loop cleanly.

### Completion gate blocked

If you see a message like `"Run lint and the colocated tests for the edited files before finishing"` injected into the conversation, the completion gate is doing its job — the agent tried to declare victory without verifying.

The gate fires when the agent edited a file that has a colocated `.test.ts` / `.spec.ts` without running it, or when no lint pass happened during the turn.

To resolve:

- Let the agent run the checks (it usually does on the next iteration)
- If the tests legitimately can't run in this environment, type: `"The test suite requires a running DB — skip run_tests for this turn."` The gate is capped at 2 injections per turn; after that the loop terminates with a warning rather than hanging

To turn off the gate entirely (not recommended for production code):

```json
"sidecar.completionGate.enabled": false
```

---

## Iterating

### Running a second pass

If the first run was mostly correct but missed something, just keep going in the same conversation. The agent has the history of what it already did. A second pass prompt like:

```
Good. Now also update the JSDoc comments in the files you just changed to reflect the new AppError type.
```

starts a new agent turn that builds on the previous one. In Review mode, the new edits accumulate in the same Pending Changes panel. You review the combined result before anything hits disk.

### Using /fork to try multiple approaches in parallel

When you have a genuine design choice — two valid refactoring strategies and you're not sure which will look better in practice — use `/fork` to run them in parallel:

```
/fork Refactor the auth middleware to use the new TokenValidator class
```

By default this spawns 3 parallel agent runs (`sidecar.fork.defaultCount: 3`) each in its own Shadow Workspace. All three get the same prompt but will diverge naturally in approach — different file read order, different intermediate steps, different final shape.

When all three finish, a review UI presents each fork's diff. You pick one winner, and only that fork's changes get applied to your main tree.

Tune the fork count and parallelism:

```json
"sidecar.fork.defaultCount": 3,
"sidecar.fork.maxConcurrent": 3
```

Fork is overkill for most refactors. Use it when you genuinely want to compare approaches rather than just running the agent once and iterating from there.
