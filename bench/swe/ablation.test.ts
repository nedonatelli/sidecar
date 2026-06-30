import { describe, it, expect } from 'vitest';
import { computeAblation } from './ablation.js';
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
