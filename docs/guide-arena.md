---
title: Model Arena
layout: docs
nav_order: 12
nav_section: 'Guides'
---

# Model Arena

Model Arena lets you stream the same prompt through 2–4 models side-by-side in a full-editor panel and vote on the best response. Each vote updates a local ELO leaderboard that persists across sessions, so you accumulate a data-backed ranking of which models work best for your actual tasks.

Two modes:

- **Chat mode** — compare chat responses. Useful for evaluating answer quality, reasoning depth, and tone.
- **Agent mode** — each model runs a full agent loop in its own isolated Shadow Workspace. Useful for coding benchmarks where you want to see the actual diff, not just prose.

---

## What the leaderboard measures

The rating system uses standard ELO with K=32 and a starting rating of 1200. When you vote for a winner after a round, every winner–loser pair gets updated independently using the formula:

```
E_a = 1 / (1 + 10^((R_b - R_a) / 400))
new_R_a = R_a + 32 * (1 - E_a)   # winner
new_R_b = R_b + 32 * (0 - E_b)   # loser
```

A three-way match produces three pairwise updates. Ratings are rounded to integers after each update. The leaderboard becomes reliable after roughly 10–15 matches per model; treat early ratings as directional, not definitive.

Ratings persist to `.sidecar/arena/elo.json` and accumulate across both chat and agent matches. They are not reset between VS Code sessions.

---

## Chat arena

### Launching

**From chat:**

```
/arena                          # QuickPick to select models
/arena llama3.2:3b,qwen3:8b    # pre-fill two models, skip QuickPick
/arena qwen3:8b,gemma4:4b,mistral:7b  # three-way match
```

**From the Command Palette:**

`SideCar: Open Model Arena (Chat)` — same as `/arena` with no arguments.

If your backend is reachable, the QuickPick lists every installed model with multi-select enabled (`Pick at least 2 models to compare`). If the backend is unreachable at launch time, you get a free-text fallback: enter model names separated by commas.

If you set `sidecar.arena.defaultModels`, the QuickPick is skipped entirely and those models open immediately.

Before the panel opens, SideCar runs a memory preflight check. At low RAM pressure (under 2 GiB free) you get a confirmation dialog. At critical pressure (under 1 GiB free) the launch is blocked. You can always check current RAM and GPU usage via the status bar memory indicator or `SideCar: Refresh Memory Stats`.

### The panel layout

The panel is a full-editor webview divided into:

- **Toolbar** — shows a pill badge per model (label + current ELO), a "Change models" button, and a mode indicator.
- **Lane columns** — one column per model, each with a header (model name, current ELO), a scrollable response area, and a vote button at the bottom.
- **ELO leaderboard bar** — a footer strip that shows all models that have ever appeared in the current session, sorted by rating, with wins and losses in parentheses. Updates live after every vote.
- **Prompt bar** — a resizable textarea (Enter sends, Shift+Enter adds a newline) with a Send button.

### Sending your first prompt

Type a prompt in the prompt bar and press Enter or click Send. All lanes stream in parallel — each model gets the same prompt at the same time. Responses render as plain streaming text with a spinner in the lane header while the model is generating. A checkmark replaces the spinner when the lane finishes. If a lane errors (model unreachable, context overflow, etc.), the error is shown inline in that lane and the vote button for that lane is disabled.

The Send button and textarea are disabled while streaming is in progress.

### Voting

Vote buttons (`👑 Best`) appear as soon as any lane produces its first token — you do not have to wait for all lanes to finish. Click the button in the column whose response you prefer. Once you vote:

- The winning lane's button turns green and shows `👑 Winner`.
- All vote buttons are disabled for that round.
- The ELO ratings update immediately: the winner gains points from every loser, each pair computed independently.
- The leaderboard bar and the pill badges both reflect the new ratings.
- The prompt bar re-enables for the next round.

You can only vote once per round. If you think both responses were equal, skip voting and send the next prompt — that round will not affect ratings.

### Multi-turn conversations

After voting, type another prompt and press Enter. The same models run again on the new prompt. Previous responses are cleared and fresh lanes are rendered for each new round. Conversation history is **not** maintained between rounds — each prompt is sent as a fresh single-turn exchange. This keeps comparisons clean: both models always see the same context.

To compare follow-up reasoning or multi-step problem-solving, compose your prompt to include the necessary context explicitly, or use agent mode where the full task scope is described upfront.

### Changing models mid-session

Click **Change models** in the toolbar at any time (even mid-stream — the in-flight requests are aborted). The model QuickPick re-opens. Select a new set and the panel reinitializes with the new models. ELO history for the previous models is preserved.

---

## Agent arena

Agent mode runs each model through a full agent loop against a coding task. Each model gets its own isolated Shadow Workspace branched off the current `HEAD`, so no writes touch your main working tree during the run. After all models finish, the Fork diff-review UI opens and you pick the winner's diff to apply.

### Launching

**From chat:**

```
/arena agent refactor the login module to use async/await
/arena agent add rate limiting to the API endpoints
```

**From the Command Palette:**

`SideCar: Open Model Arena (Agent Task)` — opens a model QuickPick followed by a task input box.

**With pre-filled models:**

If you pass model names in `sidecar.arena.defaultModels`, the model QuickPick is skipped and you go straight to the task prompt.

The same memory preflight runs as in chat mode. Agent mode starts multiple full agent processes concurrently, so the VRAM pressure check is more significant here — running three 8B models in parallel on 16 GB of unified memory will be tight.

