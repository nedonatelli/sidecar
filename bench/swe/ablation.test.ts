import { describe, it, expect } from 'vitest';
import { computeAblation, computeRatchetComparison } from './ablation.js';
import type { SwePrediction, SweTask } from './types.js';

const tasks: SweTask[] = [
  { instance_id: 't1', repo: 'r/x', base_commit: 'c', problem_statement: 'p', fail_to_pass: [], pass_to_pass: [] },
  { instance_id: 't2', repo: 'r/x', base_commit: 'c', problem_statement: 'p', fail_to_pass: [], pass_to_pass: [] },
  { instance_id: 't3', repo: 'r/x', base_commit: 'c', problem_statement: 'p', fail_to_pass: [], pass_to_pass: [] },
];

const predictions: SwePrediction[] = [
  { instance_id: 't1', arm: 'scaffold-on', model_patch: 'd', durationMs: 2000 },
  { instance_id: 't1', arm: 'scaffold-off', model_patch: 'd', durationMs: 1000 },
  { instance_id: 't2', arm: 'scaffold-on', model_patch: 'd', durationMs: 2000 },
  { instance_id: 't2', arm: 'scaffold-off', model_patch: '', durationMs: 1000 },
  { instance_id: 't3', arm: 'scaffold-on', model_patch: 'd', durationMs: 2000 },
  { instance_id: 't3', arm: 'scaffold-off', model_patch: 'd', durationMs: 1000 },
];

describe('computeAblation', () => {
  // on resolves {t1, t2}; off resolves {t1, t3}
  const report = computeAblation(tasks, predictions, new Set(['t1', 't2']), new Set(['t1', 't3']));

  it('computes per-arm resolve rates', () => {
    expect(report.on.resolveRate).toBeCloseTo(2 / 3, 5);
    expect(report.off.resolveRate).toBeCloseTo(2 / 3, 5);
  });

  it('headline lift is the resolve-rate delta', () => {
    expect(report.liftPct).toBeCloseTo(0, 5);
  });

  it('identifies what the harness rescued vs regressed', () => {
    expect(report.rescuedIds).toEqual(['t2']); // resolved only with scaffolding
    expect(report.regressedIds).toEqual(['t3']); // resolved only without
  });

  it('counts empty patches per arm', () => {
    expect(report.on.emptyPatches).toBe(0);
    expect(report.off.emptyPatches).toBe(1); // t2 off produced no patch
  });

  it('computes the latency cost of the harness', () => {
    expect(report.latencyDeltaMs).toBeCloseTo(1000, 5); // 2000 mean on − 1000 mean off
  });
});

describe('computeRatchetComparison (third arm — keep-best do-no-harm)', () => {
  // Modeled on the campaign shapes: on-arm patches carry scaffold-tail bloat
  // on unresolved tasks (django-14608: 1104b with the 536b wrong tail edit);
  // the ratchet arm reverts the tail back to the pre-scaffold size (568b).
  const threeArm: SwePrediction[] = [
    // t1: both arms resolve — identical clean patch.
    { instance_id: 't1', arm: 'scaffold-on', model_patch: 'x'.repeat(400), durationMs: 2000 },
    {
      instance_id: 't1',
      arm: 'scaffold-on-ratchet',
      model_patch: 'x'.repeat(400),
      durationMs: 2100,
      ratchetReverted: false,
    },
    // t2: neither resolves — on bloats to 1104b, ratchet reverts the tail to 568b.
    { instance_id: 't2', arm: 'scaffold-on', model_patch: 'x'.repeat(1104), durationMs: 2000 },
    {
      instance_id: 't2',
      arm: 'scaffold-on-ratchet',
      model_patch: 'x'.repeat(568),
      durationMs: 2100,
      ratchetReverted: true,
    },
    // t3: neither resolves — on duplicates a broken pattern (1127b), ratchet reverts to 512b.
    { instance_id: 't3', arm: 'scaffold-on', model_patch: 'x'.repeat(1127), durationMs: 2000 },
    {
      instance_id: 't3',
      arm: 'scaffold-on-ratchet',
      model_patch: 'x'.repeat(512),
      durationMs: 2100,
      ratchetReverted: true,
    },
  ];
  const cmp = computeRatchetComparison(tasks, threeArm, new Set(['t1']), new Set(['t1']));

  it('reports the do-no-harm resolve comparison (nothing rescued, nothing regressed)', () => {
    expect(cmp.resolveDeltaPct).toBeCloseTo(0, 5);
    expect(cmp.rescuedIds).toEqual([]);
    expect(cmp.regressedIds).toEqual([]);
    expect(cmp.significance.discordant).toBe(0);
  });

  it('measures the over-engineering rate on UNRESOLVED tasks only', () => {
    // on: (1104 + 1127) / 2; ratchet: (568 + 512) / 2 — the resolved t1 is excluded.
    expect(cmp.meanUnresolvedPatchBytesOn).toBeCloseTo((1104 + 1127) / 2, 5);
    expect(cmp.meanUnresolvedPatchBytesRatchet).toBeCloseTo((568 + 512) / 2, 5);
  });

  it('reports mean patch bytes across all tasks per arm', () => {
    expect(cmp.meanPatchBytesOn).toBeCloseTo((400 + 1104 + 1127) / 3, 5);
    expect(cmp.meanPatchBytesRatchet).toBeCloseTo((400 + 568 + 512) / 3, 5);
  });

  it('computes the revert rate from the ♻️ marker field', () => {
    expect(cmp.revertRate).toBeCloseTo(2 / 3, 5);
  });

  it('flags a do-no-harm violation as regressed', () => {
    // Ratchet un-resolves t1: resolved by on, not by ratchet.
    const bad = computeRatchetComparison(tasks, threeArm, new Set<string>(), new Set(['t1']));
    expect(bad.regressedIds).toEqual(['t1']);
    expect(bad.resolveDeltaPct).toBeLessThan(0);
  });

  it('revert rate is 0 when no prediction carries the field (older meta files)', () => {
    const legacy = threeArm.map(({ ratchetReverted: _r, ...rest }) => rest as SwePrediction);
    const c = computeRatchetComparison(tasks, legacy, new Set(['t1']), new Set(['t1']));
    expect(c.revertRate).toBe(0);
  });
});
