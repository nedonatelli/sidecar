/**
 * Task-level resume for the SWE harness (SIDECAR_SWE_RESUME=1).
 *
 * The harness appends one row to predictions.meta.jsonl as each task-arm
 * finishes, but a rerun truncated that file and started the slice over, so a
 * crash or a machine restart cost every finished task in the shard. With
 * resume on, a rerun into the same output directory keeps the rows it already
 * has and runs only the task-arms without one.
 *
 * A row is kept only when it is a real result, by the rule the ablation report
 * uses to leave a row out of the denominator (`isInfraFailure`): an empty
 * patch from a run that died of an infrastructure failure or never made a
 * tool call. Such a row, or one that ran across a host suspend, says nothing
 * about the model, so it is set aside (written to the superseded file, not
 * lost) and its task-arm runs again. A per-task timeout is a result: the cap
 * is part of the experiment.
 */

import { isInfraFailure } from './failureClassification.js';
import type { ArmName, SwePrediction } from './types.js';

export interface ResumePlan {
  /** Rows from the earlier run that stand, in their original order. */
  kept: SwePrediction[];
  /** Rows set aside to rerun: infra failures and suspended runs. */
  superseded: SwePrediction[];
}

export const resumeKey = (instanceId: string, arm: ArmName): string => `${instanceId}\u0000${arm}`;

/** Whether an earlier row must be rerun rather than kept. */
export function needsRerun(p: SwePrediction): boolean {
  return Boolean(p.suspendedMs) || isInfraFailure(p);
}

/**
 * Split an earlier predictions.meta.jsonl into rows that stand and rows to
 * rerun. Only rows for task-arms in this run's slice are kept: a row for a
 * task outside it belongs to a different run. A later row for the same
 * task-arm replaces an earlier one. A torn last line, which a crash mid-write
 * leaves, is skipped.
 */
export function planResume(metaText: string, wanted: ReadonlySet<string>): ResumePlan {
  const byKey = new Map<string, SwePrediction>();
  for (const line of metaText.split('\n')) {
    if (!line.trim()) continue;
    let p: SwePrediction;
    try {
      p = JSON.parse(line) as SwePrediction;
    } catch {
      continue;
    }
    if (!p || typeof p.instance_id !== 'string' || typeof p.arm !== 'string') continue;
    const key = resumeKey(p.instance_id, p.arm);
    if (!wanted.has(key)) continue;
    byKey.delete(key);
    byKey.set(key, p);
  }
  const kept: SwePrediction[] = [];
  const superseded: SwePrediction[] = [];
  for (const p of byKey.values()) (needsRerun(p) ? superseded : kept).push(p);
  return { kept, superseded };
}
