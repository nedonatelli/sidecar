---
title: Auto Mode
layout: docs
nav_order: 3
nav_section: "Guides"
---

# Auto Mode

Auto Mode is a batch execution layer that works through a markdown task list unattended. You populate `.sidecar/backlog.md` with unchecked items, run the command, and SideCar picks each task in order, runs the full agent loop on it autonomously, marks it done on success, and logs any failures before moving on to the next one.

---

## What Auto Mode does

On each iteration the dispatcher:

1. Reads `.sidecar/backlog.md` and finds the first unchecked `- [ ]` item.
2. Wraps the task text in a system prompt instructing the agent to complete it and stop.
3. Runs `runAgentLoopInSandbox` in `autonomous` approval mode — no confirmation prompts mid-task.
4. If the agent loop returns without throwing, rewrites the backlog line to `- [x]` and streams a done notification to the chat panel.
5. If the agent loop throws, writes a structured entry to `.sidecar/logs/auto-mode-failures.md` and either halts (if `haltOnFailure` is `true`) or advances to the next item.
6. Waits for the inter-task cooldown, then repeats.

The session stops when all items are done, the task cap or runtime cap is reached, `haltOnFailure` triggers, or you click the status bar item to cancel.

---

## The backlog file

The default path is `.sidecar/backlog.md`. It is plain markdown. Only lines matching `- [ ] …` or `- [x] …` are treated as tasks; headings, prose, and blank lines are preserved verbatim when the file is written back.

### Example backlog

```markdown
# Sprint 24 backlog

## Bugs

- [x] Fix the off-by-one in pagination — page 2 returns 11 results instead of 10
- [ ] Replace deprecated `fs.exists` calls in src/util/fileHelpers.ts with `fs.access`
- [ ] Add missing null check before `user.profile.avatar` in ProfileCard component

## Features

- [ ] Implement rate-limit retry with exponential backoff in KickstandBackend — cap at 3 retries, 2s base delay
- [ ] Add `--json` flag to the `sidecar list-models` CLI command and write a test for the output shape
- [ ] Generate OpenAPI 3.1 spec from the existing route handlers in src/mcpServer/agentServer.ts

## Housekeeping

- [ ] Upgrade tree-sitter to latest and re-run grammar WASM builds
```

### Good tasks vs bad tasks

A good task is specific enough that the agent can determine on its own when it is done.

| Good | Bad |
|------|-----|
| Replace deprecated `fs.exists` calls in `src/util/fileHelpers.ts` with `fs.access` | Improve the file utilities |
| Add `--json` flag to `sidecar list-models` and write a Vitest test for the output shape | Add more CLI flags |
| Fix off-by-one in `src/pagination.ts` — page 2 returns 11 results, should return 10 | Fix bugs |
| Add null check before `user.profile.avatar` in `ProfileCard` (line 47) | Clean up the profile component |

Vague tasks produce agents that wander, exceed their iteration budget, and are more likely to touch unrelated files.

### Per-item sentinel annotations

You can pin overrides to individual items using `@key:value` tokens in the task text. The dispatcher strips them from the prompt before sending to the model.

| Sentinel | Values | Effect |
|----------|--------|--------|
| `@model:name` | any configured model id | Runs this task with the specified model; restores the previous model afterwards |
| `@shadowMode:always` | `always`, `opt-in`, `off` | Overrides `sidecar.shadowWorkspace.mode` for this task only |
| `@facets:id1,id2` | comma-separated facet ids | Dispatches named facets instead of the default agent loop |

Example:

```markdown
- [ ] Refactor the auth middleware to use the new JWT library @model:claude-opus-4-7 @shadowMode:always
- [ ] Run the security-auditor facet on src/mcpServer/ @facets:security-auditor
```

---

## Starting a session

Open the command palette and run **SideCar: Start Auto Mode** (`sidecar.startAutoMode`).

SideCar immediately:
- Resolves the backlog path (relative paths are joined to the workspace root).
- Creates an `AbortController` to govern the whole session.
- Starts the dispatcher loop, streaming each task's agent output to the chat panel in real time.

A spinning status bar item appears in the bottom-left corner showing **Auto Mode: task N/M**. Click it at any time to stop the session cleanly — the current task is cancelled at the next abort-check boundary and the session ends with `stoppedReason: 'cancelled'`.

To stop without clicking: run **SideCar: Stop Auto Mode** (`sidecar.stopAutoMode`) from the command palette.

Only one Auto Mode session can run at a time. Starting a second session while one is active shows a warning.

---

## Monitoring

### Chat panel

The chat panel streams all agent output for each task as it runs — tool calls, tool results, and text responses appear in order. Between tasks the panel shows a task-status update:

- **running** — task N of M has started.
- **done** — task completed; the backlog line has been marked `[x]`.
- **error** — task failed; see the failure log.

When the session ends, the panel shows the final summary: how many tasks succeeded, how many failed, and the reason the session stopped.

`stoppedReason` values and what they mean:

| Value | Meaning |
|-------|---------|
| `completed` | All pending items processed |
| `task-cap` | `maxTasksPerSession` reached |
| `runtime-cap` | `maxRuntimeMinutes` wall-clock limit reached |
| `halted-on-failure` | A task failed and `haltOnFailure` is `true` |
| `cancelled` | Stopped manually via status bar or command |

### Failure log

Failures are appended to `.sidecar/logs/auto-mode-failures.md`. Each entry looks like:

