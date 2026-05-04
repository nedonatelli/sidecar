---
title: "ADR-005: Typed sub-agent facets for specialist dispatch"
layout: docs
---

# ADR-005: Typed sub-agent facets for specialist dispatch

**Date**: 2025-03
**Status**: Accepted

## Context

Complex agent tasks often have a natural decomposition into independent subtasks (e.g. "write tests for module A" + "update the docs" + "check performance"). Running them sequentially in one loop wastes wall time and inflates the context window with cross-domain noise.

The alternatives were:
- **Sequential single loop**: simple, no parallelism
- **Free-form sub-agents**: spawn arbitrary agent loops from within a tool call. Flexible but untypeable, unauditable, and hard to review as a user
- **Typed facets**: a named catalog of specialists, each with a fixed tool allowlist, preferred model, and RPC schema. Dispatch is data-driven; the catalog ships in code so there's no broken-unpack footgun on first install

## Decision

SideCar implements a Typed Facet system (`src/agent/facets/`) where each facet is a named specialist with:
- `id`: unique identifier
- `description`: what it does
- `preferredModel`: optional model pin (overrides the orchestrator's model for this specialist)
- `tools`: allowlist of tool names the specialist may use
- `systemPrompt`: specialist-specific system prompt injected on top of the orchestrator's
- `dependsOn`: optional edges for topological ordering
- `rpcSchema`: optional typed RPC methods for inter-facet communication

Eight built-in facets ship in code (`builtInFacets()` in `facetLoader.ts`). Users and teams layer custom facets on top via `.sidecar/facets/*.md` or `sidecar.facets.registry` paths.

`dispatchFacets()` runs the topological layers in bounded parallel (`maxConcurrent`). Each facet runs in its own Shadow Workspace with `deferPrompt: true` — the user sees a single batch-review UI after all facets complete, not N overlapping quickpicks.

Inter-facet coordination uses `FacetRpcBus` which never rejects (resolves to `{ok, value}` or `{ok: false, errorKind}`) so a single failing peer doesn't cascade.

## Consequences

**Positive**:
- Wall-time reduction proportional to the number of independent subtasks; a 4-facet batch with `maxConcurrent: 4` runs in the time of the slowest facet
- Tool allowlists are a security boundary: the `docs` facet can't accidentally call `run_command`
- Typed RPC schema lets facets share intermediate results without file-system round-trips
- Batch review UI is a natural affordance: user sees all diffs in one pass and can accept/reject per facet

**Negative**:
- Facet dependency graphs must be a DAG; cycle detection adds overhead at registry build time
- Per-facet shadow workspaces multiply git worktree setup cost by `N`; teardown is async but still real
- RPC timeout and handler-threw paths require the caller to handle `{ok: false}` explicitly — easy to miss
- Eight built-in facets ship in code: adding a new built-in requires a code change (deliberate trade-off against disk-loaded facets that can be broken by a bad unpack)
