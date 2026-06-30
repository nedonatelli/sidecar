---
title: Plan Mode
layout: docs
nav_order: 13
nav_section: "Guides"
---

# Plan Mode

Plan Mode inserts a review checkpoint between the moment you submit a task and the moment the agent touches any files. The agent reads your codebase, designs an implementation approach, and presents a numbered plan. You approve it, request revisions, or reject it — execution only begins after you say go.

---

## What Plan Mode does

When `sidecar.agentMode` is `plan`, the agent loop runs in two distinct phases:

**Phase 1 — exploration and planning.** The agent gets read-only tool access: it can read files, search, grep, check diagnostics, and walk the symbol graph. It cannot write or edit anything. It uses this read pass to understand the codebase, identify relevant patterns, and design an approach. When it's ready, it formats the plan and hands it back to you.

**Phase 2 — execution.** After you approve the plan, execution runs in cautious mode — the same diff-preview flow you'd get with a normal agent run. Each file write opens a diff editor for your review.

The key detail: tool calls are stripped entirely from the first iteration. The model cannot call `write_file` or `edit_file` on turn 1 even if it tries, because the tool definitions are not sent. The plan is always produced before a single byte of your files changes.

### What the plan contains

The plan format is structured by the system prompt so output is consistent across models:

```
## Plan: <brief title>

1. **Step name** — description, which files to touch
2. **Step name** — next action
...

### Risks & Considerations
- Edge cases, dependencies between steps, anything worth calling out

### Estimated Scope
- Files to modify: list
- New files: list if any
- Tests needed: yes/no and which
```

A concrete example for "add GitHub OAuth callback":

```
## Plan: add GitHub OAuth callback handler

1. **Add callback route** — create `src/routes/auth/github-callback.ts`,
   wire `POST /auth/github/callback` in `src/routes/index.ts`.
2. **Exchange code for token** — call GitHub `/login/oauth/access_token`
   with `client_id`/`client_secret`/`code` from `.env`.
3. **Create or update user** — look up by GitHub id in `users` table via
   `src/db/users.ts`; insert if missing.
4. **Issue session cookie** — sign a JWT with `src/auth/jwt.ts#signSession`
   and set `Set-Cookie: sid=<jwt>; HttpOnly; Secure`.
5. **Test the flow** — add `tests/routes/auth-github-callback.test.ts`
   covering success, missing-code, and existing-user paths.

### Risks & Considerations
- Secret `GITHUB_CLIENT_SECRET` must be loaded from env, not hardcoded.
- Race between concurrent callbacks is handled by a unique index on `users.github_id`.

### Estimated Scope
- Files to modify: `src/routes/index.ts`
- New files: `src/routes/auth/github-callback.ts`,
  `tests/routes/auth-github-callback.test.ts`
- Tests needed: yes
```

This is the artifact you review before approving.

---

## Enabling Plan Mode

### Option 1 — settings JSON

```json
{
  "sidecar.agentMode": "plan"
}
```

`agentMode: "plan"` persists across sessions.

### Option 2 — the mode dropdown

Open the chat header and click the mode dropdown (shows the current mode — **Cautious** by default). Select **Plan** from the list. The change takes effect on the next message you send.

### Option 3 — ask without changing settings

You don't need to enable the setting to get planning behavior. Ask the agent directly:

```
Before making any changes, write out your plan. Don't touch any files until I approve.
```

This works in any mode. The difference is that Plan Mode enforces the constraint mechanically — the model cannot call write tools on turn 1 regardless of what it decides. Asking in prose relies on the model following instructions, which most capable models do but is not guaranteed.

---

## The plan-then-execute flow

Here is what happens step by step once you're in Plan Mode and send a task:

**1. You send the task.** The agent loop starts with `approvalMode: 'plan'`. Tool definitions for write/edit operations are withheld from the first LLM call.

**2. The agent explores.** Read-only tools (`read_file`, `grep`, `search_files`, `project_knowledge_search`, `get_diagnostics`, `git_diff`) are available. The agent reads the files it needs to understand the task.

**3. The plan appears.** Once the agent has enough context, it produces the structured plan and sends it back. A **Plan Ready** card appears in the chat panel — not an assistant message, a dedicated review UI.

**4. You review.** Read through the steps. Check that the files listed match what you expect. Verify the agent hasn't misunderstood the scope.

**5a. You approve.** Click **Execute Plan**. The agent executes each step in order, opening diff previews for each file write as it goes. Plan mode is temporarily switched off for the execution run, then restored — so your setting persists.

**5b. You request revisions.** Type feedback into the revision input, e.g. "Step 3 should update the `users` table instead of `accounts`" or "We use `pino` for logging, not `console.log`". The agent revises the plan and presents a new version. You can revise multiple times before approving.

**5c. You reject.** Dismiss the plan card. Nothing was written. Start over with a different task or different approach.

### Requesting revisions without starting over

The revision flow passes your feedback back to the agent as a follow-up turn. The agent keeps the original task in context, adjusts only what you called out, and reproduced a revised plan. You can iterate freely — each revision round costs one LLM call but nothing touches disk.

Effective revision feedback is specific:

- "Use `src/auth/session.ts#createSession` instead of `signSession` — that function was renamed in v0.4."
- "Don't touch `src/routes/index.ts` — we use a file-based router, routes are auto-discovered."
- "Combine steps 2 and 3 into a single database transaction."
- "The scope estimate is wrong — `users.ts` exports a `findOrCreate` helper, no need to split the lookup."

