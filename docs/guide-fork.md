---
title: Fork & Parallel Solve
layout: docs
nav_order: 10
nav_section: 'Guides'
---

# Fork & Parallel Solve

Fork runs your agent task N times in parallel — each attempt in its own isolated Shadow Workspace — then gives you a single review UI to compare all the diffs and pick the one you want. The others are discarded.

---

## What Fork does

When you run `/fork <task>`, SideCar:

1. Spawns N agent loops in parallel (default 3). Each runs inside an ephemeral `git worktree` branched off the current `HEAD` at `.sidecar/shadows/<task-id>/`.
2. Every fork gets the same prompt, same model, and same tool set. They diverge naturally — different file read order, different intermediate steps, sometimes meaningfully different approaches to the same problem.
3. All forks run with `forceShadow: true` and `deferPrompt: true`. Your main working tree is untouched throughout. No mid-run QuickPicks fire — all N forks complete before you're asked anything.
4. When every fork has settled, a pick-the-winner review opens. You inspect the diffs and choose one. That fork's changes land on your main tree via `git apply`. The rest are discarded; their shadow worktrees were already cleaned up.

The key difference from other parallel features: Fork runs N attempts at the **same** task so you can compare outcomes. It's not N specialists on N subtasks — that's [Facets](agent-mode#typed-sub-agent-facets-new-in-v066). It's not a background agent — that's [`/bg`](slash-commands#bg-task).

---

## When to use it

Fork shines when you have a genuine design choice rather than a clear implementation path.

**Ambiguous refactors.** You know a function needs to be restructured but aren't sure whether to extract helpers, collapse state, or change the call signature. Fork lets the agent try all three simultaneously rather than committing to one and iterating from there.

**Trying different algorithms.** You need to replace a naive O(n²) loop and there are several candidates — a sorted array, a hash map, a trie. Fork them and compare the diffs directly.

**Complex features with valid approaches.** You're adding a caching layer and could implement it at the repository layer, service layer, or middleware layer. Each has merits. Fork the task with each scoping constraint in the prompt and see which diff is cleaner in practice.

**Comparing approaches when you're unsure.** Any situation where you'd normally implement approach A, review it, then mentally compare it to approach B that you didn't build — Fork builds both.

Fork is overkill for most agent tasks. If you have a clear sense of what needs to happen, run the agent once and steer from there. Use Fork when you genuinely want to see multiple realized outcomes side-by-side before committing.

---

## Running a fork

### From chat: `/fork <task>`

Type your task directly after the slash command in the chat input:

```
/fork refactor the auth middleware to use async/await
/fork add input validation to the user-create endpoint
/fork replace the in-memory cache with Redis
```

SideCar reads the fork count from `sidecar.fork.defaultCount` (default 3) and dispatches that many parallel runs immediately. A status line appears in chat as each fork starts and finishes:

```
[fork dispatching 3 parallel approaches: refactor the auth middleware to use async/await]
[Fork 1 starting]
[Fork 2 starting]
[Fork 3 starting]
[Fork 2 completed]
[Fork 1 completed]
[Fork 3 completed]
[fork batch complete: 3/3 succeeded in 47.2s]
```

### From the Command Palette

Run `SideCar: Fork & Compare` (`Cmd+Shift+P` / `Ctrl+Shift+P`). This prompts you for the task via an input box instead of reading it from the chat line. Useful when you want to fork without a chat session already active.

### What happens during the run

Each fork runs with `approvalMode: 'autonomous'` — the agent writes freely inside its shadow without pausing for per-file approval. You review the entire result in one pass at the end. This is intentional: pausing each fork mid-run for approvals would block all N branches and defeat the parallel speedup.

If you need to stop the batch early, close the VS Code notification or use the active agent controls. Forks that complete before the abort record their diffs and can still be reviewed; forks that are aborted before starting are reported as `aborted-before-start` in the review.

---

## The review UI

When all forks settle, a QuickPick opens listing every fork that produced a reviewable diff:

```
$(git-commit) Fork 1   3 files · 14.8s
  auth.ts · middleware/index.ts · types.ts

$(git-commit) Fork 2   4 files · 22.1s
  auth.ts · middleware/index.ts · types.ts · auth.test.ts

$(git-commit) Fork 3   2 files · 11.3s
  middleware/index.ts · auth.ts
```

Each entry shows:

- The fork label (`Fork 1`, `Fork 2`, etc.)
- How many files it touched and how long it took
- The first four touched files as a preview

Forks that failed or produced no changes are omitted from the picker — an info message tells you how many were skipped and why (error message or "no-diff").

### Selecting a winner

Pick a fork from the list. SideCar opens a side-by-side diff using VS Code's native `vscode.diff` — the patch on the right, the original (empty) on the left. This shows exactly what would land on disk.

After reviewing the diff, a modal dialog asks for confirmation:

> Apply Fork 2 to main? Other 2 fork(s) will be discarded.

- **Apply** — runs `git apply --index` on the winner's diff, staging the changes on your main tree. They show up in `git status` ready to review and commit.
- Cancel/Dismiss — closes the dialog without applying anything. Your main tree is unchanged. You can re-invoke the review by running `/fork` again if needed, though the forks' shadow workspaces are gone at this point.

### What happens to rejected forks

Nothing to clean up. The shadow worktrees for all forks — winners and losers alike — are disposed automatically by the sandbox when each fork finishes. By the time the review UI opens, the only thing that remains per fork is the captured diff string in memory. On apply, that string is fed to `git apply`; once the review closes, everything is gone.

If a `git apply` conflict occurs (rare — it means the fork's diff no longer applies cleanly against your current HEAD), SideCar shows an error toast with the conflict message. Your main tree is unchanged in that case; the conflict happened at apply time and was blocked.

---

## Configuration

All Fork settings are under `sidecar.fork.*`.

```json
"sidecar.fork.enabled": true,
"sidecar.fork.defaultCount": 3,
"sidecar.fork.maxConcurrent": 3
```

### `sidecar.fork.enabled` (default: `true`)

Master toggle. When `false`, `/fork` and `SideCar: Fork & Compare` both show a one-line info toast instead of dispatching. Disable this if you want to remove Fork from your workflow entirely without uninstalling the extension.

### `sidecar.fork.defaultCount` (default: `3`, clamped 2–10)

Number of parallel forks spawned per dispatch. This is the N in "run N approaches in parallel."

**When to change it:**

- Drop to `2` when you have a specific A vs. B comparison in mind and don't need a third option. Faster and half the cost.
- Raise to `4–5` for genuinely open-ended tasks where you want more coverage of the approach space. Expect proportionally higher cost and longer wall-clock time.
- Values above 5 rarely add value — the agent's variance on the same prompt has diminishing returns past 3–4, and the cost climbs linearly.

The setting is clamped to `[2, 10]` because `1` would just be a normal Shadow Workspace run with no comparison.

### `sidecar.fork.maxConcurrent` (default: `3`, clamped 1–10)

Maximum number of forks in flight at the same time. With `defaultCount: 3` and `maxConcurrent: 3` (the defaults), all three forks start simultaneously. With `defaultCount: 5` and `maxConcurrent: 3`, the first three start together, and forks 4 and 5 start as slots free up.

**When to change it:**

- Lower this if your machine is struggling with concurrent Shadow Workspaces — each worktree incurs git I/O and any shell commands the agent runs are real shell sessions. On tight hardware, `maxConcurrent: 2` keeps disk churn under control.
- Lower this if you're on a paid API (Anthropic, OpenRouter) and hitting rate limits from simultaneous requests. Three concurrent 50-iteration agent loops can briefly saturate per-minute token limits.
- Raise this to match `defaultCount` for maximum speed when your hardware and rate limits allow it.

### Cost consideration

Each fork is a full agent run. If your model charges per token, running 3 forks costs approximately 3× what a single run would cost. For an Anthropic Sonnet run with a moderately complex task (say, 30k input tokens per iteration × 15 iterations), 3 forks costs roughly the same as 3 separate agent sessions.

Track spend with the `/usage` command or the `$(credit-card)` status bar item. Set `sidecar.dailyBudget` or `sidecar.weeklyBudget` to get a warning at 80% and a block at 100%.

Shadow Workspaces are always forced on for Fork regardless of your `sidecar.shadowWorkspace.mode` setting. There is no opt-out — Fork's isolation guarantee requires every run to be in a separate worktree.

---

## Tips

### Write specific prompts

Fork's variance comes from the agent making different intermediate choices, not from vague prompts producing random outputs. A vague prompt produces N variations on a confused answer. A specific prompt produces N meaningfully different implementations of the same clear goal.

Good fork prompt:

```
/fork extract the token-refresh logic from AuthService into a standalone TokenRefresher class.
Keep the existing AuthService interface intact. Add a unit test for TokenRefresher.
```

Less useful fork prompt:

```
/fork improve the auth code
```

The second prompt will produce N variants, but "improved auth code" with no scope or success criteria will tend to produce superficially different but comparably vague results.

### Start with `defaultCount: 2` for A/B comparisons

When you already have two approaches in mind, set `defaultCount: 2` and phrase your prompt to describe both strategies. The agent will pick one per fork and execute it differently. Two forks is easier to compare than three and costs less.

```json
"sidecar.fork.defaultCount": 2
```

### Commit before forking

Fork never touches your main tree, but it's still good practice to start from a clean `HEAD`. This ensures the diff each fork produces is exactly the change set you're evaluating, not a mix of the fork's changes and pre-existing uncommitted edits.

```bash
git add -A && git commit -m "wip: before fork"
```

### Use `/fork` for design decisions, not debugging

Fork is a comparison tool for situations with multiple valid approaches. It's not well-suited to debugging, where there's one correct answer and the question is finding it. For debugging, a single agent run with `/bg` or a direct agent task is faster.

### Check the skipped count in the review

If the review opens with fewer forks than you dispatched, check the info message. Forks can be skipped because they errored (the agent loop threw), timed out, or completed without producing any file changes. A fork that produced no diff isn't necessarily a failure — the agent may have concluded no changes were needed — but it's worth knowing before you pick a "winner" from a partial set.

### Model Arena agent mode is Fork with model variance

If you want to compare the same task across different models rather than N runs of the same model, use `/arena agent <task>`. This drives the Fork review UI with per-model labels instead of "Fork 1 / Fork 2 / Fork 3," and updates ELO ratings when you pick the winner. See [Slash Commands — Model Arena](slash-commands#model-arena-new-in-v090).
