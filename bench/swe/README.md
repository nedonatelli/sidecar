# SWE-bench Lite — system-level ablation (Phase 2)

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

- **scaffold-on** — completion gate + auto-fix + impact/numerical gates + adaptive
  intensity + the keep-best ratchet, exactly as the product ships them. (The
  ratchet has been default-on since v0.118; the arm has carried it explicitly
  since 2026-09-13 — see _Harness corrections_ below.)
- **scaffold-off** — bare loop: every verification scaffold disabled.
- **scaffold-on-noratchet** — scaffold-on with the ratchet off: the ratchet's
  counterfactual. `scaffold-on-ratchet` still parses but is now an alias of
  `scaffold-on`.

> The zero-token **deterministic control** (cycle detection, burst cap,
> write/rewrite-thrash defenses, syntax-gate detection) is not config-gated and
> runs in **both** arms. The ablation isolates the _verification_ scaffolding —
> the part that spends tokens — holding the free control flow constant. State
> this with any reported number.

## Run protocol

**1. Get the dataset.** Export `SWE-bench/SWE-bench_Lite` (HuggingFace) to JSON
or JSONL at `$SIDECAR_SWE_DATA`. The checked-in canary set
(`bench/swe/data/canary.jsonl`, 50 tasks) is drawn from Lite, and every scoring
run to date has used the 300-instance Lite split — score against another split
and the harness will not find these instance ids.

**2. Generate predictions** (this repo, needs Ollama + the repos cloneable):

```bash
SIDECAR_SWE_DATA=/path/to/swe_lite.jsonl \
SIDECAR_SWE_N=50 \
SIDECAR_SWE_MODEL=gemma4:e4b \
SIDECAR_SWE_OUT=/path/to/out \
npm run bench:swe:predict
# → out/preds.scaffold-on.jsonl  +  out/preds.scaffold-off.jsonl
```

For the **three-arm campaign** (isolates the keep-best ratchet — the v0.118
do-no-harm + over-engineering measurement), add the ratchet's counterfactual:

```bash
SIDECAR_SWE_ARMS=scaffold-off,scaffold-on,scaffold-on-noratchet
# → also writes out/preds.scaffold-on-noratchet.jsonl; predictions.meta.jsonl
#   records ratchetReverted per run where the ratchet is on (the ♻️ revert marker)
```

Every run defaults to the shipped 50-iteration ceiling
(`SIDECAR_SWE_MAX_ITERS` overrides) with thinking on. Before any matrix, diff the
harness defaults against `package.json` — two of the corrections below were
configs nobody shipped.

**3. Score each arm with the official harness** (Docker; on a Docker-capable
machine):

```bash
pip install swebench
python -m swebench.harness.run_evaluation \
  --dataset_name SWE-bench/SWE-bench_Lite \
  --predictions_path out/preds.scaffold-on.jsonl \
  --run_id sidecar-on --max_workers 4
# repeat with preds.scaffold-off.jsonl → run_id sidecar-off
# (three-arm: also preds.scaffold-on-noratchet.jsonl → run_id sidecar-noratchet)
```

> **Dataset namespace matters.** `swebench` 5.x requires `image`, `eval_script`,
> `log_parser` and `eval_type` on each instance. The classic
> `princeton-nlp/*` mirrors carry none of them and fail with a bare
> `KeyError: 'image'` _after_ downloading the split, which reads like a corrupt
> download rather than a wrong dataset. Use the `SWE-bench/` namespace.
>
> **Apple Silicon.** The eval images are `swebench/sweb.eval.x86_64.*`, so an
> arm64 Mac needs amd64 emulation. `colima start --vm-type vz --vz-rosetta`
> provides it; verify with
> `docker run --rm --platform linux/amd64 alpine uname -m` before a long run.

**4. Compute the ablation** from the two resolved reports the harness wrote:

```bash
SIDECAR_SWE_DATA=/path/to/swe_lite.jsonl \
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
done host-locally by hand (see the worked example below). Scoring
**reproducibly** requires Docker + the `swebench` package: the 50-task canary is
scored that way routinely (official harness under WSL; per-instance
`report.json` with the F2P/P2P lists), the full 300-instance Lite split has not
been.

> **The iteration budget is the shipped ceiling, 50.** A small local model
> spends many iterations just _locating_ the file in a large repo, and until
> 2026-09-13 the harness default was 30 (`SIDECAR_SWE_MAX_ITERS` overrides
> either way). Expect empty/wrong patches often: a bare small model resolves
> little of Lite absolutely — the headline is the on/off **lift**, not the raw
> rate.

### Harness corrections (2026-09-13) — which prior numbers carry an asterisk

Two defaults in the driver measured a configuration the product never shipped.
Both are fixed on `main`; numbers recorded before the fix are not comparable to
numbers after it, and are not restated here.

| Correction                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Wrong until         | Runs affected                                                                                                                                                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Iteration ceiling 30 → 50** (PR #63). The driver's `SIDECAR_SWE_MAX_ITERS` default was 30; the product's `sidecar.agent.maxIterations` ships 50. Localization-bound tasks were cut off at 60% of the budget the user gets.                                                                                                                                                                                                                                           | 2026-09-13          | Every run that did not set `SIDECAR_SWE_MAX_ITERS` — including the worked example below (explicitly 30) and the N=20 slice it cites.                                                                                                                           |
| **Keep-best ratchet ON in `scaffold-on`** (PR #68). The ratchet shipped default-on in v0.118 (2026-07-09), but `scaffold-on` was defined without it so a separate `scaffold-on-ratchet` arm could isolate it: unset (inheriting the run's config) until 2026-08-06, then explicitly pinned OFF. So "scaffold-on" measured a harness nobody ran, missing the one mechanism (retry without keeping a regression) whose absence explained the harm seen in four matrices. | v0.118 → 2026-09-13 | Every `scaffold-on` number from that window, including the worked example below. The v0.118 150-run campaign stays valid as a ratchet isolation: its `scaffold-on` is today's `scaffold-on-noratchet`, and its `scaffold-on-ratchet` is today's `scaffold-on`. |

Two related traps, recorded so they are not re-learned: gate firings are
counted from the loop's own lines in `trajectory.*.log` (`Red-check gate
fired`, `Completion gate fired/exhausted`, `Keep-best ratchet armed/kept/revert`),
never from the model-facing markers; and an intervention that never fired is a
null result about the trigger, not about the intervention.

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
- `loader.ts` — SWE-bench Lite parsing + deterministic sampling
- `arms.ts` — scaffold-on / scaffold-off config (real `SideCarConfig` keys)
- `predictions.ts` — official `swebench` JSONL emission + resolved-report parsing
- `ablation.ts` — lift / rescued / regressed / latency math
- `runner.ts` — DI prediction pipeline (replay-testable, no git/Docker/model)
- `report.ts` — the ablation report
- `*.test.ts` — unit tests (run in the normal `npm test`)
- `../../tests/llm-eval/swe.eval.ts` — the live driver
