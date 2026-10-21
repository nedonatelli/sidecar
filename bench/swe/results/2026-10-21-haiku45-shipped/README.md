# Haiku 4.5 at SideCar's shipped defaults (2026-10-21)

**30/50**, at a 97.0% cache hit rate, for $23.97 ($0.80 per resolved task). This is the first SWE run where the strong tier's settings came from the product, not from the harness:

- **Iteration ceiling:** 150, from the tier (#237).
- **Tool budgets:** tiered (#236).

It measures what a user running Haiku in SideCar gets. It closes the measurement items of #237 and #261.

## Setup

Same as [2026-10-20](../2026-10-20-haiku45/README.md) except:

|                   |                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------- |
| SideCar           | `main` at `efdc6780`, scaffold **5.1.2**, scaffold-on only                                              |
| Iteration ceiling | **not set**: the driver resolved `150 (tier:strong)` (manifest `maxIterationsSource`)                   |
| Run               | `PROVIDER=anthropic MODEL=claude-haiku-4-5-20251001 N=50 ARMS=scaffold-on bench/swe/local/run_local.sh` |

No host suspend or infrastructure failure was recorded. The one empty patch (`scikit-learn-25570`) is the model stopping after 29 turns.

## Results

| Run                                                     | Resolved  | Cache hit    | Cost         | Cost per resolved task |
| ------------------------------------------------------- | --------- | ------------ | ------------ | ---------------------- |
| **SideCar, shipped defaults (5.1.2)**                   | **30/50** | **97.0%**    | **$23.97**   | **$0.80**              |
| SideCar, 150 iterations + tiered budgets (5.1.1)        | 31/50     | not recorded | not recorded | —                      |
| SideCar, 150 iterations (5.1.0)                         | 30/50     | not recorded | not recorded | —                      |
| SideCar, 50 iterations (5.1.0, the old shipped default) | 25/50     | not recorded | not recorded | —                      |
| Claude Code headless                                    | 30/50     | 97.8%        | $19.57       | $0.65                  |

- **Against the explicit-150 runs it's noise.** The shipped defaults reproduce the explicitly configured 150-iteration runs: 6 tasks each way against the 5.1.0 run, and 4 gained, 5 lost against the tiered-budget run. Both p = 1.0.
- **Against the old shipped default:** 9 gained, 4 lost (p = 0.27).
- **Against Claude Code:** 3 tasks each way.

Tokens: 151.6M cache reads, 2.6M cache writes, 2.0M uncached input, 0.7M output. SideCar's cache hit rate matches Claude Code's (97.0% against 97.8%). Claude Code is about 20% cheaper because it does less work: 46.5 model turns per task against 66.1.

| Per task (mean)       | SideCar, shipped defaults | Claude Code |
| --------------------- | ------------------------- | ----------- |
| Model turns           | 66.1                      | 46.5        |
| Shell commands        | 30.7                      | 31.1        |
| Test runs             | 13.1                      | 8.2         |
| File reads (re-reads) | 18.9 (14.2)               | 11.6 (7.5)  |
| First edit at call #  | 21.8                      | 15.5        |
| Budget refusals       | 0.1                       | —           |

The cost gap and the turn gap are the same gap: reads (#262). One run, `django-16816`, used all 150 iterations; 6 of 50 went past 100.

All five SideCar and Claude Code runs are in [comparison.md](comparison.md).

## Files

| Path                        | Contents                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `preds.scaffold-on.jsonl`   | predictions                                                                                                  |
| `predictions.meta.jsonl`    | per task: turns, tokens (input / cache creation / cache read / output), `cacheHitRate`, `costUsd`, decisions |
| `run.manifest.json`         | provenance, including `maxIterations: 150`, `maxIterationsSource: "tier:strong"`                             |
| `resolved.scaffold-on.json` | swebench 5.0.2 report                                                                                        |
| `comparison.md`             | output of `compare.sh`                                                                                       |

Trajectories and per-instance `report.json` files are in the [`swe-data-2026-10-21`](https://github.com/nedonatelli/sidecar/releases/tag/swe-data-2026-10-21) release asset. `compare.sh` also needs the [`swe-data-2026-10-20`](https://github.com/nedonatelli/sidecar/releases/tag/swe-data-2026-10-20) asset for the earlier runs.
