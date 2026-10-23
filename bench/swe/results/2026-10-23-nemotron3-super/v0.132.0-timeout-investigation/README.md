# Nemotron 3 Super on SideCar v0.132.0 — timeout investigation

This is a sanitized, single-task DGX regression run against the exact
`v0.132.0` release (`cbb637da43f767c71bbbe0f7f5da0109cd196891`). It was
targeted at `django__django-12470`, an instance that previously produced an
empty patch after SideCar's former fixed first-token timeout.

The run reached the model in both arms, used the pre-provisioned Django
repository cache, and produced full per-turn trajectories. It is a diagnostic
run, not a SWE-bench capability score: the one non-empty patch has not yet
been evaluated by the official Docker harness.

## Configuration

| Field                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| Date                      | 2026-10-23                                    |
| Dataset                   | SWE-bench Lite canary                         |
| Instance                  | `django__django-12470`                        |
| Model                     | `nemotron-3-super`                            |
| Provider                  | OpenAI-compatible local endpoint (redacted)   |
| Release                   | `v0.132.0` / `cbb637d`                        |
| Arms                      | `scaffold-off`, `scaffold-on`                 |
| Iteration ceiling         | 50                                            |
| Per-task wall-clock limit | 3,600,000 ms (60 min)                         |
| Repository cache          | preflight passed; exact base commit available |

The harness selected this instance reproducibly as Django task 6 of 6
(`SIDECAR_SWE_N=6`, `SIDECAR_SWE_SHARD_COUNT=6`,
`SIDECAR_SWE_SHARD_INDEX=5`).

## Prediction-generation result

| Arm          |       Patch | Duration | Turns | Tool calls | Terminal state                                        |
| ------------ | ----------: | -------: | ----: | ---------: | ----------------------------------------------------- |
| scaffold-off | 2,850 bytes | 38.6 min |    50 |         50 | `timeout`; candidate patch written                    |
| scaffold-on  |       empty | 60.2 min |    35 |         31 | `harness-timeout`; `per-task timeout after 3600000ms` |

The `scaffold-off` patch is a candidate only. It must be Docker-scored before
any claim about task resolution. The empty scaffold-on prediction is not a
capability result: its metadata identifies a harness wall-clock timeout.

## What changed from the earlier failure

The prior v0.131 run of this instance ended after one turn with no tool calls
and an empty patch at the fixed first-token deadline. Under v0.132, both arms
connected to the model and performed substantive repository work. The
adaptive first-token deadline prevented the previous prefill-timeout outcome,
and the repository cache preflight prevented a cache-miss failure before the
agent began.

## Scaffold-on timeline

The 60-minute cutoff interrupted a live agent, but the trace also shows why
an unconditional longer wall-clock limit would be inefficient:

| Time      | Observed behavior                                                              |
| --------- | ------------------------------------------------------------------------------ |
| 0–13 min  | Dense activity: 29 iterations, code searches/reads, and a Django test run.     |
| 13–23 min | One ~8-minute model response, followed by one source-file read.                |
| 23–57 min | Three ~11–12-minute, output-maxed reasoning responses without a tool action.   |
| 58.9 min  | A source-file read succeeded.                                                  |
| 60.0 min  | The harness stopped the active model response at the configured task deadline. |

The estimated prompt context grew from 1.5k tokens to 120.5k tokens. At that
size, the release's adaptive first-token formula permits roughly 61 minutes
for a single turn, which can exceed the separate 60-minute task wall-clock
budget.

## Investigation findings

These are review findings, not implementation decisions.

1. **Make task timeout progress-aware.** A bounded extension after meaningful
   tool results, edits, or verification runs would avoid killing useful work.
   A long sequence of text-only reasoning should remain separately bounded.
2. **Bound no-action output.** The model repeatedly used the 32,768-token
   per-turn output allowance without requesting a tool. A no-action
   continuation limit or a tighter model-specific output budget would keep
   context growth from dominating task time.
3. **Separate search from verification command budget.** The agent consumed
   all 15 `run_command` slots on early shell searches, leaving no shell-command
   capacity for later verification.
4. **Classify harness timeouts accurately.** The console labeled the empty
   scaffold-on result `EMPTY [capability]`, while its structured metadata
   correctly says `harness-timeout`. Reports should preserve the latter
   classification.
5. **Make model-cache operations provider-aware.** The Ollama-native model
   unload attempt returned HTTP 404 from the OpenAI-compatible serving
   endpoint. This did not block the run, but it made both arms start warm and
   weakens reproducibility.
6. **Expose working-tree warm-up failures.** Both arms logged a best-effort
   warm-up failure without the underlying error. Agent searches still worked,
   so this currently affects observability and first-search latency rather
   than correctness.

## Artifacts

`artifacts/` contains the run manifest, predictions, both raw JSONL
trajectories, concise logs, and the process logs. They were exported with:

```text
node bench/swe/export_trajectories.mjs --in <run-dir> --out artifacts
```

The exporter fails closed if a credential or private endpoint remains after
redaction. See `artifacts/export-manifest.json` for the redaction audit.

## Next steps

1. Docker-score `artifacts/preds.scaffold-off.jsonl`.
2. Keep the scaffold-on timeout out of capability aggregates.
3. Convert the findings above into scoped issues before changing timeout,
   output-budget, or tool-budget behavior.
