# Unify the SWE and agent eval harnesses on one core

**Status:** approved design, not yet implemented
**Date:** 2026-08-20

## Problem

`tests/llm-eval/swe.eval.ts` (540 lines) imports `runAgentLoop` directly and
re-implements what `tests/llm-eval/agentHarness.ts` (752 lines) already does.
Two harnesses answer the same question — _drive a model against a workspace with
tools and record what happened_ — and the answer you get depends on which file
ran.

`feedback_swe_harness_diverges_from_canonical` has recorded the consequence for
months: _"infra timeouts miscounted as capability failures; distrust SWE numbers
until fixed."_

### What the divergence cost, concretely

| divergence                                                           | consequence                                                                                                                                                                                       |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RAG orientation injected unconditionally in SWE, opt-in nowhere else | measured 2026-08-19: injection took a case from 10/10 to 4/10 (p=0.011). SWE injects 2,722–9,633 chars per task with 29% retrieval recall miss — plausibly depressing every SWE number, invisibly |
| `backend: 'ollama'` hardcoded in swe.eval                            | no frontier ceiling run has ever been possible on SWE — the prerequisite that makes every local number interpretable                                                                              |
| two failure taxonomies (`classifyFailure` vs `apiUnavailable`)       | two definitions of "infra failure", neither aware of the other                                                                                                                                    |
| SWE had live trajectory logs; the agent harness did not              | for a full evening of ablations the only answer to "what happened?" was memory                                                                                                                    |
| separate timeout/abort handling                                      | a case timeout silently truncated trials in one harness and not the other                                                                                                                         |

## The seam

Cleanly separable — 7 genuinely SWE-specific concerns, 8 straight duplications.

**Extract `runAgentTurnLoop()`** carrying everything duplicated:

```
in:   { workspaceRoot, userMessage, systemPrompt, model, backend,
        toolTier, configOverrides, seed, timeoutMs, arm }
out:  { trajectory, iterationsUsed, durationMs, termination,
        apiUnavailable, surface }   // and the live log, written by the core
```

Each harness keeps only its own ends:

|              | before the core                              | after the core                           |
| ------------ | -------------------------------------------- | ---------------------------------------- |
| agentHarness | materialise fixture, build RAG index         | score expectations -> `AgentCaseResult`  |
| swe.eval     | clone repo, set up venv, compose orientation | `git diff` -> patch -> predictions.jsonl |

Owned by the core: client construction, prompt assembly, tool tier, `ToolRuntime`,
callbacks, timeout/abort, circuit-breaker reset, trajectory logging, surface
recording, failure taxonomy.

**Stays SWE-specific:** `setupTaskEnv`/`loadEnvSpecs`, `parseTasks`/`sampleTasks`,
`toPredictionsJsonl`, `armConfigOverrides`, `wholeSuiteGuard`,
`renderTestModuleHint`, `goldFilesInTopK`.

## Behaviour changes (not refactors — these move numbers)

1. **RAG orientation becomes opt-in for SWE.** Likely an improvement on the
   evidence, but old SWE numbers stop being comparable.
2. **Backend is selectable**, enabling the ceiling run.
3. **One failure taxonomy.** SWE's `classifyFailure` is the better developed of
   the two and should win.

## Sequencing

1. Characterisation tests for the SWE-specific pieces — `swe.eval.ts` has **no
   unit tests**; it is exercised only by running SWE-bench, which takes hours.
   The safety net on that side is thin and must be built first.
2. Extract the core with both harnesses' existing tests green.
3. Switch `agentHarness` to it.
4. Switch `swe.eval` to it.
5. Re-baseline SWE once, knowingly — **follow-up work, not part of this**.

Unifying while both harnesses are producing numbers invalidates work in flight,
so nothing here starts until the current seeded sweep's results are banked.

## Risk

The refactor's blast radius is every number either harness produces. The
mitigation is ordering: tests before extraction, one harness switched at a time,
and an explicit re-baseline rather than a silent one.
