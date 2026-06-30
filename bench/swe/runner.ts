// ---------------------------------------------------------------------------
// SWE-bench prediction runner — pure orchestration.
//
// For each task and each arm, call the injected `Solve` function (which, live,
// checks the repo out at base_commit, runs SideCar's agent loop with that arm's
// scaffold config, and returns the unified diff). The runner collects
// predictions; scoring happens later via the official harness. `Solve` is
// injected so the pipeline is testable without git, Docker, or a model.
// ---------------------------------------------------------------------------

import type { ArmName, SwePrediction, SweTask } from './types.js';

export interface SolveResult {
  /** Unified diff the agent produced; '' when it made no change. */
  patch: string;
  durationMs: number;
}

export type Solve = (task: SweTask, arm: ArmName) => Promise<SolveResult>;

export interface RunOptions {
  /** Which arms to run. Default both — the ablation needs both. */
  arms?: ArmName[];
  onResult?: (p: SwePrediction) => void;
}

export async function runSwePredictions(
  tasks: SweTask[],
  solve: Solve,
  opts: RunOptions = {},
): Promise<SwePrediction[]> {
  const arms = opts.arms ?? (['scaffold-off', 'scaffold-on'] as ArmName[]);
  const predictions: SwePrediction[] = [];
  // Tasks run sequentially: a local model serializes on the GPU anyway, and
  // SWE-bench repo checkouts are disk-heavy — parallelism buys little and risks
  // thrashing. Arms alternate per task so a mid-run abort still yields paired data.
  for (const task of tasks) {
    for (const arm of arms) {
      let patch = '';
      let durationMs = 0;
      try {
        const r = await solve(task, arm);
        patch = r.patch;
        durationMs = r.durationMs;
      } catch {
        // A crashed solve = an empty patch (the task is unresolved), not a lost run.
        patch = '';
      }
      const pred: SwePrediction = { instance_id: task.instance_id, arm, model_patch: patch, durationMs };
      predictions.push(pred);
      opts.onResult?.(pred);
    }
  }
  return predictions;
}
