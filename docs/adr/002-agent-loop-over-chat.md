---
title: "ADR-002: Stateful tool-calling agent loop"
layout: docs
---

# ADR-002: Stateful tool-calling agent loop

**Date**: 2024-10
**Status**: Accepted

## Context

The simplest integration pattern for an LLM coding assistant is single-turn chat: user sends a message, model replies, done. This covers autocomplete and Q&A well but cannot perform multi-step tasks (read a file → edit it → run tests → fix the error → commit).

The alternative is an agent loop: the model is given a set of tools, emits tool calls, the extension executes them and feeds results back, and the loop continues until the model emits a stop signal. This requires managing conversation history, token budgets, abort signals, and error recovery across multiple turns.

## Decision

SideCar uses a stateful tool-calling agent loop (`src/agent/loop.ts`) as its primary execution model. The loop:

1. Maintains a `messages: ChatMessage[]` history that grows each turn
2. Streams the model's response, collecting text and tool calls
3. Executes tool calls in parallel (with optional serial grouping for destructive tools)
4. Appends tool results and iterates
5. Terminates when the model emits no tool calls, a budget is exhausted, or the user aborts

Single-turn chat is a degenerate case of the loop (one iteration, no tools called).

The loop is decomposed into submodules under `src/agent/loop/` to keep each concern testable independently: `streamTurn`, `executeToolUses`, `compression`, `cycleDetection`, `criticHook`, `policyHook`, etc.

## Consequences

**Positive**:
- Enables multi-file refactors, test-fix-retry cycles, git workflows, and any other multi-step task without user intervention
- Tool results feed directly into the next LLM turn, giving the model a coherent view of what it has done
- Abort, steer, and checkpoint affordances are natural insertion points in the loop

**Negative**:
- Context window fills up over long runs; requires compression (`src/agent/loop/compression.ts`) and episodic memory (`src/agent/episodicMemory.ts`) to manage
- Cycle detection is non-trivial: exact-match dedup catches naive loops but the model can vary tool arguments while repeating the same semantic action; required two-tier detection (exact + normalized-signature)
- Error recovery is harder than single-turn: a mid-loop failure must stash the partial assistant message and surface a `/resume` affordance
