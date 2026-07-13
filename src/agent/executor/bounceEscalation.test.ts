import { describe, it, expect } from 'vitest';
import { recordBounce, clearBounces, escalationSuffix } from './bounceEscalation.js';

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
