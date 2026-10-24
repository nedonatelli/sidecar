import { describe, it, expect } from 'vitest';
import { isRepoPrepFailure, PrepFailureStreak, PREP_STREAK_LIMIT } from './prepStreak.js';

// The failure reasons below are verbatim from the 2026-10-23 shard that lost git
// after a VS Code window reload (21 of 50 tasks recorded as EMPTY [infra]).
const RESET = 'Command failed: git reset --hard --quiet a754b82dac511475b6276039471ccd17cc64aeb8';
const CLONE = 'Command failed: git clone --quiet --filter=blob:none https://github.com/pytest-dev/pytest.git';

describe('isRepoPrepFailure', () => {
  it('matches a zero-turn git reset or clone failure', () => {
    expect(isRepoPrepFailure({ turns: 0, failureReason: RESET })).toBe(true);
    expect(isRepoPrepFailure({ turns: 0, failureReason: CLONE })).toBe(true);
    expect(isRepoPrepFailure({ turns: 0, failureReason: 'repo cache miss for django/django at /c/cache' })).toBe(true);
  });

  it('does not match a run that started, or a model or backend failure', () => {
    expect(isRepoPrepFailure({ turns: 12, failureReason: RESET })).toBe(false);
    expect(isRepoPrepFailure({ turns: 0, failureReason: 'fetch failed' })).toBe(false);
    expect(isRepoPrepFailure({ turns: 0, failureReason: 'per-task timeout after 600000ms' })).toBe(false);
    expect(isRepoPrepFailure({ turns: 0, failureReason: null })).toBe(false);
  });
});

describe('PrepFailureStreak', () => {
  it(`stops after ${PREP_STREAK_LIMIT} prep failures in a row, naming the tasks and the last error`, () => {
    const s = new PrepFailureStreak();
    expect(s.record({ instance_id: 'django__django-14999', turns: 0, failureReason: RESET })).toBeNull();
    expect(s.record({ instance_id: 'django__django-15347', turns: 0, failureReason: RESET })).toBeNull();
    const stop = s.record({ instance_id: 'pytest-dev__pytest-11148', turns: 0, failureReason: CLONE });
    expect(stop).toContain('repository preparation failed for 3 tasks in a row');
    expect(stop).toContain('django__django-14999, django__django-15347, pytest-dev__pytest-11148');
    expect(stop).toContain('git clone --quiet');
  });

  it('a task that runs resets the streak', () => {
    const s = new PrepFailureStreak();
    s.record({ instance_id: 'a', turns: 0, failureReason: RESET });
    s.record({ instance_id: 'b', turns: 0, failureReason: RESET });
    expect(s.record({ instance_id: 'c', turns: 9, failureReason: null })).toBeNull();
    expect(s.record({ instance_id: 'd', turns: 0, failureReason: RESET })).toBeNull();
    expect(s.record({ instance_id: 'e', turns: 0, failureReason: RESET })).toBeNull();
  });

  it('one isolated prep failure never stops a run (a single bad checkout is recorded and skipped)', () => {
    const s = new PrepFailureStreak();
    expect(s.record({ instance_id: 'a', turns: 0, failureReason: RESET })).toBeNull();
    expect(s.record({ instance_id: 'b', turns: 14, failureReason: null })).toBeNull();
  });
});
