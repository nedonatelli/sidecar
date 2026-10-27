import { describe, it, expect } from 'vitest';
import {
  recordBounce,
  clearBounces,
  escalationSuffix,
  failureSignature,
  recordToolErrorBounce,
  reportsOwnRepeat,
} from './bounceEscalation.js';

describe('recordBounce / clearBounces', () => {
  it('counts consecutively per (tool, kind)', () => {
    const counts = new Map<string, number>();
    expect(recordBounce(counts, 'edit_file', 'schema')).toBe(1);
    expect(recordBounce(counts, 'edit_file', 'schema')).toBe(2);
    expect(recordBounce(counts, 'edit_file', 'schema')).toBe(3);
  });

  it('tracks kinds independently for the same tool', () => {
    const counts = new Map<string, number>();
    recordBounce(counts, 'ask_user', 'schema');
    recordBounce(counts, 'ask_user', 'schema');
    expect(recordBounce(counts, 'ask_user', 'example-replay')).toBe(1);
    expect(recordBounce(counts, 'ask_user', 'schema')).toBe(3);
  });

  it('clearBounces removes every kind for the tool and only that tool', () => {
    const counts = new Map<string, number>();
    recordBounce(counts, 'edit_file', 'schema');
    recordBounce(counts, 'edit_file', 'malformed-json');
    recordBounce(counts, 'write_file', 'schema');
    clearBounces(counts, 'edit_file');
    expect(recordBounce(counts, 'edit_file', 'schema')).toBe(1);
    expect(recordBounce(counts, 'write_file', 'schema')).toBe(2);
  });

  it('a tool name that prefixes another tool name never clears the longer name', () => {
    const counts = new Map<string, number>();
    recordBounce(counts, 'read', 'schema');
    recordBounce(counts, 'read_file', 'schema');
    clearBounces(counts, 'read');
    expect(recordBounce(counts, 'read_file', 'schema')).toBe(2);
  });

  it('is a no-op without a map (unit tests / non-loop calls)', () => {
    expect(recordBounce(undefined, 'edit_file', 'schema')).toBe(1);
    expect(() => clearBounces(undefined, 'edit_file')).not.toThrow();
  });
});

describe('escalationSuffix', () => {
  it('is empty on the first bounce', () => {
    expect(escalationSuffix(1, 'edit_file')).toBe('');
  });

  it('warns against resubmission on the second bounce', () => {
    const s = escalationSuffix(2, 'edit_file');
    expect(s).toContain('2nd consecutive edit_file call');
    expect(s).toContain('Do not resubmit');
  });

  it('escalates to abandon-the-approach from the third bounce on', () => {
    const s = escalationSuffix(3, 'edit_file');
    expect(s).toContain('CRITICAL: 3 consecutive edit_file calls');
    expect(s).toContain('Stop retrying');
    expect(escalationSuffix(5, 'edit_file')).toContain('5 consecutive');
  });
});

// #161 ML-72: tool errors shared one streak per tool name, so unrelated failures
// were reported as "N consecutive calls rejected for the same reason". The fix
// keeps the streak (it is what makes a stuck run stop) and drops only the claim.
describe('tool-error streaks: same thresholds, honest reason (#161 ML-72)', () => {
  const sig = (path: string, msg: string) => failureSignature({ path }, msg);
  const notFound = sig('a.py', 'edit_file failed — search string not found in a.py.');
  const noop = sig('b.py', 'edit_file failed — search and replace text are identical');
  const multi = sig('c.py', 'edit_file failed — search string appears 3 times in c.py.');

  it("the issue's case: three different failures still escalate, without claiming 'the same reason'", () => {
    const counts = new Map<string, number>();
    const r = [notFound, noop, multi].map((s) => recordToolErrorBounce(counts, 'edit_file', s));
    expect(r).toEqual([
      { count: 1, sameReason: true },
      { count: 2, sameReason: false },
      { count: 3, sameReason: false },
    ]);
    const s = escalationSuffix(3, 'edit_file', false);
    expect(s).toContain('CRITICAL: 3 consecutive edit_file calls have failed, not all for the same reason');
    expect(s).toContain('Stop retrying');
    expect(s).not.toContain('rejected for the same reason');
  });

  it('three identical failures in a row escalate with the same-reason wording', () => {
    const counts = new Map<string, number>();
    const r = [1, 2, 3].map(() => recordToolErrorBounce(counts, 'edit_file', notFound));
    expect(r.map((x) => x.count)).toEqual([1, 2, 3]);
    expect(r.every((x) => x.sameReason)).toBe(true);
    expect(escalationSuffix(3, 'edit_file', true)).toContain('CRITICAL: 3 consecutive edit_file calls');
  });

  it('a run is the same reason only if every failure in it is: A, B, B is mixed', () => {
    const counts = new Map<string, number>();
    recordToolErrorBounce(counts, 'edit_file', notFound);
    recordToolErrorBounce(counts, 'edit_file', noop);
    expect(recordToolErrorBounce(counts, 'edit_file', noop)).toEqual({ count: 3, sameReason: false });
  });

  it('the 2nd-call warning for a different failure does not tell the model it resubmitted', () => {
    const s = escalationSuffix(2, 'edit_file', false);
    expect(s).toContain('2nd consecutive edit_file call to fail, for a different reason');
    expect(s).not.toContain('Do not resubmit');
  });

  it('the same failure with different numbers or quoted text is the same reason', () => {
    expect(sig('a.py', "search string appears 3 times in `a.py` near 'foo'")).toBe(
      sig('a.py', "search string appears 7 times in `a.py` near 'bar'"),
    );
    expect(sig('a.py', 'not found')).not.toBe(sig('b.py', 'not found'));
  });

  it('a successful call clears the streak (clearBounces), and other tools keep theirs', () => {
    const counts = new Map<string, number>();
    recordToolErrorBounce(counts, 'edit_file', notFound);
    recordToolErrorBounce(counts, 'edit_file', noop);
    recordToolErrorBounce(counts, 'read_file', notFound);
    clearBounces(counts, 'edit_file');
    expect(recordToolErrorBounce(counts, 'edit_file', noop)).toEqual({ count: 1, sameReason: true });
    expect(recordToolErrorBounce(counts, 'read_file', notFound)).toEqual({ count: 2, sameReason: true });
  });

  it('is a no-op without a map', () => {
    expect(recordToolErrorBounce(undefined, 'edit_file', notFound)).toEqual({ count: 1, sameReason: true });
  });

  it('reportsOwnRepeat recognises edit_file messages that already say it is a repeat', () => {
    expect(reportsOwnRepeat('edit_file failed AGAIN — you resubmitted the EXACT SAME search')).toBe(true);
    expect(reportsOwnRepeat('This is the same call refused 2 times in a row')).toBe(true);
    expect(reportsOwnRepeat('edit_file failed — search string not found')).toBe(false);
  });
});
