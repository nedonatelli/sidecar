---
title: PR Review Workflow
layout: docs
nav_order: 6
nav_section: 'Guides'
---

# PR Review Workflow

This guide covers the full PR lifecycle in SideCar — from reviewing an incoming PR and posting inline comments, to creating your own PR, checking CI, and merging.

---

## Reviewing an incoming PR

### /review: your uncommitted changes

`/review` reviews **uncommitted changes**: SideCar collects `git diff HEAD` (staged and unstaged edits to tracked files) and runs the model over it. It does not diff a branch against its base, so checking out someone else's PR branch with a clean working tree gives it nothing to review — for that, see [Posting inline comments](#posting-inline-comments) below, which reviews `origin/<base>...HEAD`.

In SideCar chat:

```
/review
```

The review output opens as a Markdown document in a new editor tab. Each finding lists:

- File and line number
- Severity: `critical`, `warning`, or `suggestion`
- A description of the issue
- A suggested fix where applicable

The model focuses on bugs, security issues, performance problems, edge cases, and code quality — not style nitpicks unless they cause bugs.

You can also run `SideCar: Review Changes` from the Command Palette (`Cmd+Shift+P` / `Ctrl+Shift+P`) for the same effect.

### What /review checks

The reviewer prompt is direct: it reads the raw diff and asks the model to identify real problems. The system prompt instructs the model to "be thorough but concise" and "only flag real issues." You won't get a list of 40 suggestions about variable names.

`/review` never looks at a branch range. The branch-range diff (`origin/<baseBranch>...HEAD`, everything this branch changed against its base) is what `SideCar: Post PR Review with Inline Comments (Agent)` hands the agent.

### Customizing the review with SIDECAR.md

`/review` does not use SIDECAR.md: it replaces the system prompt with its own fixed reviewer prompt, and no section of SIDECAR.md is read for it. SIDECAR.md is injected into agent turns, so a checklist there applies when the **agent** reviews — `SideCar: Post PR Review with Inline Comments (Agent)`, `/pr-respond`, or a chat request such as "review my changes against the checklist". Add a section like this to `.sidecar/SIDECAR.md`:

```markdown
## Review checklist

When reviewing code, always check for:

- Database queries inside loops (N+1)
- Missing input validation on user-controlled fields
- Error paths that swallow exceptions silently
- API calls without timeout/retry
- New env vars that aren't documented in .env.example
```

Because SIDECAR.md sections support path scoping, you can also target specific parts of the codebase:

```markdown
## Auth review checklist

<!-- @paths: src/auth/**, src/middleware/auth** -->

- All routes behind this middleware must validate the JWT expiry claim
- Never log the raw token — only the sub claim
```

That section only activates when the agent is looking at files matching those globs, keeping the agent's prompt lean for unrelated changes.

Run `/init` once to generate a starter SIDECAR.md if you don't have one yet.

### Using the security-reviewer facet for a deeper pass

For a focused security audit, dispatch the built-in `security-reviewer` facet instead of running a plain `/review`. The `security-reviewer` facet uses a security-specialist persona and a read-only tool allowlist, so it reports findings rather than editing files.

From the Command Palette, run `SideCar: Facets: Dispatch Specialists`. Select `security-reviewer` from the multi-select QuickPick, enter the task (e.g. "security review of src/api/"), and press Enter. Its output streams into the chat panel and batch progress shows in the dispatch graphic. Because it makes no edits, there is no diff to review: when it finishes, its report opens as a Markdown document.

For a combined general + security pass in one batch:

1. Open Command Palette → `SideCar: Facets: Dispatch Specialists`
2. Select both `general-coder` and `security-reviewer`
3. Enter your task description

Both facets run in parallel (bounded by `sidecar.facets.maxConcurrent`, default 3). After both finish, `general-coder`'s diff goes to the review panel (Accept / Reject / Skip, with cross-facet file-overlap detection), and `security-reviewer`'s report opens as a Markdown document. A facet that failed, or produced no diff, is skipped in the review.

---

## Posting inline comments

### create_pr_review: posting findings to GitHub

When you want to post a formal code review directly on GitHub — with inline comments tied to specific lines — use the `sidecar.pr.postReview` command or let the agent call `create_pr_review` directly.

**Via command palette**: `SideCar: Post PR Review with Inline Comments (Agent)` (or configure a keybinding for `sidecar.pr.postReview`). SideCar resolves the open PR for your current branch, fetches its diff, and dispatches the agent with this task:

1. Read the diff and relevant source files for full context
2. Identify bugs, security concerns, style violations, and missing error handling
3. Call `create_pr_review` once with a summary body, an `event` type, and an array of inline `comments`

Each inline comment requires:

- `path` — the file path relative to the repo root
- `line` — the line number in the diff
- `body` — the comment text (specific and actionable, with a suggested fix)

The agent only comments on lines that are part of the diff or within 3 lines of a change — it won't reference unchanged code that isn't visible in the review context.

**Via agent chat directly**: If you want more control, describe what you want in chat:

```
Review PR #42 and post inline comments for any issues you find. Be conservative — only comment on real bugs and security problems, not style.
```

