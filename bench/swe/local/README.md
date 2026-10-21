# Local SWE-bench ablation (Mac)

Run the scaffold-off vs scaffold-on ablation entirely from your Mac: predictions
on local Ollama, scoring in the official per-task eval images under local Docker. This is the
neutral-ground check on the one claim `llm-eval` can't make — that the harness
itself lifts resolve rate on tasks nobody here authored, judged by the projects'
own hidden tests. See the sibling `../cloud/` runner for the multi-GPU box
version used for large sweeps.

## Why this exists

`llm-eval` measures _models_ against _our_ checkers, always scaffold-on. It can't
tell us whether the scaffold earns its keep. This runner does: same model, same
tasks, harness on vs off, scored by each repo's real test suite.

## One-time setup

1. **Ollama** installed with the model available (the runner pulls if missing).
2. **Docker with amd64 emulation.** The eval images are x86_64 only; on Apple
   Silicon colima's Rosetta mode runs them:

   ```sh
   brew install docker colima
   colima start --cpu 6 --memory 12 --disk 120 --vm-type vz --vz-rosetta
   docker run --rm --platform linux/amd64 alpine uname -m   # → x86_64
   ```

   The runner creates the scoring venv (`swebench>=5`) under
   `.sidecar/cache/swe-venv` and pre-pulls the amd64 images itself.

   Scoring used to run on Modal. swebench's Modal evaluator calls the legacy
   Sandbox filesystem API, which Modal has retired, so every instance errors at
   sandbox creation and the report reads 0 resolved.

## Run

```sh
npm run bench:swe:local                                  # gemma4:e4b, 20 tasks (~1–1.5h)
MODEL=qwen2.5-coder:7b N=50 npm run bench:swe:local       # full 50-task slice
```

Output lands in `.sidecar/cache/swe-local/run_<timestamp>/ablation.md` — the
harness lift (resolve-rate Δ with a 95% CI), per-arm resolve rates, empty-patch
counts, and the rescued/regressed task lists. The report's honesty gate flags
when the sample is too small to separate the lift from chance (it usually is at
N=20 — treat small runs as a smoke test, N=50 for a real read).

## Knobs

| Env           | Default                       | Meaning                                                                                                                         |
| ------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `PROVIDER`    | `ollama`                      | `anthropic` (key from `ANTHROPIC_API_KEY`), or any provider with `BASE_URL` + `API_KEY`. Skips the Ollama step.                 |
| `MODEL`       | `gemma4:e4b`                  | Any Ollama model tag, or the provider's model id.                                                                               |
| `N`           | `20`                          | Tasks from the slice (sorted by `instance_id`, first N). Max 50.                                                                |
| `ARMS`        | `scaffold-off,scaffold-on`    | Add `,scaffold-on-ratchet` for the third arm.                                                                                   |
| `SLICE`       | `bench/swe/data/canary.jsonl` | The committed 50-task SWE-bench_Lite slice (solving is offline; scoring pulls the eval images and the SWE-bench_Lite metadata). |
| `SWE_WORKERS` | `4`                           | Concurrent Docker evaluations at score time.                                                                                    |

`MAX_ITERS` defaults to the shipped `sidecar.agent.maxIterations` (50). A single
arm (e.g. `ARMS=scaffold-on`) is scored but has no lift report.

**Keep the machine on AC power with the lid open.** The script re-runs itself
under `caffeinate -dimsu`, but nothing stops a lid close, and the per-task timers
are wall-clock: a sleeping Mac turns in-flight work into timeouts and empty
patches that read as model failures.

To score predictions from anywhere else (a cloud box, a baseline agent), use the
scorer directly:

```sh
bench/swe/local/score_local.sh <work_dir> <run_prefix> path/to/preds.LABEL.jsonl
```

## Cost and disk

- **Predictions**: free (local GPU). One model, one GPU — ~10–250s/solve, so
  N=20 × 2 arms is ~1–1.5h; N=50 is a half-day. Both GPUs at once is what the
  cloud box is for.
- **Scoring**: free, local. ~30 min per arm at N=50 under amd64 emulation, 4 workers.
- **Eval images**: ~1.6 GB unique each after shared layers — ~80 GB of colima disk at N=50. Kept between runs.
- **Repo cache**: full clones under `.sidecar/cache/swe-repos` (~2–4 GB for all
  11 repos; only repos your N touches are cloned). Gitignored, reused across runs.

## Reproducing the neutral-ground campaign

`MODEL=gemma4:e4b N=50` and `MODEL=qwen2.5-coder:7b N=50` reproduce the exact
slice from the first cloud campaign — the committed canary _is_ that slice.
