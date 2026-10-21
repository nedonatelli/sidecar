import { describe, it, expect } from 'vitest';
import { startSuspendWatch, suspendReason, SUSPEND_THRESHOLD_MS, type Clocks } from './hostSuspend.js';
import { classifyFailure, isInfraFailure } from './failureClassification.js';

// #259: a host suspend mid-task is detected from wall time running ahead of
// monotonic time (the monotonic clock stops during sleep on macOS and Linux).

function fakeClocks(): Clocks & { advance(wallMs: number, monoMs: number): void } {
  let wall = 1_700_000_000_000;
  let mono = 5_000;
  return {
    wallMs: () => wall,
    monoMs: () => mono,
    advance(w, m) {
      wall += w;
      mono += m;
    },
  };
}

describe('host suspend detection (#259)', () => {
  it('a wall-clock jump with no matching monotonic advance is a suspend', () => {
    const c = fakeClocks();
    const watch = startSuspendWatch(c);
    c.advance(60_000, 60_000); // a minute of real work
    c.advance(945_000, 0); // lid closed: 945 s pass on the wall clock only
    c.advance(10_000, 10_000);
    expect(watch.suspendedMs()).toBe(945_000);
  });

  it('normal elapsed time, however long, is not a suspend', () => {
    const c = fakeClocks();
    const watch = startSuspendWatch(c);
    c.advance(1_229_000, 1_229_000); // django-12470's 1,229 s, awake
    expect(watch.suspendedMs()).toBe(0);
  });

  it('drift under the threshold (clock adjustment) is not a suspend', () => {
    const c = fakeClocks();
    const watch = startSuspendWatch(c);
    c.advance(SUSPEND_THRESHOLD_MS + 600_000, 600_000 + 1);
    expect(watch.suspendedMs()).toBe(0);
  });

  it('a suspended task is classified infra, so an empty patch is excluded and a real one still counts', () => {
    const reason = suspendReason(945_000) + '; then: per-task timeout after 1200000ms';
    expect(reason).toMatch(/^host suspended for 945s/);
    expect(classifyFailure(new Error(reason)).kind).toBe('infra');
    expect(isInfraFailure({ failureReason: reason, toolCalls: 3, model_patch: '' })).toBe(true);
    expect(isInfraFailure({ failureReason: reason, toolCalls: 3, model_patch: 'diff --git a b' })).toBe(false);
  });
});
