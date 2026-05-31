---
title: PR Review Workflow
layout: docs
nav_order: 22
---

# PR Review Workflow

This guide covers the full PR lifecycle in SideCar — from reviewing an incoming PR and posting inline comments, to creating your own PR, checking CI, and merging.

---

## Reviewing an incoming PR

### Fetch the branch and run /review

Check out the branch you want to review, then type `/review` in the SideCar chat panel. SideCar collects the full `git diff` against the working tree (staged and unstaged) and runs the model over it.

```
git fetch origin
git checkout feature/some-branch
```

Then in SideCar chat:

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

For a branch-range diff (everything this branch changed against its base), SideCar uses the diff between `origin/<baseBranch>...HEAD` so you see the cumulative change rather than just the last commit.

### Customizing the review with SIDECAR.md

You can add your own review checklist to `.sidecar/SIDECAR.md`. SideCar injects this file into the system prompt for every agent turn, including reviews. Add a section like this:

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

That section only activates when the agent is looking at files matching those globs, keeping the review prompt lean for unrelated changes.

Run `/init` once to generate a starter SIDECAR.md if you don't have one yet.

### Using the security-reviewer facet for a deeper pass

For a focused security audit, dispatch the built-in `security-reviewer` facet instead of running a plain `/review`. The `security-reviewer` facet uses a security-specialist persona, a security-tuned tool allowlist, and runs in its own Shadow Workspace so nothing touches your main tree.

From the Command Palette, run `SideCar: Facets: Dispatch Specialists`. Select `security-reviewer` from the multi-select QuickPick, enter the task (e.g. "security review of src/api/"), and press Enter. The facet runs autonomously and produces a diff review at the end.

For a combined general + security pass in one batch:

1. Open Command Palette → `SideCar: Facets: Dispatch Specialists`
2. Select both `general-coder` and `security-reviewer`
3. Enter your task description

Both facets run in parallel (bounded by `sidecar.facets.maxConcurrent`, default 3). The batch review UI fires once after both finish, showing each facet's findings with cross-facet file-overlap detection.

---

## Posting inline comments

### create_pr_review: posting findings to GitHub

When you want to post a formal code review directly on GitHub — with inline comments tied to specific lines — use the `sidecar.pr.postReview` command or let the agent call `create_pr_review` directly.

**Via command palette**: `SideCar: Post PR Review` (or configure a keybinding for `sidecar.pr.postReview`). SideCar resolves the open PR for your current branch, fetches its diff, and dispatches the agent with this task:

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

The `submit_pr_review` tool (and its corresponding agent invocation) submits a pending review with one of three events:

| Event | When to use |
|-------|-------------|
| `APPROVE` | PR looks good — no blocking issues |
| `REQUEST_CHANGES` | There are issues that must be fixed before merge |
| `COMMENT` | Leaving notes without a formal approve/reject decision |

When `/pr-respond` or `sidecar.pr.postReview` dispatches the agent, it defaults to `COMMENT` unless the agent determines a clear approve or request-changes verdict is warranted. You can override this by telling the agent explicitly:

```
Review PR #42. If everything looks clean, approve it. If there are security issues, request changes.
```

### reply_pr_comment: responding to specific threads

The `reply_pr_comment` tool posts a reply to an existing review thread. The agent uses it during `/pr-respond` to address each open thread individually. You can also invoke it directly:

```
Reply to thread 123456789 on PR #42: "Fixed — the null check is now in validateInput() before this call."
```

