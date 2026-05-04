---
title: "ADR-003: Git worktree shadow workspaces for agent isolation"
layout: docs
---

# ADR-003: Git worktree shadow workspaces for agent isolation

**Date**: 2025-01
**Status**: Accepted

## Context

An agent that writes files directly to the user's working tree has two failure modes:
1. Incomplete refactors that corrupt the codebase mid-edit
2. Silent writes the user didn't notice until after the agent "finished"

The options for isolation were:
- **No isolation** (status quo pre-v0.59): writes land in the user's tree immediately
- **In-memory staging**: buffer writes in a `Map<path, content>`; flush on accept
- **VM or container sandbox**: heavyweight; not practical for a VS Code extension
- **Git worktree**: lightweight branch off `HEAD`; writes are isolated but visible via `git diff`; apply via `git apply --index`

## Decision

SideCar uses `git worktree add --detach` to create ephemeral shadow workspaces at `.sidecar/shadows/<task-id>/` (`src/agent/shadow/shadowWorkspace.ts`). The agent loop runs with a `cwdOverride` pointing to the shadow directory; file tools resolve paths via `resolveRootUri(context)` so writes are transparently redirected.

On completion, the user is shown a unified diff and offered Accept / Reject. Accept runs `git apply --index` onto main; Reject tears down the worktree.

The shadow approach is opt-in (`sidecar.shadowWorkspace.mode: off | opt-in | always`) because it requires a git repository and has a one-time setup cost.

A lighter-weight alternative, Audit Mode (`sidecar.agentMode: 'audit'`), buffers writes in-process without worktrees. It serves the "don't silently touch disk" goal without the git requirement.

## Consequences

**Positive**:
- Agent writes never touch the user's main tree until explicitly accepted
- `git diff` on the shadow is the exact diff the user will review — no approximation
- Worktree teardown is a single `git worktree remove --force` — no state to clean up
- Enables Fork & Parallel Solve (`src/agent/fork/`): N worktrees, N independent agent runs, side-by-side diff review

**Negative**:
- Requires a git repository; non-git workspaces fall back to direct writes
- Worktree creation and teardown are slow relative to in-memory operations (~200ms each)
- `git apply` can fail on merge conflicts if the main branch advanced during the agent run — requires a conflict resolution flow
- Running lint/tests inside the shadow (e.g. `run_tests`) needs the shadow to have a fully-installed `node_modules`; worktrees share the main tree's modules only when the paths are relative