The agent calls `create_pr_review` and constructs the review. You can steer it mid-run if needed.

### submit_pr_review: approve, request changes, or comment

`create_pr_review` posts a complete review — summary body, event and inline comments — in one call; nothing is left pending. `submit_pr_review` posts a **separate** top-level review (a body and an event, no inline comments), typically the summary at the end of `/pr-respond`. Both take `event` as one of:

| Event             | When to use                                            |
| ----------------- | ------------------------------------------------------ |
| `APPROVE`         | PR looks good — no blocking issues                     |
| `REQUEST_CHANGES` | There are issues that must be fixed before merge       |
| `COMMENT`         | Leaving notes without a formal approve/reject decision |

When `/pr-respond` or `sidecar.pr.postReview` dispatches the agent, it defaults to `COMMENT` unless the agent determines a clear approve or request-changes verdict is warranted. You can override this by telling the agent explicitly:

```
Review PR #42. If everything looks clean, approve it. If there are security issues, request changes.
```

### reply_pr_comment: responding to specific threads

The `reply_pr_comment` tool posts a reply to an existing review thread. The agent uses it during `/pr-respond` to address each open thread individually. You can also invoke it directly:

```
Reply to thread 123456789 on PR #42: "Fixed — the null check is now in validateInput() before this call."
```

