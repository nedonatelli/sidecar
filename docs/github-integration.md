---
title: GitHub Integration
layout: docs
nav_order: 6
nav_section: 'Agent'
---

# GitHub Integration

SideCar has first-class Git and GitHub support — tools the agent uses autonomously during task execution, slash commands for manual operations, and settings for PR defaults and branch protection.

---

## Git agent tools

Ten dedicated Git tools are available to the agent at all times:

| Tool                 | Approval | Description                                                           |
| -------------------- | -------- | --------------------------------------------------------------------- |
| `git_status`         | Auto     | Show working tree status                                              |
| `git_diff`           | Auto     | Show diffs (staged, unstaged, or between refs)                        |
| `git_log`            | Auto     | View commit history                                                   |
| `git_search_history` | Auto     | Search git history by keyword, author, or date range (pickaxe + grep) |
| `git_stage`          | Confirm  | Stage files (`git add`)                                               |
| `git_commit`         | Confirm  | Create a commit                                                       |
| `git_push`           | Confirm  | Push to remote                                                        |
| `git_pull`           | Confirm  | Pull from remote                                                      |
| `git_branch`         | Confirm  | Create, switch, or list branches                                      |
| `git_stash`          | Confirm  | Stash or pop changes                                                  |

**Confirm** means SideCar asks before the tool runs, in Cautious and Manual modes: an approval card in the chat, or a native modal when the chat view is hidden so the card would go unseen. Autonomous mode runs these without asking, except a destructive operation such as a force push, which always asks you to type to confirm.

### What a push approval shows

The approval for `git_push`, or for a `git push` through `run_command`, names where the push goes before you allow it: the remote and its URL, whether the GitHub repository is **public** (asked of the GitHub API, with your token when one is configured), the target branch and whether it is new, and the commits and diffstat that remote does not have yet. `git_push` pushes to the branch's upstream remote, so a branch that tracks a private mirror stays there.

### Branch protection awareness (v0.99+)

Before `git_push`, SideCar checks the branch protection rules for the target branch. If direct pushes are blocked, the push is aborted and the agent is told to create a PR instead. Configure via:

```json
"sidecar.pr.branchProtection.enabled": true,
"sidecar.pr.branchProtection.warnEvenIfPassing": false
```

Requires a GitHub token with `repo` scope.

---

## Commit message generation

### `/commit` slash command

Type `/commit` in chat. SideCar:

1. Reads the current diff (staged + unstaged)
2. Generates a conventional commit message
3. Stages all changes and creates the commit

Commits include a `Co-Authored-By: SideCar` trailer.

### `/commit-message`

Generates a commit message from your staged changes (or, with nothing staged, your unstaged changes) without creating the commit. A notification shows the first line and offers **Copy to Clipboard** or **Edit & Copy** — useful when you want to tweak the message before committing yourself.

### Command palette

`SideCar: Generate Commit Message` (`Cmd+Shift+P`) is the same as `/commit-message`: it drafts the message and offers to copy it, and never commits. Neither `/commit` nor this command pushes.

---

## Pull request workflow

### Creating a PR

```
/pr
```

SideCar reads the branch diff against the base branch, generates a PR title and description (respecting `.github/pull_request_template.md` if present), and creates the PR as a draft by default.

Configure defaults:

```json
"sidecar.pr.create.draftByDefault": true,
"sidecar.pr.create.baseBranch": "auto",
"sidecar.pr.create.template": "auto"
```

`baseBranch: "auto"` resolves the remote's default branch via git. `template: "auto"` reads `.github/pull_request_template.md` and asks the model to fill each section.

### `/pr-summary`

Generate a PR summary from your uncommitted changes (`git diff HEAD`) without opening a PR. The result opens as a Markdown document in an editor tab, not in chat. It does not read the branch-range diff; `/pr` does that when it drafts the real description.

### Checking CI

```
/pr-ci
```

Uses `check_pr_ci` to fetch the CI status for the current PR — shows the state of each check (passing, failing, pending) and which jobs failed.

**Analyze a CI failure:**

```
/ci
```

