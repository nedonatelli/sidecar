---
title: 'ADR-006: External standard benchmarks for tool-use and the coding loop'
layout: docs
---

# ADR-006: External standard benchmarks for tool-use and the coding loop

**Date**: 2026-06
**Status**: Proposed

## Context

SideCar's quality signal today is an internal eval harness (`tests/llm-eval/`): 92
hand-written cases (57 agent + 35 prompt) scored by bespoke matchers, plus a
RAG-eval ratchet and an ablation harness (`npm run eval:ablation`) that measures
each scaffold's pass-rate lift. This is good for regression-gating SideCar
against _itself_ — "did this change break the suite?" — but it answers nothing
about the field:

- The "72% agent / 94% prompt" numbers for `gemma4:e4b` are not comparable to
  anything outside this repo. We cannot say whether a local 3–4B model is at the
  frontier of its weight class or merely passing our own smoke tests.
- Model selection (gemma4:e4b vs ministral-3 vs qwen3-coder) is decided on
  internal scores that may not transfer.
- Our core marketing claim — _the scaffolding harness makes weaker local models
  usable_ — has no externally-anchored evidence. The ablation delta is measured
  only against internal cases.

Standard benchmarks split into two layers, and SideCar lives in the gap:

- **Model-level** (BFCL v4, τ-bench, StableToolBench) score the _model's_
  function-calling with the benchmark's own thin scaffold. Comparable to public
  leaderboards. Gives SideCar's harness **zero credit**.
- **System-level** (SWE-bench, Terminal-Bench) score the _agent_ (scaffold +
  model + sandbox) end-to-end. This is the layer SideCar actually ships.

The alternatives considered:

- **Status quo (internal-only)**: cheapest, but never answers "is this good for
  the field / for the weight class?" and leaves the harness thesis unproven.
- **Adopt model-level benchmarks only**: comparable model-selection numbers,
  low infra, but credits the model not the harness — it under-sells SideCar's
  actual contribution.
- **Adopt system-level benchmarks with a harness on/off ablation**: the only
  configuration that produces a number nobody else can — _"SideCar + small model
  resolves X% of SWE-bench Verified, and the scaffolding adds +N points."_
  Highest infra cost (Docker per repo, slow on local hardware).

## Decision

Adopt external standard benchmarks as the **external half of the "Measure"
pillar**, implemented as a `bench/` runner that reuses the existing
`tests/llm-eval/` harness (`agentHarness.ts`, `workspaceSandbox.ts`,
`liveRepoCase.eval.ts`, the `ablation.ts` machinery, `evalReporter.ts`) rather
than a parallel one-off.

Two design commitments:

1. **The flagship metric is system-level with an ablation.** The headline number
   SideCar reports is SWE-bench Verified (and later Terminal-Bench) run
   _end-to-end through SideCar_, **harness-on vs harness-off on the same model**.
   The ablation delta is the moat; a raw model score is supporting evidence, not
   the headline.

2. **Model-level benchmarks are for model selection, not for credit.** BFCL v4
   ranks candidate local models on a comparable scale so we choose defaults on
   field-anchored data. We never present a BFCL score as a SideCar capability
   number.

Phased rollout (detail in [`bench/README.md`](../../bench/README.md)):

- **Phase 1 — BFCL v4 adapter** (low infra): dataset loader + AST scorer that
  ranks our candidate local models. Replaces "internal agent %" as the
  model-selection signal.
- **Phase 2 — SWE-bench Verified subset + ablation** (the flagship): a pinned
  ~50-task slice run through SideCar's headless loop in per-repo containers,
  diff handed to the SWE-bench test harness as the scorer, executed twice
  (harness on / off).
- **Phase 3 — Terminal-Bench** (shell/command loop) and, if the conversational
  and policy-following dimension becomes relevant, **StableToolBench** (many
  unfamiliar APIs → the MCP story). **τ-bench / τ²-bench are deferred**: their
  retail/airline domains are the weakest fit for a coding agent.

Every reported number must carry a **reproducibility envelope**: model +
**quantization** (Ollama defaults to ~Q4_K_M, which moves scores by points),
context cap (we cap local context at 32K), exact benchmark subset + version,
seeds, and per-case timeout. Scores are reported **weight-class-relative**
("within open <8B…") and the layers are never averaged into one vanity number.

## Consequences

**Positive**:

- The harness thesis becomes provable on a field-standard: the on/off ablation
  on SWE-bench is a result no competitor can reproduce, because the harness is
  the differentiator.
- Model defaults (e.g. the v0.115 switch to `gemma4:e4b`) get decided on
  comparable data instead of internal-only scores.
- "Frontier of its weight class or just passing our smoke tests?" becomes an
  answerable, citable question.
- Reuses ~60% of existing infra (headless loop, sandbox, live-repo case,
  ablation, reporter), so cost is bounded.

**Negative**:

- System-level benchmarks are expensive on local hardware: SWE-bench is Docker
  per repo and slow (our eval already needs 600 s/case for gemma). Full Verified
  is impractical locally; we run pinned subsets and accept sampling error.
- Real maintenance surface: dataset version pinning, Docker orchestration,
  result storage, and contamination vigilance (use SWE-bench **Verified**).
- Expectation-management risk: a small local model scores low single-to-double
  digits on SWE-bench Verified vs ~70%+ for frontier cloud. The framing must be
  weight-class-relative or the numbers read as a loss.
- Competes with feature work for engineering time; the phased plan exists so
  Phase 1 ships value before the heavy Phase 2 lift.

## Amendment (2026-09-05): Phase 2 runs SWE-bench Lite, not Verified

This ADR specifies Verified throughout. The implementation uses **Lite**, and has
since the first prediction run: `bench/swe/data/canary.jsonl` (50 tasks) is drawn
from Lite, and every scoring run has passed `--dataset_name
SWE-bench/SWE-bench_Lite` against the 300-instance split. Scoring these
predictions against Verified would simply not find the instance ids.

The original text above is left as written — it records what was decided, not
what shipped. The code and the `bench/` docs have been corrected to say Lite so
they describe what actually runs.

Nothing in the ADR's reasoning depends on which split is used: the contamination
argument, the weight-class-relative framing, and the on-vs-off ablation all hold
for Lite. What changes is the absolute number's comparability — Lite and Verified
resolve rates are not interchangeable, so any figure must name its split.

Deciding whether to move to Verified (larger, and the split more papers report)
is deferred; it would invalidate comparison with every run recorded so far.
