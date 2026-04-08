---
title: GitHub Integration
layout: docs
nav_order: 11
---

# GitHub Integration

SideCar has built-in Git tools and GitHub operations accessible through the agent and slash commands.

## Git tools

The agent has 9 dedicated Git tools it can use during the agent loop:

| Tool | Description |
|------|-------------|
| `git_status` | Show working tree status |
| `git_stage` | Stage files for commit (`git add`) |
| `git_commit` | Create a commit with a message |
| `git_log` | View commit history |
| `git_push` | Push to remote |
| `git_pull` | Pull from remote |
| `git_branch` | Create, switch, or list branches |
| `git_stash` | Stash or pop changes |
| `git_diff` | Show file diffs (staged, unstaged, or between refs) |

These tools are backed by the `GitCLI` class, which runs Git commands in your workspace root.

## Commit message generation

Two ways to generate and create commits:

### `/commit` slash command

Type `/commit` in the chat. SideCar will:

1. Check for uncommitted changes
2. Generate a conventional commit message from the diff
3. Stage all changes
4. Create the commit

Commits include a `Co-Authored-By: SideCar` trailer.

### Command palette

Run `SideCar: Generate Commit Message` from the command palette (`Cmd+Shift+P`). This generates a message from your current diff and commits with staging.

## Code review

Run `SideCar: Review Changes` from the command palette. SideCar reviews your git diff and opens the results as a Markdown document with findings and suggestions.

## PR summaries

Run `SideCar: Summarize PR` from the command palette to generate a pull request description from the current branch's diff against the base branch.

## Repo operations

Ask the agent to perform GitHub operations in natural language:

- "Clone the repository at github.com/user/repo"
- "List open pull requests"
- "Create a PR for this branch"
- "Show me the last 10 commits"
- "What changed in the last commit?"
- "Push my changes to origin"
