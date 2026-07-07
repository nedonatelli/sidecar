// ---------------------------------------------------------------------------
// SWE-bench ablation math.
//
// Given the task list, the per-arm predictions (for latency + empty-patch
// counts), and the two resolved-id sets the official harness returned, compute
// the flagship number: how much the scaffolding harness lifts resolve rate, what
// it rescued, what it regressed, and what it cost in latency.
// ---------------------------------------------------------------------------

import type { AblationReport, ArmName, ArmReport, SwePrediction, SweTask } from './types.js';
import { wilsonInterval, mcnemarExactP, pairedDiffCI } from './stats.js';

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
  const rescuedIds = on.resolvedIds.filter((id) => !offSet.has(id));
  const regressedIds = off.resolvedIds.filter((id) => !onSet.has(id));

  // Paired significance: the only pairs that carry effect information are the
  // discordant ones (rescued vs regressed). McNemar exact + Wilson/paired CIs
  // so the lift is reported WITH its uncertainty, not as a bare point estimate.
  const rescued = rescuedIds.length;
  const regressed = regressedIds.length;
  const pValue = mcnemarExactP(rescued, regressed);
  const onCI = wilsonInterval(on.resolved, on.total);
  const offCI = wilsonInterval(off.resolved, off.total);
  const liftCI = pairedDiffCI(rescued, regressed, tasks.length);

  return {
    on,
    off,
    liftPct: on.resolveRate - off.resolveRate,
    rescuedIds,
    regressedIds,
    latencyDeltaMs: on.meanDurationMs - off.meanDurationMs,
    significance: {
      rescued,
      regressed,
      discordant: rescued + regressed,
      pValue,
      significant: pValue < 0.05,
      onCI: [onCI.low, onCI.high],
      offCI: [offCI.low, offCI.high],
      liftCI: [liftCI.low, liftCI.high],
    },
  };
}
