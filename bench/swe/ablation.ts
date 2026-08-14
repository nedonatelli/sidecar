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

/**
 * A prediction is an INFRASTRUCTURE failure when the agent issued zero tool
 * calls and produced no patch: the run never engaged the repo — a model-request
 * timeout (firstTokenTimeout) or stall — so its empty result reflects the
 * harness hanging, not the model (or scaffold) failing the task. Ported from
 * agentHarness's hasModelContent guard. `toolCalls` is undefined on predictions
 * written before the field existed; those default to non-infra so old runs are
 * unaffected.
 */
function isInfraFailure(p: SwePrediction): boolean {
  return (p.toolCalls ?? 1) === 0 && p.model_patch.trim() === '';
}

function armReport(arm: ArmName, tasks: SweTask[], predictions: SwePrediction[], resolved: Set<string>): ArmReport {
  const taskIds = new Set(tasks.map((t) => t.instance_id));
  const scored = predictions.filter((p) => p.arm === arm && taskIds.has(p.instance_id));
  const ids = tasks.map((t) => t.instance_id);
  const resolvedIds = ids.filter((id) => resolved.has(id));
  const mean = (xs: number[]): number => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const meanDurationMs = mean(scored.map((p) => p.durationMs));
  const meanTurns = mean(scored.map((p) => p.turns ?? 0));
  const meanScaffoldInterventions = mean(scored.map((p) => p.scaffoldInterventions ?? 0));
  return {
    arm,
    resolved: resolvedIds.length,
    total: tasks.length,
    resolveRate: tasks.length ? resolvedIds.length / tasks.length : 0,
    meanDurationMs,
    meanTurns,
    meanScaffoldInterventions,
    resolvedIds,
    // Empty patches among SCORED tasks only — genuine "agent worked but produced
    // no diff", with infra stalls already excluded (they're not in `tasks`).
    emptyPatches: scored.filter((p) => p.model_patch.trim() === '').length,
    // Stall count over the full arm, for reporting how much was excluded.
    infraFailures: predictions.filter((p) => p.arm === arm && isInfraFailure(p)).length,
  };
}

export function computeAblation(
  tasks: SweTask[],
  predictions: SwePrediction[],
  resolvedOn: Set<string>,
  resolvedOff: Set<string>,
): AblationReport {
  // Exclude tasks where EITHER arm was an infra failure (stall / request
  // timeout): a paired comparison can only compare tasks both arms actually
  // attempted. Scoring a stalled run as a loss would attribute a harness hang
  // to the model or the scaffold — the exact bug this guards against.
  const onById = new Map(predictions.filter((p) => p.arm === 'scaffold-on').map((p) => [p.instance_id, p]));
  const offById = new Map(predictions.filter((p) => p.arm === 'scaffold-off').map((p) => [p.instance_id, p]));
  const infraExcludedIds = tasks
    .map((t) => t.instance_id)
    .filter((id) => {
      const a = onById.get(id);
      const b = offById.get(id);
      return (a !== undefined && isInfraFailure(a)) || (b !== undefined && isInfraFailure(b));
    });
  const excluded = new Set(infraExcludedIds);
  const keptTasks = tasks.filter((t) => !excluded.has(t.instance_id));

  const on = armReport('scaffold-on', keptTasks, predictions, resolvedOn);
  const off = armReport('scaffold-off', keptTasks, predictions, resolvedOff);
  const onSet = new Set(on.resolvedIds);
  const offSet = new Set(off.resolvedIds);
  const rescuedIds = on.resolvedIds.filter((id) => !offSet.has(id));
  const regressedIds = off.resolvedIds.filter((id) => !onSet.has(id));

  // Paired significance over the SURVIVING tasks: the only pairs that carry
  // effect information are the discordant ones (rescued vs regressed). McNemar
  // exact + Wilson/paired CIs so the lift is reported WITH its uncertainty.
  const rescued = rescuedIds.length;
  const regressed = regressedIds.length;
  const pValue = mcnemarExactP(rescued, regressed);
  const onCI = wilsonInterval(on.resolved, on.total);
  const offCI = wilsonInterval(off.resolved, off.total);
  const liftCI = pairedDiffCI(rescued, regressed, keptTasks.length);

  return {
    on,
    off,
    liftPct: on.resolveRate - off.resolveRate,
    rescuedIds,
    regressedIds,
    latencyDeltaMs: on.meanDurationMs - off.meanDurationMs,
    infraExcludedIds,
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