The agent needs the `comment_id` (the thread's root comment ID from the GitHub API). When you run `/pr-respond`, SideCar fetches the PR's review threads (resolved ones included — the GitHub API call it uses doesn't report resolution) and includes their IDs in the agent prompt automatically.

---

## Checking CI status

### /pr-ci: reading GitHub Actions results

Run `/pr-ci` in chat (or `SideCar: Check PR CI Status` from the Command Palette) to fetch a snapshot of all check runs for your branch's PR.

SideCar:

1. Resolves the current branch
2. Finds the open PR
3. Calls the GitHub Checks API for the PR's head SHA
4. Opens a Markdown preview showing each check, its status, and conclusion

Example output:

```
# CI Checks — PR #42: Add rate limiting to auth endpoints

Branch: `feature/rate-limit` — head SHA: `a3f91c2b`

❌ 2 check(s) failed

| Check             | Status    | Conclusion |
|-------------------|-----------|------------|
| test (ubuntu)     | completed | failure    |
| lint              | completed | success    |
| typecheck         | completed | success    |
| build             | completed | failure    |
```

If any checks have failed, SideCar automatically dispatches the agent to investigate. The agent gets the full check table plus a prompt to fetch workflow logs and diagnose the failures.

### analyze_ci_failure: diagnosing a failing check

Run `/ci` in chat (or `SideCar: Analyze CI Failure` from the Command Palette) for a deeper CI diagnosis pass. Unlike `/pr-ci` which reads check statuses, `/ci`:

1. Fetches the latest failed workflow run for your branch
2. Downloads the job logs for each failed job
3. Parses the logs with the structured failure extractor — extracting error messages, file/line references, and failure context blocks
4. Opens a Markdown preview with grouped, formatted failure blocks
5. Surfaces each failure as a VS Code diagnostic in the Problems panel (`source: sidecar-ci`), so you can click through directly to the offending file/line

After the preview opens, you're offered **Send to agent**. If you accept, the full failure summary is injected into the agent as a new turn and it begins diagnosing and patching. On any of these diagnostics, the lightbulb quick fix (`Cmd+.` / `Ctrl+.`) offers **Ask SideCar to fix this CI failure**, which runs `sidecar.ci.fixFromDiagnostic` and injects the failure message directly into chat:

```
Fix the CI failure: TypeError: Cannot read property 'id' of undefined at src/api/users.ts:87
```

The agent then reads the file, identifies the root cause, and proposes a fix.

---

## Creating a PR from your branch

### /pr: push and open a draft PR

When you're ready to open a PR, run `/pr` in chat (or `SideCar: Create Pull Request (Draft from Branch)` from the Command Palette). SideCar runs the full PR creation flow:

1. Confirms you're on a feature branch (not the base)
2. Resolves the base branch from `git symbolic-ref refs/remotes/origin/HEAD`, falling back to `main`
3. Fetches the branch-range diff
4. Checks branch protection rules on the base (required reviews, CI requirements, signed commits) and surfaces them in the preview
5. Generates a PR title (imperative mood, under 70 characters) and body
6. Opens the generated body in a Markdown preview tab
7. Shows a confirm modal: **Submit**, **Edit title**, or **Cancel**
8. Pushes the branch to origin with `-u` to set upstream tracking
9. Calls the GitHub API to create the PR

The confirm loop lets you edit the title before submitting — click "Edit title" and type a replacement. SideCar re-shows the modal with your updated title.

### Template handling

If your repo has a `.github/pull_request_template.md` (or `.github/PULL_REQUEST_TEMPLATE.md`), SideCar passes it to the model with the instruction to fill each section in place. The H2 structure is preserved; sections that don't apply get a short "(n/a)" note rather than being removed. If no template exists, the body uses standard sections: **Summary**, **Changes**, **Testing**, **Reviewer focus**.

### sidecar.pr.create.\* settings

| Setting                            | Default  | Description                                                                                              |
| ---------------------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `sidecar.pr.create.draftByDefault` | `true`   | Open PRs as drafts                                                                                       |
| `sidecar.pr.create.baseBranch`     | `"auto"` | Base branch: `"auto"` resolves via `origin/HEAD`, or set a fixed branch like `"develop"`                 |
| `sidecar.pr.create.template`       | `"auto"` | `"auto"` reads `.github/pull_request_template.md`; `"ignore"` skips it; an absolute path reads that file |

```json
"sidecar.pr.create.draftByDefault": false,
"sidecar.pr.create.baseBranch": "develop",
"sidecar.pr.create.template": "ignore"
```

If you always merge into `develop` rather than `main`, set `baseBranch` to `"develop"` so the diff and base branch are always correct.

### /pr-summary: title and body without pushing

If you want a draft description without creating a PR, use `/pr-summary` in chat (or `SideCar: Summarize Pull Request` from the Command Palette). Like `/review`, it works from your **uncommitted changes** (`git diff HEAD`), not the branch-range diff, and opens the result — a suggested title, summary bullets, impacted files and reviewer focus areas — as a Markdown document in an editor tab. No push, no API call.

This is useful for drafting a description for work you haven't committed yet. For a description of a committed branch, `/pr` generates one from the branch-range diff and shows it before anything is submitted.

---

## Marking ready and merging

### /pr-ready: draft to ready-for-review

When your draft PR is ready for human review, run `/pr-ready` in chat (or `SideCar: Mark PR Ready for Review` from the Command Palette). SideCar:

1. Finds the open PR for your current branch
2. Calls the GitHub API to convert draft → ready-for-review
3. Shows a confirmation toast: `PR #42 "Add rate limiting to auth endpoints" is now ready for review.`

If the PR is already marked ready, SideCar tells you that instead of re-calling the API.

### Branch protection awareness

When you create a PR via `/pr`, SideCar fetches the branch protection rules for the base branch and surfaces them in the preview. You'll see a block like:

```
> **Branch protection on `main`**
> - 1 required approving review
> - Required status checks: test, lint, typecheck
> - Signed commits required
```

This appears in the preview tab before you confirm, not in the PR body itself. It's informational — SideCar won't block the push based on protection rules, but it makes sure you see them before submitting.

For `git_push`, Cautious and Manual modes ask before pushing; Autonomous mode pushes without asking, except a force push, which always asks you to type to confirm. The approval shows the remote, its URL and the commits being pushed, so you can check where they go before confirming.

### /pr-respond: address all open review threads

After reviewers have commented on your PR, run `/pr-respond` in chat (or `SideCar: Respond to PR Comments (Agent)` from the Command Palette). SideCar:

1. Fetches the review threads on your branch's PR (all of them, resolved ones included)
2. Formats them as structured Markdown grouped by file
3. Dispatches the agent with a prompt to address each thread

For each thread the agent:

- Reads the file and line referenced in the diff hunk for full context
- Decides whether the reviewer's concern is valid
- If valid: makes the code change and calls `reply_pr_comment` explaining what changed
- If not applicable: calls `reply_pr_comment` with a concise explanation of why the existing approach is correct
- After all threads are addressed, calls `submit_pr_review` with a summary

In Cautious mode, the default, each `reply_pr_comment` and `submit_pr_review` call is an approval prompt, so you see every reply before it posts. In Autonomous mode the agent posts them without asking.

### /review-comments: read threads without responding

To read the current review comments without triggering a response pass, run `/review-comments` in chat. This opens the formatted thread view (every thread, resolved ones included) in a Markdown preview tab and offers (but doesn't require) a "Send to agent" option. Use it when you want to read what reviewers said before deciding how to respond.

---

## The full PR lifecycle — cheat sheet

| Step                                       | SideCar command / tool                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| Review your uncommitted changes            | `/review` or `SideCar: Review Changes`                                           |
| Deep security pass                         | Facets: `security-reviewer`                                                      |
| Post inline review comments to GitHub      | `SideCar: Post PR Review with Inline Comments (Agent)` (`sidecar.pr.postReview`) |
| Submit approve / request-changes / comment | `submit_pr_review` tool (called by agent during review)                          |
| Reply to a specific thread                 | `reply_pr_comment` tool or `/pr-respond`                                         |
| Read your PR's review threads              | `/review-comments`                                                               |
| Address all open review threads            | `/pr-respond`                                                                    |
| Check CI check status                      | `/pr-ci` or `SideCar: Check PR CI Status`                                        |
| Diagnose failing CI logs                   | `/ci` or `SideCar: Analyze CI Failure`                                           |
| Create a PR from your branch               | `/pr` or `SideCar: Create Pull Request (Draft from Branch)`                      |
| Draft a PR summary of uncommitted changes  | `/pr-summary` or `SideCar: Summarize Pull Request`                               |
| Move draft PR to ready-for-review          | `/pr-ready` or `SideCar: Mark PR Ready for Review`                               |
| Commit staged changes                      | `/commit`                                                                        |
| Push to remote                             | `git_push` tool (agent), asks first in Cautious and Manual modes                |
