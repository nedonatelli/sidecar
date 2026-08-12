# Local SWE-bench ablation (Mac, no Docker)

Run the scaffold-off vs scaffold-on ablation entirely from your Mac: predictions
on local Ollama, scoring in Modal's serverless containers. This is the
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
2. **Modal auth** (scoring runs the tests in Modal, so no Docker locally). The
   venv is created on first run under `.sidecar/cache/swe-venv`; authorize once:

   ```sh
   .sidecar/cache/swe-venv/bin/modal token set --token-id <id> --token-secret <secret>
   ```

   Auth persists in `~/.modal.toml`, so this is a one-time step.

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

| Env           | Default                       | Meaning                                                                                                               |
| ------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `MODEL`       | `gemma4:e4b`                  | Any Ollama model tag.                                                                                                 |
| `N`           | `20`                          | Tasks from the slice (sorted by `instance_id`, first N). Max 50.                                                      |
| `ARMS`        | `scaffold-off,scaffold-on`    | Add `,scaffold-on-ratchet` for the third arm.                                                                         |
| `SLICE`       | `bench/swe/data/canary.jsonl` | The committed 50-task SWE-bench_Lite slice (carries the gold test fields, so solve + score are offline except Modal). |
| `SWE_WORKERS` | `8`                           | Modal concurrency at score time.                                                                                      |

## Cost and disk

- **Predictions**: free (local GPU). One model, one GPU — ~10–250s/solve, so
  N=20 × 2 arms is ~1–1.5h; N=50 is a half-day. Both GPUs at once is what the
  cloud box is for.
- **Scoring**: Modal, ~$1–2 per full run (200 task-arm test executions at N=50).
- **Repo cache**: full clones under `.sidecar/cache/swe-repos` (~2–4 GB for all
  11 repos; only repos your N touches are cloned). Gitignored, reused across runs.

## Reproducing the neutral-ground campaign

`MODEL=gemma4:e4b N=50` and `MODEL=qwen2.5-coder:7b N=50` reproduce the exact
slice from the first cloud campaign — the committed canary _is_ that slice.