### What happens during a run

1. Each model gets its own Shadow Workspace (a `git worktree` at `.sidecar/shadows/<task-id>/`).
2. All agent loops run in parallel with `approvalMode: 'autonomous'` — no per-tool approval prompts fire mid-run.
3. Tool-call events are tagged with a `fork-<n>:` prefix in the output stream.
4. When all agent loops complete (or fail), the Fork diff-review UI opens.

### Reviewing results and picking a winner

The review UI is the same QuickPick-driven flow used by `/fork`:

1. A QuickPick lists every completed fork by model label.
2. Select a fork to preview — `vscode.diff` opens showing that model's full patch against the current `HEAD`.
3. Confirm to apply the diff via `git apply --index`. The change lands as staged modifications in your main working tree.
4. Forks you do not select are discarded.

After you confirm a winner, SideCar updates ELO: the winning model beats every other model that produced a reviewable diff. A toast shows the winner's new rating:

```
Arena: qwen3:8b wins! ELO → 1218
```

If the diff-review is cancelled or no fork is accepted, no ELO update happens.

### Cost and time expectations

Agent mode is expensive. Each model runs a full agent loop — potentially 10–25 tool calls per model, each generating its own LLM output. For three models on a non-trivial task, expect:

- 3× the token consumption of a single agent run.
- 3× the wall-clock time (bounded by the slowest model if running concurrently).
- On paid backends (Anthropic, OpenRouter), 3× the API cost.

Use agent arena for benchmarks where the answer matters — not as a substitute for ordinary agent runs. A focused, well-scoped task like "add a missing null check in `src/auth/session.ts`" is a better benchmark than a vague task that produces very different diffs and makes comparison meaningless.

---

## The ELO leaderboard

### Where to see it

The leaderboard bar at the bottom of the Arena panel shows all models that have appeared in the current session, sorted by ELO descending. Each entry shows:

```
ELO:  qwen3:8b  1231  (8W 3L)    llama3.2:3b  1188  (3W 7L)    gemma4:4b  1201  (5W 5L)
```

The pill badges in the toolbar also show each model's current ELO inline.

Ratings update live after every vote — you see the new numbers immediately without reloading the panel.

### The storage file

Ratings are persisted to `.sidecar/arena/elo.json` in your workspace. The format is straightforward:

```json
{
  "ratings": {
    "qwen3:8b": 1231,
    "llama3.2:3b": 1188,
    "gemma4:4b": 1201
  },
  "wins": {
    "qwen3:8b": 8,
    "llama3.2:3b": 3,
    "gemma4:4b": 5
  },
  "losses": {
    "qwen3:8b": 3,
    "llama3.2:3b": 7,
    "gemma4:4b": 5
  },
  "totalMatches": 11
}
```

This file is inside `.sidecar/`, so it is workspace-specific. Different projects accumulate independent leaderboards — a model that ranks well for your Rust project may rank differently for a TypeScript one. If you want a cross-project leaderboard, you can manually merge the files or copy the file to a shared location.

The file is written after every vote and is human-editable if you want to reset a specific model's rating or seed the leaderboard with priors.

---

## Configuration

| Setting                       | Type     | Default | Description                                                                                                                                    |
| ----------------------------- | -------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `sidecar.arena.enabled`       | boolean  | `true`  | Master toggle. When `false`, `/arena` and both palette commands show an info toast instead of opening the panel.                               |
| `sidecar.arena.defaultModels` | string[] | `[]`    | Pre-populated model list. When non-empty, the QuickPick is skipped and these models are used directly. Example: `["llama3.2:3b", "qwen3:8b"]`. |

**Example: always compare the same two models:**

```json
"sidecar.arena.defaultModels": ["qwen3-coder:8b", "gemma4:4b"]
```

With this set, `/arena` opens the panel immediately with those two models — no picker.

---

## Practical tips

**Compare before upgrading.** Before pulling a new model version, run a few rounds of arena against the current version on your real workload prompts. The ELO delta gives you a concrete signal rather than relying on external benchmark numbers, which are often on tasks unlike yours.

**Use agent arena for coding benchmarks.** Chat arena is fast and cheap, but for coding tasks the only thing that matters is whether the diff actually works. Agent arena produces reviewable diffs — you can open the `vscode.diff` preview and check whether each model's output compiles and passes tests before you vote.

**Keep prompts focused.** Arena comparisons are most useful when the prompt is specific enough that "better" has a clear meaning. "Refactor the auth middleware to use `async/await` and eliminate the callback pyramid" gives you something concrete to evaluate. "Improve this file" does not.

**Run multiple rounds before drawing conclusions.** ELO with K=32 moves ratings roughly 20–25 points per match when models are evenly rated. After 3 rounds, a single rating is not stable. After 10–15 rounds on similar tasks, the leaderboard starts to reflect genuine relative capability for that task type.

**Separate task types.** A model that ranks well for prose explanation may rank poorly for code generation. Consider maintaining separate leaderboards (different workspaces, or manually editing `elo.json`) for different categories — documentation writing vs. refactoring vs. test generation.

**Watch memory before large agent arena runs.** Three 8B models loading concurrently can hit swap on machines with 16 GB RAM. The preflight check warns you, but if you dismiss the warning and Ollama OOMs mid-run, the forks that were in progress will error and you will get incomplete results. On memory-constrained machines, set `sidecar.fork.maxConcurrent` to `1` so models run sequentially instead of in parallel — the run takes longer but each model gets the full memory budget.
