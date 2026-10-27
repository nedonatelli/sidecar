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
// were reported as "N consecutive calls rejected for the same reason".
describe('tool-error streaks are per failure (#161 ML-72)', () => {
  const sig = (path: string, msg: string) => failureSignature({ path }, msg);

  it("the issue's case: three different failures never claim 'the same reason'", () => {
    const counts = new Map<string, number>();
    const a = recordToolErrorBounce(
      counts,
      'edit_file',
      sig('a.py', 'edit_file failed — search string not found in a.py.'),
    );
    const b = recordToolErrorBounce(
      counts,
      'edit_file',
      sig('b.py', 'edit_file failed — search and replace text are identical'),
    );
    const c = recordToolErrorBounce(
      counts,
      'edit_file',
      sig('c.py', 'edit_file failed — search string appears 3 times in c.py.'),
    );
    expect([a, b, c]).toEqual([1, 1, 1]);
    expect(escalationSuffix(c, 'edit_file')).toBe('');
  });

  it('three identical failures in a row still escalate', () => {
    const counts = new Map<string, number>();
    const s = sig('a.py', 'edit_file failed — search string not found in a.py.');
    const n = [1, 2, 3].map(() => recordToolErrorBounce(counts, 'edit_file', s));
    expect(n).toEqual([1, 2, 3]);
    expect(escalationSuffix(n[2], 'edit_file')).toContain('CRITICAL: 3 consecutive edit_file calls');
  });

  it('the same failure with different numbers or quoted text is the same reason', () => {
    expect(sig('a.py', "search string appears 3 times in `a.py` near 'foo'")).toBe(
      sig('a.py', "search string appears 7 times in `a.py` near 'bar'"),
    );
    expect(sig('a.py', 'not found')).not.toBe(sig('b.py', 'not found'));
  });

  it('a different failure in between resets the streak (consecutive means consecutive)', () => {
    const counts = new Map<string, number>();
    const x = sig('a.py', 'not found'),
      y = sig('a.py', 'identical');
    recordToolErrorBounce(counts, 'edit_file', x);
    recordToolErrorBounce(counts, 'edit_file', y);
    expect(recordToolErrorBounce(counts, 'edit_file', x)).toBe(1);
  });

  it('a successful call clears the streak (clearBounces), and other tools keep theirs', () => {
    const counts = new Map<string, number>();
    const s = sig('a.py', 'not found');
    recordToolErrorBounce(counts, 'edit_file', s);
    recordToolErrorBounce(counts, 'edit_file', s);
    recordToolErrorBounce(counts, 'read_file', s);
    clearBounces(counts, 'edit_file');
    expect(recordToolErrorBounce(counts, 'edit_file', s)).toBe(1);
    expect(recordToolErrorBounce(counts, 'read_file', s)).toBe(2);
  });

  it('reportsOwnRepeat recognises edit_file messages that already say it is a repeat', () => {
    expect(reportsOwnRepeat('edit_file failed AGAIN — you resubmitted the EXACT SAME search')).toBe(true);
    expect(reportsOwnRepeat('This is the same call refused 2 times in a row')).toBe(true);
    expect(reportsOwnRepeat('edit_file failed — search string not found')).toBe(false);
  });
});