The `analyze_ci_failure` tool fetches the failing GitHub Actions log, windows to the relevant error region, and proposes a fix. See [Configuration → CI Failure Analysis](configuration#ci-failure-analysis-v099).

### Marking ready

```
/pr-ready
```

Calls `mark_pr_ready` to promote a draft PR to ready-for-review.

---

## Code review

### Reviewing incoming PRs

```
/review
```

Reviews your **uncommitted changes** (`git diff HEAD`, staged and unstaged) for bugs, security issues, performance problems and edge cases, and opens the findings as a Markdown document in an editor tab. It does not review a PR branch against its base, and it uses its own fixed reviewer prompt, so SIDECAR.md is not applied. To review a PR branch, check it out and run `SideCar: Post PR Review with Inline Comments (Agent)`, which hands the agent `origin/<base>...HEAD` and posts the review on GitHub.

For a deeper security pass, dispatch the `security-reviewer` facet:

```
SideCar: Facets: Dispatch Specialists → security-reviewer
```

### Posting inline comments

The agent has three GitHub review tools:

| Tool               | Description                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| `create_pr_review` | Post a complete review in one call: summary body, `event` and inline comments on specific lines |
| `reply_pr_comment` | Reply to an existing review thread                                                              |
| `submit_pr_review` | Post a separate top-level review (body + `event`, no inline comments)                           |

`event` is `COMMENT` (the default), `APPROVE` or `REQUEST_CHANGES`. All three tools require approval in Cautious and Manual modes. The agent uses them when asked to "leave a review on this PR" or "comment on line 42 of auth.ts".

### Responding to PR comments

```
/pr-respond
```

Reads the review threads on the current PR (all of them, resolved ones included) and generates replies or code changes for each one.

```
/review-comments
```

Opens the current PR's review threads — all of them, resolved ones included — in a Markdown preview and offers to send them to the agent.

---

## Slash command reference

| Command            | Description                                                  |
| ------------------ | ------------------------------------------------------------ |
| `/commit`          | Stage all changes and commit with a generated message        |
| `/commit-message`  | Generate a commit message and copy it, without committing    |
| `/pr`              | Create a pull request from the current branch                |
| `/pr-summary`      | Summarize uncommitted changes as a PR description draft      |
| `/pr-ci`           | Check CI status for the current PR                           |
| `/pr-ready`        | Mark a draft PR as ready for review                          |
| `/pr-respond`      | Generate responses to open PR review threads                 |
| `/review`          | Review uncommitted changes for bugs, security and edge cases |
| `/review-comments` | Show the current PR's review threads                         |
| `/ci`              | Analyze the latest failing CI run and propose a fix          |

---

## Configuration

| Setting                                         | Default  | Description                                                   |
| ----------------------------------------------- | -------- | ------------------------------------------------------------- |
| `sidecar.pr.create.draftByDefault`              | `true`   | Open new PRs as drafts                                        |
| `sidecar.pr.create.baseBranch`                  | `"auto"` | Base branch (`"auto"` resolves the remote default)            |
| `sidecar.pr.create.template`                    | `"auto"` | PR template handling (`"auto"` / `"ignore"` / path)           |
| `sidecar.pr.branchProtection.enabled`           | `true`   | Check branch protection before `git_push`                     |
| `sidecar.pr.branchProtection.warnEvenIfPassing` | `false`  | Include protection summary even when push is allowed          |
| `sidecar.ci.analysis.enabled`                   | `true`   | Enable `analyze_ci_failure` and `SideCar: Analyze CI Failure` |
| `sidecar.ci.analysis.jobFilter`                 | `["*"]`  | Glob patterns for CI job names to analyze                     |

---

## Setting a GitHub token

Some operations (`check_pr_ci`, `create_pr_review`, `mark_pr_ready`, branch protection checks) require a GitHub token with `repo` scope.

No manual token entry is needed: SideCar uses VS Code's built-in GitHub authentication provider — the first GitHub operation triggers the standard VS Code GitHub sign-in prompt (`repo` scope), and VS Code manages the token.

CI analysis uses the same VS Code GitHub sign-in; there is no separate token to configure.
