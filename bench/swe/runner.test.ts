import { describe, it, expect } from 'vitest';
import { runSwePredictions } from './runner.js';
import type { Solve } from './runner.js';
import type { SwePrediction, SweTask } from './types.js';

const tasks: SweTask[] = [
  { instance_id: 't1', repo: 'r/x', base_commit: 'c', problem_statement: 'p', fail_to_pass: [], pass_to_pass: [] },
  { instance_id: 't2', repo: 'r/x', base_commit: 'c', problem_statement: 'p', fail_to_pass: [], pass_to_pass: [] },
];

describe('runSwePredictions (replay — no git/Docker/model)', () => {
  it('produces one prediction per task per arm', async () => {
    const solve: Solve = async (task, arm) => ({ patch: `${task.instance_id}:${arm}`, durationMs: 5 });
    const preds = await runSwePredictions(tasks, solve);
    expect(preds).toHaveLength(4); // 2 tasks × 2 arms
    expect(preds.map((p) => p.arm)).toEqual(['scaffold-off', 'scaffold-on', 'scaffold-off', 'scaffold-on']);
  });

  it('honors an explicit single-arm run', async () => {
    const solve: Solve = async () => ({ patch: 'd', durationMs: 1 });
    const preds = await runSwePredictions(tasks, solve, { arms: ['scaffold-on'] });
    expect(preds).toHaveLength(2);
    expect(preds.every((p) => p.arm === 'scaffold-on')).toBe(true);
  });

  it('treats a crashed solve as an empty patch, not a lost run', async () => {
    const solve: Solve = async (task) => {
      if (task.instance_id === 't1') throw new Error('agent blew up');
      return { patch: 'ok', durationMs: 1 };
    };
    const preds = await runSwePredictions(tasks, solve, { arms: ['scaffold-on'] });
    expect(preds).toHaveLength(2);
    expect(preds.find((p) => p.instance_id === 't1')!.model_patch).toBe('');
    expect(preds.find((p) => p.instance_id === 't2')!.model_patch).toBe('ok');
  });

  it('fires onResult per prediction', async () => {
    const seen: SwePrediction[] = [];
    const solve: Solve = async () => ({ patch: 'd', durationMs: 1 });
    await runSwePredictions(tasks, solve, { onResult: (p) => seen.push(p) });
    expect(seen).toHaveLength(4);
  });
});
