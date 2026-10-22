import { describe, it, expect } from 'vitest';
import { endedOnTimeout } from './ablation.js';
import { timeoutNotes } from './report.js';
import type { ArmReport } from './types.js';

// #293: on a slow model the per-task timeout binds before the iteration budget,
// and nothing in the report said so. nemotron-3-super (2026-10-21): 2 of 4 runs
// cut off at 15-16 of 50 iterations.
describe('runs that ended on the per-task timeout (#293)', () => {
  it('a timed-out run is recognised by its label or, in older rows, its failure reason', () => {
    expect(endedOnTimeout({ terminationBucket: 'harness-timeout', failureReason: undefined })).toBe(true);
    expect(endedOnTimeout({ terminationBucket: null, failureReason: 'per-task timeout after 1140000ms' })).toBe(true);
    expect(endedOnTimeout({ terminationBucket: 'loop-stopped', failureReason: undefined })).toBe(false);
  });

  const arm = (over: Partial<ArmReport>): ArmReport =>
    ({ arm: 'scaffold-on', total: 4, timedOut: 0, medianTurnsTimedOut: null, ...over }) as ArmReport;

  it('warns when the time limit, not the iteration budget, decided the runs', () => {
    const [line] = timeoutNotes([arm({ timedOut: 2, medianTurnsTimedOut: 15.5 })], 50);
    expect(line).toContain('⚠️');
    expect(line).toContain('2 of 4 runs ended on the per-task timeout at a median of 15.5 turns');
    expect(line).toContain('SIDECAR_SWE_TASK_TIMEOUT');
  });

  it('only notes timeouts that are rare, or that ran close to the budget', () => {
    expect(timeoutNotes([arm({ total: 50, timedOut: 2, medianTurnsTimedOut: 10 })], 50)[0]).toContain('ℹ️');
    expect(timeoutNotes([arm({ timedOut: 3, medianTurnsTimedOut: 40 })], 50)[0]).toContain('ℹ️');
  });

  it('says nothing for an arm with no timeouts, or a report from before the field existed', () => {
    expect(timeoutNotes([arm({}), { ...arm({}), timedOut: undefined }], 50)).toEqual([]);
  });
});
