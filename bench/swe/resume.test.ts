import { describe, it, expect } from 'vitest';
import { needsRerun, planResume, resumeKey } from './resume.js';
import type { SwePrediction } from './types.js';

const row = (id: string, extra: Partial<SwePrediction> = {}): SwePrediction => ({
  instance_id: id,
  arm: 'scaffold-on',
  model_patch: 'diff',
  durationMs: 1000,
  ...extra,
});
const jsonl = (rows: SwePrediction[]): string => rows.map((r) => JSON.stringify(r) + '\n').join('');
const wanted = (...ids: string[]): Set<string> => new Set(ids.map((id) => resumeKey(id, 'scaffold-on')));

// The pylint 2.15 rows the Lite-300 run recorded before the agent started.
const PIP_FAILURE =
  'Command failed: uv pip install --python C:\\venvs\\pylint@2.15\\Scripts\\python.exe -e .\n' +
  "AttributeError: module 'setuptools.build_meta' has no attribute 'build_editable'";

describe('needsRerun', () => {
  it('reruns infrastructure failures and suspended runs', () => {
    expect(needsRerun(row('a', { model_patch: '', failureReason: PIP_FAILURE }))).toBe(true);
    expect(needsRerun(row('a', { model_patch: '', failureReason: 'fetch failed' }))).toBe(true);
    expect(needsRerun(row('a', { model_patch: '', toolCalls: 0 }))).toBe(true);
    expect(needsRerun(row('a', { suspendedMs: 60_000 }))).toBe(true);
  });

  it('keeps results, including an empty patch and a per-task timeout', () => {
    expect(needsRerun(row('a'))).toBe(false);
    expect(needsRerun(row('a', { model_patch: '', toolCalls: 12 }))).toBe(false);
    // An aborted run that kept its edits counts in the ablation, so it stands.
    expect(needsRerun(row('a', { failureReason: 'fetch failed' }))).toBe(false);
    expect(needsRerun(row('a', { failureReason: 'per-task timeout after 2400000ms' }))).toBe(false);
  });
});

describe('planResume', () => {
  it('keeps real rows and sets infra rows aside', () => {
    const plan = planResume(
      jsonl([row('a'), row('b', { model_patch: '', failureReason: PIP_FAILURE }), row('c')]),
      wanted('a', 'b', 'c', 'd'),
    );
    expect(plan.kept.map((p) => p.instance_id)).toEqual(['a', 'c']);
    expect(plan.superseded.map((p) => p.instance_id)).toEqual(['b']);
  });

  it("ignores rows outside this run's slice", () => {
    const plan = planResume(jsonl([row('a'), row('z')]), wanted('a'));
    expect(plan.kept.map((p) => p.instance_id)).toEqual(['a']);
    expect(plan.superseded).toEqual([]);
  });

  it('lets a later row for the same task-arm replace an earlier one', () => {
    const plan = planResume(
      jsonl([
        row('a', { model_patch: '', failureReason: 'fetch failed' }),
        row('b'),
        row('a', { model_patch: 'second' }),
      ]),
      wanted('a', 'b'),
    );
    expect(plan.kept.map((p) => [p.instance_id, p.model_patch])).toEqual([
      ['b', 'diff'],
      ['a', 'second'],
    ]);
    expect(plan.superseded).toEqual([]);
  });

  it('skips a torn last line and starts empty from nothing', () => {
    const torn = jsonl([row('a')]) + '{"instance_id":"b","arm":"scaff';
    expect(planResume(torn, wanted('a', 'b')).kept.map((p) => p.instance_id)).toEqual(['a']);
    expect(planResume('', wanted('a'))).toEqual({ kept: [], superseded: [] });
  });

  it('keys by arm, so one arm can resume without the other', () => {
    const plan = planResume(
      jsonl([row('a'), row('a', { arm: 'scaffold-off' })]),
      new Set([resumeKey('a', 'scaffold-on')]),
    );
    expect(plan.kept.map((p) => p.arm)).toEqual(['scaffold-on']);
  });
});
