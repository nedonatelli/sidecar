# SWE-bench Verified — system-level ablation (Phase 2)

The flagship benchmark ([ADR-006](../../docs/adr/006-external-benchmarks.md)). A
**system-level** measure: the whole agent (SideCar's loop + a model + a real
repo) resolving real GitHub issues. The headline is an **ablation** — the same
model run with the scaffolding harness **on vs off** — because that delta is the
number a bare agent-wrapper (Cline-likes that assume a capable cloud model)
cannot produce.

## Architecture: we generate predictions, the official harness scores them

SWE-bench scoring means applying the agent's patch and running the repo's
`FAIL_TO_PASS` + `PASS_TO_PASS` tests in that task's environment — which the
official `swebench` package does in per-task Docker images. We **do not**
reimplement that (it would be both wrong and enormous). Instead:

```
bench/swe/  →  predictions JSONL (per arm)  →  official swebench harness (Docker)  →  resolved report  →  bench/swe ablation
   ours                ours                          theirs                              theirs               ours
```

This is the standard, reproducible way everyone reports SWE-bench, and it means
our code is the part that's actually ours: driving the loop on/off and computing
the lift.

## The two arms

`bench/swe/arms.ts` defines them with real `SideCarConfig` keys:

- **scaffold-on** — critic + completion gate + auto-fix + impact/numerical gates + adaptive intensity.
- **scaffold-off** — bare loop: every verification scaffold disabled.

> The zero-token **deterministic control** (cycle detection, burst cap,
> write/rewrite-thrash defenses, syntax-gate detection) is not config-gated and
> runs in **both** arms. The ablation isolates the _verification_ scaffolding —
> the part that spends tokens — holding the free control flow constant. State
> this with any reported number.

## Run protocol

**1. Get the dataset.** Export `princeton-nlp/SWE-bench_Verified` (HuggingFace)
to JSON or JSONL at `$SIDECAR_SWE_DATA`.

**2. Generate predictions** (this repo, needs Ollama + the repos cloneable):

```bash
SIDECAR_SWE_DATA=/path/to/swe_verified.jsonl \
SIDECAR_SWE_N=50 \
SIDECAR_SWE_MODEL=gemma4:e4b \
SIDECAR_SWE_OUT=/path/to/out \
npm run bench:swe:predict
# → out/preds.scaffold-on.jsonl  +  out/preds.scaffold-off.jsonl
```

**3. Score each arm with the official harness** (Docker; on a Docker-capable
machine):

```bash
pip install swebench
python -m swebench.harness.run_evaluation \
  --dataset_name princeton-nlp/SWE-bench_Verified \
  --predictions_path out/preds.scaffold-on.jsonl \
  --run_id sidecar-on --max_workers 4
# repeat with preds.scaffold-off.jsonl → run_id sidecar-off
```

**4. Compute the ablation** from the two resolved reports the harness wrote:

```bash
SIDECAR_SWE_DATA=/path/to/swe_verified.jsonl \
SIDECAR_SWE_RESOLVED_ON=on.report.json \
SIDECAR_SWE_RESOLVED_OFF=off.report.json \
SIDECAR_SWE_PREDS=out \
npm run bench:swe:ablate
# → the lift report (resolve% on/off, lift, rescued/regressed tasks, latency cost)
```

## Reproducibility envelope

Per ADR-006, every reported number carries: model + **quantization**, context
cap (32K local), the exact `SIDECAR_SWE_N` slice (deterministic — sorted by
`instance_id`), max agent iterations, and the `swebench` harness version.
Expect a small local model to land in low single-to-low-double digits absolute —
**the headline is the lift, framed weight-class-relative, not the raw rate.**

## Status

The portable core (loader, sampling, official-format prediction emission, arm
config, ablation math, report) is built and unit-tested. The live
prediction-generation driver lives in `tests/llm-eval/swe.eval.ts` (it needs the
agent loop, so it sits with the other src-importing eval drivers). A full scored
run requires Docker + the `swebench` package and is a multi-hour job — it has
not yet been executed end-to-end.

## Files

- `types.ts` — task / prediction / ablation model
- `loader.ts` — SWE-bench Verified parsing + deterministic sampling
- `arms.ts` — scaffold-on / scaffold-off config (real `SideCarConfig` keys)
- `predictions.ts` — official `swebench` JSONL emission + resolved-report parsing
- `ablation.ts` — lift / rescued / regressed / latency math
- `runner.ts` — DI prediction pipeline (replay-testable, no git/Docker/model)
- `report.ts` — the ablation report
- `*.test.ts` — unit tests (run in the normal `npm test`)
- `../../tests/llm-eval/swe.eval.ts` — the live driver
