# BFCL (AST subset) — model-selection benchmark

Phase 1 of the external-benchmark plan ([ADR-006](../../docs/adr/006-external-benchmarks.md),
[bench/README.md](../README.md)). A **model-level** benchmark: it scores a
model's function-calling on a comparable scale so we choose local-model defaults
on field-anchored data — _not_ a SideCar capability number (it gives the
scaffolding harness zero credit, by design).

## What it measures

The **AST-evaluated, non-executable** subset of the Berkeley Function Calling
Leaderboard: given a prompt and a set of function schemas, does the model emit
the right call(s) with the right arguments? Scored by abstract-syntax matching
against a set of acceptable answers — no live APIs, no Docker.

Categories covered:

| Category            | Expectation                                      |
| ------------------- | ------------------------------------------------ |
| `simple`            | one function offered, one correct call           |
| `multiple`          | several functions, pick the right one (one call) |
| `parallel`          | one function, several calls in one response      |
| `parallel_multiple` | several functions, several calls                 |
| `irrelevance`       | nothing applies → the model must **not** call    |
| `relevance`         | a relevant function exists → must emit a call    |

Out of scope for Phase 1: executable categories (need a live API server) and
multi-turn / agentic categories (need a stateful backend). Those are a later
increment.

## Run it

```bash
npm run bench:bfcl                                   # gemma4:e4b on local Ollama
SIDECAR_BFCL_MODEL=ministral-3:latest npm run bench:bfcl
SIDECAR_BFCL_BACKEND=anthropic SIDECAR_BFCL_MODEL=claude-haiku-4-5-20251001 npm run bench:bfcl
```

Cloud backends (`anthropic` / `openai`) skip cleanly when their API key is
absent; the `ollama` backend targets a local daemon and fails loudly if it's
down. Either way this never runs in `npm test` — the eval config is separate, so
CI is unaffected. Env vars:

| Var                    | Default             | Purpose                                                                         |
| ---------------------- | ------------------- | ------------------------------------------------------------------------------- |
| `SIDECAR_BFCL_MODEL`   | `gemma4:e4b`        | model id                                                                        |
| `SIDECAR_BFCL_BACKEND` | `ollama`            | `ollama` \| `anthropic` \| `openai`                                             |
| `SIDECAR_BFCL_QUANT`   | `unknown (≈Q4_K_M)` | quantization label for the envelope                                             |
| `SIDECAR_BFCL_DATA`    | _(unset)_           | dir with `questions.jsonl` + `possible_answers.jsonl` for the full upstream set |
| `SIDECAR_BFCL_OUT`     | _(unset)_           | write the markdown report to this path                                          |
| `SIDECAR_BFCL_CONSTRAINED` | `0`             | `1` = grammar-constrained decoding (Ollama `format`) instead of tools           |
| `SIDECAR_BFCL_RAW`     | `0`                 | `1` = raw model only (native `tool_calls`, no SideCar text-call recovery)        |

### What this measures — the product, not the raw model

BFCL's default (non-constrained) path measures the **product**: the model **plus
SideCar's real function-call recovery** (`parseTextToolCalls`, the exact parser
the agent runs). That is deliberate — nobody runs the raw model; they run the
agent, and SideCar's parsing layer is the whole value proposition for local
models. Local coding models (qwen2.5-coder, devstral, …) return calls as **text**
via `/api/chat` with native `tool_calls` **unset**, so the raw model scores ~0%
even when every call is correct. SideCar recovers them.

Three modes, and their delta on qwen2.5-coder:7b (upstream AST subset, N=80):

| Mode | Flag | qwen2.5-coder:7b | Measures |
| --- | --- | --- | --- |
| **SideCar-parsed** | _(default)_ | **75.0%** | model + SideCar recovery — **the product** |
| Constrained | `SIDECAR_BFCL_CONSTRAINED=1` | 65.0% | SideCar's grammar-forced mode (slower: 5.0s vs 1.1s/case) |
| Raw model | `SIDECAR_BFCL_RAW=1` | **0.0%** | the model alone — the baseline that proves the moat |

The **0% → 75%** jump is the local-first thesis as a number: the harness is the
moat. Text-parsing also beats grammar-forcing here (75 vs 65) because qwen emits
` ```json ` natively. Weak spot: parallel calls (40%).

By default it runs the **bundled fixtures** (`fixtures/ast.json`) — a small
hand-curated set in BFCL's shape, enough to smoke-test the pipeline offline. For
real numbers, point `SIDECAR_BFCL_DATA` at a checkout: concatenate BFCL's
per-category `question` files into `questions.jsonl` and the matching
`possible_answer` files into `possible_answers.jsonl`; `loader.parseUpstream`
merges them by `id`. (The AST categories — `simple`, `multiple`, `parallel` —
are on HF at `gorilla-llm/Berkeley-Function-Calling-Leaderboard`; fetch each
`BFCL_v3_<cat>.json` + `possible_answer/BFCL_v3_<cat>.json` with `curl -L`.)

## Reproducibility envelope (printed with every run)

Per ADR-006, a score without this is not comparable and must not be published:
model + **quantization** (Ollama's Q4 default moves scores by points), context
cap (we use 32K), dataset + case count, temperature, per-case timeout. The
report prints all of it above the scores.

## Simplifications vs. upstream BFCL

The AST checker ([`astChecker.ts`](astChecker.ts)) is faithful on the structural
checks — function-name match, required-present, no hallucinated params,
value-in-acceptable-set, order-sensitive arrays, recursive dict equality, and
numeric/boolean coercion (`5` ≡ `5.0` ≡ `"5"`, `"true"` ≡ `true`). It
**deliberately omits** BFCL's unit normalization and fuzzy string
canonicalization (case-folding, synonym handling). Strings are matched exactly
after trimming. This makes our string-valued cases slightly _stricter_ than
upstream; report numbers as "SideCar-measured AST-subset accuracy", not as an
official BFCL leaderboard score.

The reported **macro** average is the unweighted mean of per-category accuracy;
**micro** is flat pass/total. Neither is BFCL's official category-weighted
overall — labelled as such in the report.

## Files

- `types.ts` — data model
- `astChecker.ts` — the pure AST scoring core (`checkCase`, `valueEquals`)
- `loader.ts` — fixture + upstream JSONL parsing
- `backend.ts` — direct single-turn function-calling calls (Ollama / Anthropic / OpenAI)
- `runner.ts` — DI orchestration + aggregation
- `report.ts` — markdown report with the envelope
- `run.eval.ts` — live driver (eval config)
- `fixtures/ast.json` — bundled offline cases
- `*.test.ts` — unit tests (run in the normal `npm test`)
