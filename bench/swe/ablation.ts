// ---------------------------------------------------------------------------
// SWE-bench ablation math.
//
// Given the task list, the per-arm predictions (for latency + empty-patch
// counts), and the two resolved-id sets the official harness returned, compute
// the flagship number: how much the scaffolding harness lifts resolve rate, what
// it rescued, what it regressed, and what it cost in latency.
// ---------------------------------------------------------------------------

import type { AblationReport, ArmName, ArmReport, SwePrediction, SweTask } from './types.js';

function armReport(arm: ArmName, tasks: SweTask[], predictions: SwePrediction[], resolved: Set<string>): ArmReport {
  const armPreds = predictions.filter((p) => p.arm === arm);
  const ids = tasks.map((t) => t.instance_id);
  const resolvedIds = ids.filter((id) => resolved.has(id));
  const durations = armPreds.map((p) => p.durationMs);
  const meanDurationMs = durations.length ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;
  return {
    arm,
    resolved: resolvedIds.length,
    total: tasks.length,
    resolveRate: tasks.length ? resolvedIds.length / tasks.length : 0,
    meanDurationMs,
    resolvedIds,
    emptyPatches: armPreds.filter((p) => p.model_patch.trim() === '').length,
  };
}

export function computeAblation(
  tasks: SweTask[],
  predictions: SwePrediction[],
  resolvedOn: Set<string>,
  resolvedOff: Set<string>,
): AblationReport {
  const on = armReport('scaffold-on', tasks, predictions, resolvedOn);
  const off = armReport('scaffold-off', tasks, predictions, resolvedOff);
  const onSet = new Set(on.resolvedIds);
  const offSet = new Set(off.resolvedIds);
  return {
    on,
    off,
    liftPct: on.resolveRate - off.resolveRate,
    rescuedIds: on.resolvedIds.filter((id) => !offSet.has(id)),
    regressedIds: off.resolvedIds.filter((id) => !onSet.has(id)),
    latencyDeltaMs: on.meanDurationMs - off.meanDurationMs,
  };
}
