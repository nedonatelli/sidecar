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

**Confirmation** means a native blocking modal appears before the tool executes — you can't miss it even while scrolled away from the chat panel.

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

Generates and shows the commit message text without creating the commit — useful when you want to tweak the message before committing.

### Command palette

Run `SideCar: Generate Commit Message` (`Cmd+Shift+P`) to generate a message from your current diff and commit immediately.

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

Generate a PR description from the current diff without opening a PR. Useful for drafting the description in chat before creating the PR.

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

Fetches the changed files, runs an adversarial review pass (bugs, security, style), and posts findings to the chat. Customise the review criteria by adding a `## Code Review` section to your `SIDECAR.md`.

For a deeper security pass, dispatch the `security-reviewer` facet:

```
SideCar: Facets: Dispatch Specialists → security-reviewer
```

### Posting inline comments

The agent has three GitHub review tools:

| Tool               | Description                                                          |
| ------------------ | -------------------------------------------------------------------- |
| `create_pr_review` | Create a pending review with inline comments on specific lines       |
| `reply_pr_comment` | Reply to an existing review thread                                   |
| `submit_pr_review` | Submit the pending review as APPROVED, CHANGES_REQUESTED, or COMMENT |

All three require confirmation before executing. The agent uses them when asked to "leave a review on this PR" or "comment on line 42 of auth.ts".

### Responding to PR comments

```
/pr-respond
```

Reads open review threads on the current PR and generates replies or code changes for each one.

```
/review-comments
```

Lists all unresolved review comments on the current PR.

---

## Slash command reference

| Command            | Description                                                      |
| ------------------ | ---------------------------------------------------------------- |
| `/commit`          | Stage all changes and commit with a generated message            |
| `/commit-message`  | Generate a commit message without committing                     |
| `/pr`              | Create a pull request from the current branch                    |
| `/pr-summary`      | Generate a PR description without creating the PR                |
| `/pr-ci`           | Check CI status for the current PR                               |
| `/pr-ready`        | Mark a draft PR as ready for review                              |
| `/pr-respond`      | Generate responses to open PR review threads                     |
| `/review`          | Review the current git diff for bugs, security, and style issues |
| `/review-comments` | List open review comments on the current PR                      |
| `/ci`              | Analyze the latest failing CI run and propose a fix              |

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

For CI analysis, a token with `actions:read` scope is sufficient.