Vague feedback like "this looks wrong" produces a vague revision. Point to the specific step and the specific problem.

---

## Auto-triggering Plan Mode

For tasks that clearly involve significant scope, SideCar auto-activates Plan Mode even if you haven't enabled the setting. The trigger conditions are:

- The message contains keywords associated with multi-file work: `refactor`, `migrate`, `restructure`, `reorganize`, `across`, `multiple files`, `update all`, etc.
- The message contains architectural-scope keywords: `architecture`, `overhaul`, `complete rewrite`, `breaking change`, `end-to-end`, `comprehensive`.
- The message is very long (over 400 words or 2,500 characters).
- The conversation is already deep (more than 5 turns) and the new request is substantial (over 150 words).

If the message already contains a bullet list or numbered list — meaning you've done your own planning — auto-triggering is suppressed.

Auto-triggered plan mode uses the same plan-then-execute flow. You still get the Plan Ready card and the same approve/revise/reject choices.

---

## When Plan Mode pays off

**Complex multi-file changes.** When a task touches 4+ files across different layers (routes, models, tests, docs), the wrong approach at the top cascades into wrong implementations everywhere. Reviewing a five-step plan takes 30 seconds. Unwinding five files of wrong implementation takes much longer.

**Unfamiliar codebases.** If you're working in a project you haven't touched before, the plan reveals whether the agent found the right entry points. A plan that says "create `src/handlers/auth.ts`" when the project uses `src/controllers/` tells you the agent missed the convention — you catch it before it writes 200 lines into the wrong directory.

**Tasks with irreversible steps.** Database migrations, schema changes, anything that writes to `.env`, anything that modifies build configuration — these are easy to approve one-at-a-time on a plan card and much harder to safely reverse after the fact. Plan Mode gives you a checkpoint before any of them run.

**When the task is ambiguous.** If you're not sure how to describe the task precisely, let the agent plan first. The plan forces it to make its interpretation concrete. If the plan doesn't match your intent, revise the plan — it's cheaper than running the wrong code.

**When you want to understand before you approve.** Plan Mode is not just a safety mechanism. It's also a learning tool. Reading a plan for a codebase you're onboarding to is a fast way to understand how pieces fit together.

### When Plan Mode adds unnecessary overhead

For short, self-contained tasks — fix this typo, add a missing import, rename this variable — Plan Mode adds an extra LLM round-trip for no real benefit. The risk profile is low and you'd see the change in the diff preview anyway. Toggle it off for quick edits and back on for anything substantial.

---

## Plan Mode vs other safe modes

| | **Plan Mode** | **Cautious (default)** | **Review Mode** | **Shadow Workspaces** |
|---|---|---|---|---|
| **When you see changes** | Before any tool call | Per write, as diff preview | After the full run, as batch | After the full run, via `git apply` |
| **Granularity** | Whole-plan approval | Per-file approval | Per-file approval | Whole-diff accept/reject |
| **Disk writes during run** | Zero (plan phase) | Each write on approval | Zero (buffered) | Zero (shadow worktree) |
| **Can revise before writing** | Yes — revise the plan | No — each write is independent | No — post-run only | No — post-run only |
| **Extra LLM cost** | One planning turn | None | None | None |
| **Requires git** | No | No | No | Yes |
| **Best for** | Complex tasks where wrong approach is costly | Normal development | Multi-file refactors you want to audit before landing | Tasks where you want a clean git diff |

### Combining Plan Mode with Shadow Workspaces

Plan Mode and Shadow Workspaces address different risks and stack cleanly:

- **Plan Mode** catches the wrong-approach problem before any writes. You review the strategy.
- **Shadow Workspaces** catch the wrong-implementation problem after writes. The agent runs in an isolated git worktree; nothing touches your main tree until you accept the diff.

Together, they give you two checkpoints: strategy review before execution, diff review after execution. For high-stakes tasks — major refactors, schema migrations, anything you'd want a clean revert path for — enable both:

```json
{
  "sidecar.agentMode": "plan",
  "sidecar.shadowWorkspace.mode": "always"
}
```

The flow becomes: plan → approve → execute in shadow → diff review → accept or discard.

---

## Practical tips

**Plan Mode adds one LLM turn, not one LLM run.** The planning turn is a read-pass — no writes, typically fewer tokens than a full execution turn. On a large task the cost is negligible. On a trivial task it's wasteful.

**You can always ask without enabling the setting.** The most portable pattern:

```
Before making any changes, write out your plan step by step.
Don't touch any files until I tell you to proceed.
```

This works in any mode with any model. The difference from enabling Plan Mode is enforcement: with the setting, tool definitions are mechanically withheld. With the instruction, you're relying on the model's instruction-following.

**Use the revision round to inject facts the agent doesn't know.** If the plan references a function that was renamed, or misses a shared helper that already exists, the revision round is the right time to correct it. Add the fact once in the revision; the agent incorporates it into the revised plan and carries it through execution.

**Approve means cautious mode, not autonomous.** After you approve a plan, execution runs in cautious mode — each file write still opens a diff preview. If you want to skip the per-file review and trust the plan, switch to autonomous mode before clicking Execute Plan.

**Verbose mode shows the plan-phase tool calls.** Enable `sidecar.verboseMode` to see exactly which files the agent read during the planning phase, which symbol searches it ran, and how it built up its understanding before producing the plan.
