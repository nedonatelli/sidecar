# Nemotron 3 Super DGX overnight queue — 2026-10-21

This directory is the sanitized handoff from the overnight DGX queue. It contains:

- the three-trial SideCar agent-smoke reliability summary;
- all 26 attempted SWE-bench arm records in `attempts.jsonl`; and
- the four non-empty, official-format prediction candidates in the two `preds.nonempty.*.jsonl` files.

It intentionally omits raw trajectories, the local endpoint, and credentials.

## Status

The four model-engaged predictions were **scored on 2026-10-22** (swebench, local Docker): **3 of 4 resolve**. With four tasks this is a sanity check, not a capability result.

| Instance                 | scaffold-off                                                                                             | scaffold-on |
| ------------------------ | -------------------------------------------------------------------------------------------------------- | ----------- |
| `astropy__astropy-12907` | resolved                                                                                                 | resolved    |
| `psf__requests-1963`     | not resolved: 6/7 FAIL_TO_PASS (`test_requests_are_updated_each_time` fails), 0 PASS_TO_PASS regressions | resolved    |

The reports are `resolved.scaffold-off.json` and `resolved.scaffold-on.json`. The single-task run of 2026-10-21 (`../requests-1963/`) resolved requests-1963 in both arms with different patches, so the off/on split here is run-to-run variation.

Three things limit what this run shows:

- **The per-task timeout bound, not the iteration budget.** Turns took about 40–70 s, so 19 minutes allowed roughly 16–37 turns. Two runs timed out, and both of them still resolved. A comparable run needs about 60 minutes per task.
- **`bad-reasoning` is wrong on two runs that resolved or came close** (astropy on, requests off). This is the same labelling gap as #271.
- **22 of 26 attempts never reached the model** (repo-cache misses; see below).

The reliability soak is valid evidence of post-fix serving stability. The SWE run is a partial prediction-generation run: only Astropy and Requests had preexisting repository caches. The other 11 queued repositories/tasks failed before the agent began, due to missing repository caches. Their empty patches are recorded for auditability but must be excluded from capability/scoring claims.

## Agent-smoke reliability soak

| Metric                              | Result                     |
| ----------------------------------- | -------------------------- |
| Cases                               | 8                          |
| Trials                              | 24                         |
| Passed trials                       | 22 / 24                    |
| Duration                            | 4,576.52 s (1 h 16 m 17 s) |
| EngineCore / HTTP 502 occurrences   | 0 / 0                      |
| Recovered transient request retries | 3                          |

| Case                             | Passes | Verdict |
| -------------------------------- | ------ | ------- |
| `read-single-file`               | 3 / 3  | pass    |
| `grep-for-todo`                  | 3 / 3  | pass    |
| `no-stub-in-write`               | 3 / 3  | pass    |
| `fix-simple-bug`                 | 3 / 3  | pass    |
| `plan-mode-no-tools`             | 3 / 3  | pass    |
| `error-recovery-to-correct-file` | 1 / 3  | flaky   |
| `version-from-package-json`      | 3 / 3  | pass    |
| `run-fix-iteration-cycle`        | 3 / 3  | pass    |

The reliability run completed all trials without the prior `EngineCore` / 502 failure pattern. The error-recovery case remains a separate agent-quality flake.

## SWE prediction-generation result

| Metric                                | Result                        |
| ------------------------------------- | ----------------------------- |
| Dataset                               | SWE-bench Lite canary         |
| Model                                 | `nemotron-3-super`            |
| Arms                                  | `scaffold-off`, `scaffold-on` |
| Task budget                           | 50 agent iterations           |
| Per-task timeout                      | 1,140,000 ms (19 m)           |
| Unique tasks queued                   | 13                            |
| Arm attempts recorded                 | 26                            |
| Attempts that reached the agent/model | 4                             |
| Non-empty patch candidates            | 4                             |
| Invalid cache-miss attempts           | 22                            |
| Docker scoring                        | 2026-10-22: 3 / 4 resolved    |

The four model-engaged attempts:

| Instance                 | Arm          |  Duration | Turns | Patch bytes | Terminal state   |
| ------------------------ | ------------ | --------: | ----: | ----------: | ---------------- |
| `astropy__astropy-12907` | scaffold-off | 1,144.7 s |    16 |         506 | per-task timeout |
| `astropy__astropy-12907` | scaffold-on  |   489.8 s |    37 |         506 | `bad-reasoning`  |
| `psf__requests-1963`     | scaffold-off | 1,012.5 s |    47 |       2,711 | `bad-reasoning`  |
| `psf__requests-1963`     | scaffold-on  | 1,146.7 s |    15 |       1,315 | per-task timeout |

The other attempts are not model failures. Their cloned repository cache was absent, so the runner exited before the first model turn with `repo-cache-miss`.

## Files

- `run.manifest.json` — sanitized configuration and aggregate result envelope.
- `attempts.jsonl` — every arm attempt, tagged as either `candidate` or `invalid-infrastructure`.
- `preds.nonempty.scaffold-off.jsonl` — the two candidate patches for external scoring/review.
- `preds.nonempty.scaffold-on.jsonl` — the two candidate patches for external scoring/review.
- `resolved.scaffold-off.json`, `resolved.scaffold-on.json` — swebench reports for those four predictions (2026-10-22).

## Next run

Before rerunning the 11 cache-missed tasks, clone their repositories into the configured SWE repository cache (or use `bench/swe/local/run_local.sh`, which performs that provisioning). Then rerun only those tasks with the same model, arm set, 50-iteration budget, and 19-minute per-task ceiling.

The four non-empty predictions can be scored separately on a Docker-capable host, but their timeout / `bad-reasoning` terminal states should be retained alongside any score.
