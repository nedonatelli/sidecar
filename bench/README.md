# SideCar External Benchmarks

External, field-standard benchmarks for SideCar — the **comparability** layer of
the "Measure" pillar. Distinct from `tests/llm-eval/` (the internal regression
suite that gates SideCar against itself); this measures SideCar against the
field. See [ADR-006](../docs/adr/006-external-benchmarks.md) for the decision and
rationale.

> **Status: design / not yet implemented.** This document is the plan the ADR
> commits to. Directories and scripts below are the intended shape, not shipped
> code.

## The one distinction that drives everything

Benchmarks measure one of two layers. SideCar's value is the gap between them.

| Layer            | Benchmarks                        | Measures                                                           | Credits the harness? |
| ---------------- | --------------------------------- | ------------------------------------------------------------------ | -------------------- |
| **Model-level**  | BFCL v4, τ-bench, StableToolBench | the _model's_ function-calling under the benchmark's thin scaffold | No                   |
| **System-level** | SWE-bench, Terminal-Bench         | the _agent_ (scaffold + model + sandbox) end-to-end                | Yes                  |

**The flagship number is system-level with an on/off ablation:** SideCar + a
small local model on SWE-bench Lite, **harness-on vs harness-off**. The delta
is the moat — nobody without the harness can produce it. Model-level scores are
for _model selection_, never presented as a SideCar capability number.

## Benchmark matrix

| Benchmark                               | Layer      | What it proves for SideCar                                                                                                     | Priority          | Infra                                                         |
| --------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------- |
| **BFCL v4**                             | model      | Ranks candidate local models (gemma4:e4b / ministral-3 / qwen3-coder) on a public scale; picks defaults on field-anchored data | **P1**            | Low — AST eval, no Docker                                     |
| **SWE-bench Lite** (sampled) + ablation | system     | Weight-class-relative resolve rate **and** the scaffolding lift — the thesis-prover                                            | **P1 (flagship)** | High — Docker/repo, slow on local                             |
| **Terminal-Bench**                      | system     | The shell / command loop specifically                                                                                          | P2                | Medium — sandbox runner                                       |
| **StableToolBench**                     | model      | Many unfamiliar APIs → the MCP delegation story                                                                                | P3                | Medium — simulated API server                                 |
| **τ-bench / τ²-bench**                  | model+user | Conversational + policy-following                                                                                              | **Deferred**      | Domain (retail/airline) is the weakest fit for a coding agent |

## Phases

### Phase 1 — BFCL v4 adapter (model selection)

`bench/bfcl/` — load BFCL v4 cases (simple / multiple / parallel / multi-turn /
agentic / relevance-detection), drive them through `SideCarClient`'s tool-call
path, score with an AST matcher against the gold call, emit per-model /
per-category percentages via the existing `evalReporter`. No Docker. Outcome: a
citable model-selection number that replaces the internal "agent %".

### Phase 2 — SWE-bench Lite subset + ablation (flagship)

`bench/swe/` — reuse `agentHarness.ts` + `workspaceSandbox.ts`. For each task in
a **pinned ~50-task Verified slice**: check out the repo at the base commit in a
container, run SideCar's headless loop (`runAgentLoop`, `approvalMode:
'autonomous'`) against the issue text, extract the diff (Shadow Workspace
already does this), hand it to the SWE-bench test harness as the scorer. Run the
slice **twice — harness on and harness off (same model, same seed)** — and report
`resolve%` for each plus the **ablation delta**. Scale to a larger slice once the
runner is stable.

### Phase 3 — Terminal-Bench, then StableToolBench

`bench/terminal/` for the shell loop; `bench/stabletoolbench/` for the
unfamiliar-API / MCP dimension. τ-bench deferred unless the conversational
domain becomes a product direction.

## Reproducibility envelope (mandatory on every reported number)

A score without this envelope is not comparable and must not be published:

- **Model + quantization** — Ollama serves `gemma4:e4b` at ~Q4_K_M by default;
  quant moves scores by points. fp16-vs-Q4 is the #1 way local/cloud
  comparisons get called dishonest.
- **Context cap** — SideCar caps local context at 32K (`LOCAL_CONTEXT_CAP`).
- **Benchmark subset + version** — exact task IDs for sampled runs; use
  SWE-bench **Verified** (contamination-hardened), not the full set.
- **Seeds + per-case timeout** — our eval already needs 600 s/case for gemma.
- **Harness state** — on / off, and which scaffolds were active.

## Reporting rules

- **Weight-class-relative framing.** "Within open <8B, SideCar+model resolves
  X%; the harness adds +N." A small local model lands low single-to-double
  digits on SWE-bench Lite vs ~70%+ for frontier cloud — never frame a
  number to invite a direct GPT comparison.
- **Never average layers.** Model-level and system-level measure different
  things; one combined vanity score is misleading.
- **The ablation is the headline; the raw score is support.**

## Integration map (what already exists)

The runner is ~60% built — it reuses, not replaces, the internal harness:

- `tests/llm-eval/agentHarness.ts` — headless agent driver
- `tests/llm-eval/workspaceSandbox.ts` — per-run workspace isolation
- `tests/llm-eval/liveRepoCase.eval.ts` — agent against a real repo (the seed for SWE-bench)
- `src/agent/ablation.ts` + `tests/llm-eval/ablation.eval.ts` — harness on/off machinery
- `tests/llm-eval/evalReporter.ts` — result formatting
- `src/mcpServer/agentServer.ts` — headless `run_agent_task` entry point
- Shadow Workspaces (`src/agent/shadow/`) — diff extraction for the SWE-bench scorer

The missing pieces are the per-benchmark case loaders, scorers (AST for BFCL,
the SWE-bench test harness for SWE), Docker orchestration for the system-level
runs, and result storage.
