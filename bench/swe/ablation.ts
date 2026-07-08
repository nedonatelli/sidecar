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

// ---------------------------------------------------------------------------
// Third arm: scaffold-on-ratchet vs scaffold-on (keep-best do-no-harm probe).
// ---------------------------------------------------------------------------

/**
 * Comparison of the `scaffold-on-ratchet` arm against the established
 * `scaffold-on` arm. Two questions, two kinds of evidence:
 *
 * 1. Do-no-harm on RESOLVE: the ratchet must not un-resolve tasks the
 *    scaffold resolved (paired McNemar, same honesty rules as the main
 *    ablation — `regressedIds` non-empty and significant would be a
 *    ratchet bug).
 * 2. Over-engineering rate: mean patch bytes on UNRESOLVED tasks — bytes
 *    spent with no pass-signal gain. This is the metric the ratchet exists
 *    to push toward the bare-arm level (proxy for "scaffold-added bytes";
 *    the true scaffold-tail delta isn't recoverable from the final patch).
 */
export interface RatchetComparison {
  ratchet: ArmReport;
  on: ArmReport;
  /** ratchet resolveRate − on resolveRate. */
  resolveDeltaPct: number;
  /** Resolved by ratchet but not by scaffold-on. */
  rescuedIds: string[];
  /** Resolved by scaffold-on but not by ratchet — do-no-harm violations. */
  regressedIds: string[];
  significance: AblationReport['significance'];
  /** Mean final-patch bytes across ALL tasks, per arm. */
  meanPatchBytesOn: number;
  meanPatchBytesRatchet: number;
  /** Mean final-patch bytes on tasks the arm did NOT resolve — the
   *  over-engineering rate (growth with zero pass-signal gain). */
  meanUnresolvedPatchBytesOn: number;
  meanUnresolvedPatchBytesRatchet: number;
  /** Fraction of ratchet-arm runs where the ratchet actually reverted
   *  (from the ♻️ marker; 0 when no run carried the field). */
  revertRate: number;
}

function meanPatchBytes(preds: SwePrediction[], onlyUnresolvedIn?: Set<string>): number {
  const pool = onlyUnresolvedIn ? preds.filter((p) => !onlyUnresolvedIn.has(p.instance_id)) : preds;
  if (pool.length === 0) return 0;
  return pool.reduce((s, p) => s + p.model_patch.length, 0) / pool.length;
}

export function computeRatchetComparison(
  tasks: SweTask[],
  predictions: SwePrediction[],
  resolvedRatchet: Set<string>,
  resolvedOn: Set<string>,
): RatchetComparison {
  const ratchet = armReport('scaffold-on-ratchet', tasks, predictions, resolvedRatchet);
  const on = armReport('scaffold-on', tasks, predictions, resolvedOn);
  const ratchetSet = new Set(ratchet.resolvedIds);
  const onSet = new Set(on.resolvedIds);
  const rescuedIds = ratchet.resolvedIds.filter((id) => !onSet.has(id));
  const regressedIds = on.resolvedIds.filter((id) => !ratchetSet.has(id));

  const rescued = rescuedIds.length;
  const regressed = regressedIds.length;
  const pValue = mcnemarExactP(rescued, regressed);
  const ratchetCI = wilsonInterval(ratchet.resolved, ratchet.total);
  const onCI = wilsonInterval(on.resolved, on.total);
  const deltaCI = pairedDiffCI(rescued, regressed, tasks.length);

  const ratchetPreds = predictions.filter((p) => p.arm === 'scaffold-on-ratchet');
  const onPreds = predictions.filter((p) => p.arm === 'scaffold-on');
  const reverted = ratchetPreds.filter((p) => p.ratchetReverted === true).length;

  return {
    ratchet,
    on,
    resolveDeltaPct: ratchet.resolveRate - on.resolveRate,
    rescuedIds,
    regressedIds,
    significance: {
      rescued,
      regressed,
      discordant: rescued + regressed,
      pValue,
      significant: pValue < 0.05,
      onCI: [ratchetCI.low, ratchetCI.high],
      offCI: [onCI.low, onCI.high],
      liftCI: [deltaCI.low, deltaCI.high],
    },
    meanPatchBytesOn: meanPatchBytes(onPreds),
    meanPatchBytesRatchet: meanPatchBytes(ratchetPreds),
    meanUnresolvedPatchBytesOn: meanPatchBytes(onPreds, onSet),
    meanUnresolvedPatchBytesRatchet: meanPatchBytes(ratchetPreds, ratchetSet),
    revertRate: ratchetPreds.length ? reverted / ratchetPreds.length : 0,
  };
}
