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

- **scaffold-on** — completion gate + auto-fix + impact/numerical gates + adaptive intensity.
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

For the **three-arm campaign** (adds the keep-best ratchet arm — the v0.118
do-no-harm + over-engineering measurement), add:

```bash
SIDECAR_SWE_ARMS=scaffold-off,scaffold-on,scaffold-on-ratchet
# → also writes out/preds.scaffold-on-ratchet.jsonl; predictions.meta.jsonl
#   records ratchetReverted per ratchet-arm run (the ♻️ revert marker)
```

**3. Score each arm with the official harness** (Docker; on a Docker-capable
machine):

```bash
pip install swebench
python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Verified \
  --predictions_path out/preds.scaffold-on.jsonl \
  --run_id sidecar-on --max_workers 4
# repeat with preds.scaffold-off.jsonl → run_id sidecar-off
# (three-arm: also preds.scaffold-on-ratchet.jsonl → run_id sidecar-ratchet)
```

> **Dataset namespace matters.** `swebench` 5.x requires `image`, `eval_script`,
> `log_parser` and `eval_type` on each instance. The classic
> `princeton-nlp/SWE-bench_Verified` carries none of them and fails with a bare
> `KeyError: 'image'` _after_ downloading the split, which reads like a corrupt
> download rather than a wrong dataset. Use the `SWE-bench/` namespace.
>
> **Apple Silicon.** The eval images are `swebench/sweb.eval.x86_64.*`, so an
> arm64 Mac needs amd64 emulation. `colima start --vm-type vz --vz-rosetta`
> provides it; verify with
> `docker run --rm --platform linux/amd64 alpine uname -m` before a long run.

**4. Compute the ablation** from the two resolved reports the harness wrote:

```bash
SIDECAR_SWE_DATA=/path/to/swe_verified.jsonl \
SIDECAR_SWE_RESOLVED_ON=on.report.json \
SIDECAR_SWE_RESOLVED_OFF=off.report.json \
SIDECAR_SWE_PREDS=out \
npm run bench:swe:ablate
# → the lift report (resolve% on/off, lift, rescued/regressed tasks, latency cost)
```

Three-arm: add `SIDECAR_SWE_RESOLVED_RATCHET=ratchet.report.json` and the report
gains a keep-best section — resolve delta with McNemar (do-no-harm: `regressed`
must be empty/insignificant), the **over-engineering rate** (mean patch bytes on
unresolved tasks, on vs ratchet — the behavioral signal that IS measurable at
small n), and the ratchet's revert rate. This is the Prove-or-Prune evidence
gate for defaulting `sidecar.scaffolding.keepBest` on.

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
agent loop, so it sits with the other src-importing eval drivers).

**Prediction generation is validated end-to-end on real data** — a 1-task
smoke run (`astropy__astropy-7166`, gemma4:e4b, both arms) cloned the repo at the
base commit, ran the loop under each arm's config, captured the diff, and wrote
valid official-format predictions. So the driver works on a non-Docker machine
(Ollama + git is enough). **Scoring** a single light pure-Python task can also be
done host-locally by hand (see the worked example below); scoring the **full
Verified set reproducibly** requires Docker + the `swebench` package — that part
has not been run.

> **Set a generous iteration budget.** A small local model spends many
> iterations just _locating_ the file in a large repo. Default is 30; real runs
> want **30–40+** (`SIDECAR_SWE_MAX_ITERS`). Expect empty/wrong patches often: a
> bare small model resolves little of Verified absolutely — the headline is the
> on/off **lift**, not the raw rate.

### Worked example (pass@5, scored host-locally without Docker)

`pallets__flask-5014` ("require a non-empty Blueprint name"), gemma4:e4b @ Q4_K_M,
30 iterations, **5 runs per arm**, each scored by hand in a venv (the scorer
discriminates: the gold patch resolves 60/60, base fails the FAIL_TO_PASS):

| Arm                        | resolved  |
| -------------------------- | --------- |
| scaffold-off (bare loop)   | **4 / 5** |
| scaffold-on (full harness) | **1 / 5** |

**On this task the harness is net-negative.** The bare loop reliably makes the
clean 3-line fix; the scaffolded arm — gate demanding
tests — over-engineers, writes a large patch, and breaks itself (IndentationError,
test churn). Individual runs flip wildly (in one earlier sample off _deleted_
`super().__init__()` and on landed the correct fix — the exact opposite), which is
the whole point: **at one run per arm the verdict is dominated by nondeterminism,
not by the scaffolding.** Only pass@k reveals the real picture.

The honest reading: **scaffolding value is task-difficulty-dependent** — it rescues
_hard_ tasks where the bare loop bails (in the N=20 slice, scaffold-on produced
patches on tasks scaffold-off gave up on) and can _over-engineer easy_ ones like
this. A headline lift number needs a difficulty-spanning task set × pass@k, not one
easy task. What this example _does_ prove: the whole pipeline (drive on/off → patch
→ host-score → verdict) works end-to-end on real data with no Docker.

Two harness fixes were required to get here: pointing the agent's fs tools at the
clone via `mountWorkspaceRoot` (the mock's `read_file` otherwise returns a 63-byte
stub), and a keyword retrieval block so the agent starts oriented.

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
