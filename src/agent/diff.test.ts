import { describe, it, expect } from 'vitest';
import { computeUnifiedDiff } from './diff.js';

describe('computeUnifiedDiff', () => {
  it('returns empty string when original equals current', () => {
    expect(computeUnifiedDiff('file.ts', 'hello', 'hello')).toBe('');
  });

  it('produces all-add diff for a new file', () => {
    const diff = computeUnifiedDiff('new.ts', null, 'line1\nline2\nline3');
    expect(diff).toContain('--- a/new.ts');
    expect(diff).toContain('+++ b/new.ts');
    expect(diff).toContain('@@ -0,0 +1,3 @@');
    expect(diff).toContain('+line1');
    expect(diff).toContain('+line2');
    expect(diff).toContain('+line3');
  });

  it('produces all-delete diff for a deleted file', () => {
    const diff = computeUnifiedDiff('old.ts', 'line1\nline2', null);
    expect(diff).toContain('@@ -1,2 +0,0 @@');
    expect(diff).toContain('-line1');
    expect(diff).toContain('-line2');
  });

  it('shows correct hunks for a modified file', () => {
    const original = 'aaa\nbbb\nccc\nddd\neee';
    const current = 'aaa\nbbb\nCCC\nddd\neee';
    const diff = computeUnifiedDiff('mod.ts', original, current);
    expect(diff).toContain('-ccc');
    expect(diff).toContain('+CCC');
    // Context lines should be present
    expect(diff).toContain(' bbb');
    expect(diff).toContain(' ddd');
  });

  it('truncates output at maxLines', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line${i}`);
    const diff = computeUnifiedDiff('big.ts', null, lines.join('\n'), 20);
    expect(diff).toContain('(truncated)');
    expect(diff.split('\n').length).toBeLessThanOrEqual(21);
  });

  it('handles single-line change', () => {
    const diff = computeUnifiedDiff('f.ts', 'old', 'new');
    expect(diff).toContain('-old');
    expect(diff).toContain('+new');
  });

  it('handles empty original and empty current', () => {
    const diff = computeUnifiedDiff('f.ts', '', '');
    expect(diff).toBe('');
  });

  it('handles adding lines at the end', () => {
    const diff = computeUnifiedDiff('f.ts', 'a\nb', 'a\nb\nc');
    expect(diff).toContain('+c');
    expect(diff).not.toContain('-a');
    expect(diff).not.toContain('-b');
  });

  it('handles removing lines from the middle', () => {
    const diff = computeUnifiedDiff('f.ts', 'a\nb\nc\nd', 'a\nd');
    expect(diff).toContain('-b');
    expect(diff).toContain('-c');
    expect(diff).not.toContain('-a');
    expect(diff).not.toContain('-d');
  });
});
