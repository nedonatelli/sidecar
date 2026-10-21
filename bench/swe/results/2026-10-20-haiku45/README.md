# Haiku 4.5: SideCar against reference agents (2026-10-20)

On the 50-task canary, SideCar resolved 25/50 at its shipped settings. Claude Code resolved 30/50 and mini-SWE-agent 25/50. With a higher iteration ceiling and per-tier tool budgets, SideCar resolved 31/50.

The gap to Claude Code was SideCar's limits, not its agent loop:

- **The iteration ceiling.** 50 iterations stopped Haiku partway through on most runs.
- **The per-tool budget.** It refused `run_command` at 15 calls, which cut off Haiku's test runs.

The trajectory comparison that found both is in [comparison.md](comparison.md).

## Setup

|                |                                                                                                                                                                      |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tasks          | `bench/swe/data/canary.jsonl`: 50 SWE-bench Lite tasks                                                                                                               |
| Model          | `claude-haiku-4-5-20251001` through the Anthropic API, for every agent                                                                                               |
| Scorer         | swebench 5.0.2 in local Docker (colima, amd64 via Rosetta), `SWE-bench/SWE-bench_Lite`, through `bench/swe/local/score_local.sh`                                     |
| SideCar        | scaffold 5.1.0 (5.1.1 for the tiered-budget run), `tests/llm-eval/swe.eval.ts` via `bench/swe/local/run_local.sh` with `PROVIDER=anthropic`, per-task timeout 20 min |
| Claude Code    | v2.1.291 headless, stock config, `bench/swe/baselines/claude_code.py`, per-task timeout 20 min                                                                       |
| mini-SWE-agent | v2.4.6, standard `swebench.yaml` (250 steps, $3 per-task cap), in SWE-bench's Docker images on Modal, `bench/swe/baselines/mini_swe.sh`                              |

**Environments differ.** SideCar and Claude Code ran on host clones with the same uv venvs. Repos with native dependencies (matplotlib, scikit-learn, astropy, seaborn, xarray) had no installed environment for them. mini-SWE-agent ran inside SWE-bench's own images.

## Results