```markdown
## 2026-05-28T14:32:07.441Z

**Task:** Replace deprecated `fs.exists` calls in src/util/fileHelpers.ts with `fs.access`

**Error:** Agent exceeded max iterations without completing the task

---
```

The file is created on first failure; the directory is guaranteed to exist after extension activation. To retry a failed task, re-open the backlog, find the item (it stays unchecked on failure), fix the task description if needed, and run Auto Mode again.

### Inter-task cooldown as a stop window

By default there is a 30-second pause between tasks (`interTaskCooldownSeconds: 30`). During this window the session is idle and the abort signal is live. If you decide you want to stop after reviewing the previous task's result — but before the next one starts — click the status bar item or run Stop Auto Mode during the cooldown.

Set `interTaskCooldownSeconds: 0` only if you are confident in your backlog and running with Shadow Workspaces so failures can be discarded cleanly.

---

## Configuration

All settings are under `sidecar.autoMode.*`.

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.autoMode.backlogPath` | `.sidecar/backlog.md` | Path to the backlog file. Relative paths resolve from the workspace root. |
| `sidecar.autoMode.maxTasksPerSession` | `10` | Maximum items to attempt per session (1–100). Stops with `task-cap` when reached. |
| `sidecar.autoMode.maxRuntimeMinutes` | `240` | Wall-clock time limit in minutes (1–1440). Stops with `runtime-cap` when reached even if items remain. |
| `sidecar.autoMode.haltOnFailure` | `false` | When `true`, the session stops after the first failure. When `false`, failures are logged and the session continues. |
| `sidecar.autoMode.autoOpenPR` | `true` | Automatically draft a pull request after a session that ends with `completed`. Requires a configured remote. |
| `sidecar.autoMode.interTaskCooldownSeconds` | `30` | Seconds to wait between tasks. This is your safe window to stop before the next task starts. |

### Recommended: run with Shadow Workspaces

Auto Mode runs the agent loop in `autonomous` approval mode — it does not prompt for permission before editing files or running shell commands. The safest way to run it is with Shadow Workspaces enabled globally:

```json
"sidecar.shadowWorkspace.mode": "always"
```

With this setting each task runs in an isolated `git worktree` off the current `HEAD`. The agent's writes never touch your working tree until you accept the diff at the end of the task. If the task produces bad output, reject the diff and the repository is unchanged.

You can also override Shadow Workspace behavior per item using `@shadowMode:always` or `@shadowMode:off` sentinels.

---

## Cost estimation

When using a paid backend (Anthropic, OpenRouter, Groq, Fireworks), Auto Mode can consume tokens quickly because each task runs a full agent loop. Rough estimation:

```
total cost ≈ (tasks) × (avg iterations per task) × (avg tokens per iteration) × (price per token)
```

A modest task on a capable model (e.g. claude-sonnet-4-6) tends to run 3–8 agent iterations and consume 2 000–8 000 tokens per task. A 10-task session at 5 000 tokens average costs roughly:

```
10 × 5 000 = 50 000 tokens
50 000 × $0.000003 (output) ≈ $0.15 in output tokens
```

Input tokens (context + system prompt) typically run 3–5× the output count, so budget $0.60–$1.00 for a 10-task session on mid-tier cloud models.

### Set a daily budget as a safety net

```json
"sidecar.dailyBudget": 5.00
```

Agent runs are blocked once the daily spend limit is reached. Set `0` to disable. Check current spend with **SideCar: Show Session Spend** from the command palette.

Local models (Ollama, Kickstand) have no per-token cost — the session length is limited only by your time and compute.

---

## After the session

### If autoOpenPR is enabled

When the session ends with `completed`, SideCar automatically drafts a pull request using the `draftPullRequest` flow. The PR description is generated by the agent. Review it in the chat panel output and on GitHub/GitLab before merging.

### Reviewing failed tasks

1. Open `.sidecar/logs/auto-mode-failures.md`.
2. For each failed task, read the error message to understand what went wrong.
3. If the task description was too vague, sharpen it in the backlog.
4. If the agent hit an iteration cap, consider splitting the task into smaller steps.
5. Failed items remain unchecked in the backlog — run Auto Mode again to retry them.

---

## Best practices

**Keep tasks small and specific.** Each item should be completable in 3–10 agent iterations. If you find tasks regularly hitting the iteration cap, split them.

**Use Shadow Workspaces.** Set `sidecar.shadowWorkspace.mode: "always"`. The overhead is one extra `git worktree add` per task. The safety gain is large: every task's writes are isolated and reviewable before they touch your branch.

**Set `haltOnFailure: true` for critical batches.** If later tasks in your backlog depend on the output of earlier ones (e.g., a refactor that must pass before tests can be updated), stop on the first failure rather than letting the session drift into broken state.

**Limit task-cap and runtime for first runs.** Start with `maxTasksPerSession: 3` and watch the chat panel. Once you trust your backlog format and the agent's behavior on your codebase, raise the cap.

**Annotate high-risk tasks.** Tasks that touch security-sensitive code, database migrations, or public APIs are good candidates for `@shadowMode:always` and `@model:<capable-model>` to route them to a stronger model with full diff isolation.

**Review the backlog before starting.** Auto Mode runs immediately on invocation. Ensure the file contains only the tasks you want processed now — mark anything you want to skip as `- [x]` temporarily, or move it below a `## Later` heading (prose lines are ignored).