The agent needs the `comment_id` (the thread's root comment ID from the GitHub API). When you run `/pr-respond`, SideCar fetches all open threads and includes their IDs in the agent prompt automatically.

---

## Checking CI status

### /pr-ci: reading GitHub Actions results

Run `/pr-ci` in chat (or `SideCar: Check PR CI` from the Command Palette) to fetch a snapshot of all check runs for your branch's PR.

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

After the preview opens, you're offered "Send to agent for fix." If you accept, the full failure summary is injected into the agent as a new turn and it begins diagnosing and patching. You can also click any diagnostic in the Problems panel to trigger `sidecar.ci.fixFromDiagnostic`, which injects the failure message directly into chat:

```
Fix the CI failure: TypeError: Cannot read property 'id' of undefined at src/api/users.ts:87
```

The agent then reads the file, identifies the root cause, and proposes a fix.

---

## Creating a PR from your branch

### /pr: push and open a draft PR

When you're ready to open a PR, run `/pr` in chat (or `SideCar: Create Pull Request` from the Command Palette). SideCar runs the full PR creation flow:

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

### sidecar.pr.create.* settings

| Setting | Default | Description |
|---------|---------|-------------|
| `sidecar.pr.create.draftByDefault` | `true` | Open PRs as drafts |
| `sidecar.pr.create.baseBranch` | `"auto"` | Base branch: `"auto"` resolves via `origin/HEAD`, or set a fixed branch like `"develop"` |
| `sidecar.pr.create.template` | `"auto"` | `"auto"` reads `.github/pull_request_template.md`; `"ignore"` skips it; an absolute path reads that file |

```json
"sidecar.pr.create.draftByDefault": false,
"sidecar.pr.create.baseBranch": "develop",
"sidecar.pr.create.template": "ignore"
```

If you always merge into `develop` rather than `main`, set `baseBranch` to `"develop"` so the diff and base branch are always correct.

### /pr-summary: title and body without pushing

If you want to preview the generated PR description without creating the PR yet, use `/pr-summary` in chat (or `SideCar: Summarize PR` from the Command Palette). It generates the title and body from the branch-range diff and opens a Markdown preview — no push, no API call.

This is useful for drafting the description in advance, copying it into an existing PR, or checking how the model summarizes a large diff before committing to it.

---

## Marking ready and merging

### /pr-ready: draft to ready-for-review

When your draft PR is ready for human review, run `/pr-ready` in chat (or `SideCar: Mark PR Ready` from the Command Palette). SideCar:

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

For `git_push`, the agent always requests approval before pushing (it's a destructive tool). The approval modal shows the full push command so you can verify the branch and remote before confirming.

### /pr-respond: address all open review threads

After reviewers have commented on your PR, run `/pr-respond` in chat (or `SideCar: Respond to PR Comments` from the Command Palette). SideCar:

1. Fetches all open review threads for your branch's PR
2. Formats them as structured Markdown grouped by file
3. Dispatches the agent with a prompt to address each thread

For each thread the agent:
- Reads the file and line referenced in the diff hunk for full context
- Decides whether the reviewer's concern is valid
- If valid: makes the code change and calls `reply_pr_comment` explaining what changed
- If not applicable: calls `reply_pr_comment` with a concise explanation of why the existing approach is correct
- After all threads are addressed, calls `submit_pr_review` with a summary

The agent handles the full response pass autonomously. If you want to review its proposed replies before they post, switch to Cautious mode before running `/pr-respond` — you'll see each `reply_pr_comment` and `submit_pr_review` call as an approval prompt.

### /review-comments: read threads without responding

To read the current review comments without triggering a response pass, run `/review-comments` in chat. This opens the formatted thread view in a Markdown preview tab and offers (but doesn't require) a "Send to agent" option. Use it when you want to read what reviewers said before deciding how to respond.

---

## The full PR lifecycle — cheat sheet

| Step | SideCar command / tool |
|------|------------------------|
| Review incoming PR diff | `/review` or `SideCar: Review Changes` |
| Deep security pass | Facets: `security-reviewer` |
| Post inline review comments to GitHub | `SideCar: Post PR Review` (`sidecar.pr.postReview`) |
| Submit approve / request-changes / comment | `submit_pr_review` tool (called by agent during review) |
| Reply to a specific thread | `reply_pr_comment` tool or `/pr-respond` |
| Read your PR's open threads | `/review-comments` |
| Address all open review threads | `/pr-respond` |
| Check CI check status | `/pr-ci` or `SideCar: Check PR CI` |
| Diagnose failing CI logs | `/ci` or `SideCar: Analyze CI Failure` |
| Create a PR from your branch | `/pr` or `SideCar: Create Pull Request` |
| Preview PR title + body only | `/pr-summary` or `SideCar: Summarize PR` |
| Move draft PR to ready-for-review | `/pr-ready` or `SideCar: Mark PR Ready` |
| Commit staged changes | `/commit` |
| Push to remote | `git_push` tool (agent), always requires approval |