| Run                                                        | Resolved  | Model turns, mean (max) | Cost                                     |
| ---------------------------------------------------------- | --------- | ----------------------- | ---------------------------------------- |
| SideCar scaffold-off, 50 iterations                        | 25/50     | 43.4 (50)               | not recorded (#261)                      |
| SideCar scaffold-on, 50 iterations (shipped)               | 25/50     | 44.3 (50)               | not recorded                             |
| SideCar scaffold-on, 150 iterations                        | 30/50     | 60.2 (133)              | not recorded                             |
| SideCar scaffold-on, 150 iterations, tiered budgets (#236) | **31/50** | 68.7 (132)              | not recorded                             |
| Claude Code headless                                       | 30/50     | 46.5 (94)               | $19.57                                   |
| mini-SWE-agent                                             | 25/50     | 81.0 (250)              | $20.12 (includes runs lost to an outage) |

None of the pairwise differences is significant at n = 50. The closest is shipped SideCar against SideCar at 150 iterations with tiered budgets: 1 task only the first solved, 7 only the second, McNemar p = 0.07. Every pair is in [comparison.md](comparison.md).

## Findings

1. **The scaffolding is neutral for Haiku** at shipped settings: 25 against 25, with 4 tasks each way. The completion gate fired on 0 tasks. Haiku runs tests on its own, and SideCar recognizes those runs, so the gate has nothing to catch.
2. **The 50-iteration ceiling binds for a capable model.** 32 of 50 scaffold-on runs hit it. At 150 iterations, SideCar ties Claude Code at 30, 6 tasks each way. On 6 of the 7 tasks only Claude Code solved before, SideCar had stopped at exactly 50. Follow-up: #237.
3. **The per-tool budget refused Haiku in 40 of 50 runs,** mostly `run_command` at 15, which is its test runs. Haiku worked around it with 45 `spawn_agent` calls (subagents get a fresh budget), `ask_user` in autonomous mode (unanswerable) and deleting its own repro scripts. Claude Code, with no caps, averaged 31 shell commands per task. With per-tier budgets (#236), refusals fell from 157 to 15, runs hitting a budget from 40 to 8, and `spawn_agent` workarounds from 45 to 0. Resolve rate stayed neutral (31 against 30, p = 1.0). The 15 remaining refusals are `run_command` at its new cap of 60.
4. **SideCar uses about 40% more tool calls than Claude Code for the same result.** Shell use is now level (32.5 against 31.1 per task). The gap is reads: 19.1 against 11.6 per task, including 14.2 against 7.5 re-reads of a file already read. Follow-up: #262.
5. **The environment barely mattered at Haiku's level.** On the 11 native-dependency tasks, SideCar resolved 6–8 with no installed environment, and mini-SWE-agent resolved 5 with the full Docker image. The sample is tiny. More in #231.

## Measurement problems found along the way

- **Modal scoring is broken.** swebench's Modal evaluator calls Modal's retired legacy Sandbox filesystem API, so the first scoring pass read 0/50 with 47 errors. Fixed by scoring locally.
- **The ablation report was wrong.** It said `ollama`, `32768` context and 20 iterations for this Anthropic run at 50 iterations. Fixed: it now reads the run manifest.
- **Host sleep corrupted runs.** A lid close stalled 7 tasks of the tiered-budget run; they are rerun in `sidecar-150it-budgets/rerun/` and merged. The overnight mini-SWE-agent run lost 27/50 tasks to `ConnectionError`/`gaierror`; those were rerun and merged (see `mini-swe-agent/exit_statuses.*.yaml`). The harness should detect a suspend: #259.
- **Orphaned test runners.** A `runtests.py --parallel` process outlived its task's shell: #260.

## Files

| Path                     | Contents                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `sidecar-50it/`          | both arms at 50 iterations: predictions, `predictions.meta.jsonl`, `run.manifest.json`, resolved reports, `ablation.md`      |
| `sidecar-150it/`         | scaffold-on at 150 iterations                                                                                                |
| `sidecar-150it-budgets/` | scaffold-on at 150 iterations, scaffold 5.1.1. `rerun/` holds the 7 sleep-affected tasks; its reports override the main ones |
| `claude-code/`           | predictions, per-task meta (turns, cost, time), resolved report                                                              |
| `mini-swe-agent/`        | merged predictions, resolved report, exit statuses for the main run and the rerun                                            |
| `comparison.md`          | output of `compare.sh`                                                                                                       |

Trajectories (SideCar `*.trial0.jsonl`, Claude Code stream-json, mini-SWE-agent `*.traj.json`) and per-instance swebench `report.json` files are 17 MB compressed. They're in the [`swe-data-2026-10-20`](https://github.com/nedonatelli/sidecar/releases/tag/swe-data-2026-10-20) release asset, laid out under the same directory names. `compare.sh` regenerates `comparison.md` from it.

## Smoke checks in the same session

`npm run eval:smoke`: 8 agent cases plus the summary, `SIDECAR_EVAL_CASE_TIMEOUT=600000`.

| Model                       | Backend       | Scaffold | Result | Wall time |
| --------------------------- | ------------- | -------- | ------ | --------- |
| `claude-haiku-4-5-20251001` | Anthropic     | 5.1.0    | 8/8    | 53 s      |
| `claude-haiku-5-5`          | Anthropic     | 5.1.0    | 8/8    | 111 s     |
| `gemma4:e4b`                | Ollama 0.40.1 | 5.1.1    | 8/8    | 164 s     |

- **Haiku 5.5 took about twice as long.** It verified its own work unprompted (running `tsc`, running the code, grepping for stubs) and used more iterations per case.
- **gemma4:e4b ran after the tiered-budget change as a regression check.** It resolves to the `medium` tier, so its budgets are unchanged, and no refusal fired.
