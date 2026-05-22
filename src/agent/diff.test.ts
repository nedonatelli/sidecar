import { describe, it, expect } from 'vitest';
import { computeUnifiedDiff, computeHunks, applySelectedHunks } from './diff.js';

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

describe('computeHunks', () => {
  it('returns empty array when content is identical', () => {
    expect(computeHunks('a\nb\nc', 'a\nb\nc')).toEqual([]);
  });

  it('returns one hunk for a single-region change', () => {
    const hunks = computeHunks('a\nb\nc\nd\ne', 'a\nb\nC\nd\ne');
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines.some((l) => l === '-c')).toBe(true);
    expect(hunks[0].lines.some((l) => l === '+C')).toBe(true);
  });

  it('returns two hunks for changes in separate regions', () => {
    const original = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const modified = original.replace('line2', 'LINE2').replace('line17', 'LINE17');
    const hunks = computeHunks(original, modified);
    expect(hunks).toHaveLength(2);
  });
});

describe('applySelectedHunks', () => {
  it('returns original unchanged when no hunks selected', () => {
    const original = 'a\nb\nc\nd\ne';
    const current = 'a\nb\nC\nd\ne';
    const hunks = computeHunks(original, current);
    expect(applySelectedHunks(original, hunks, new Set())).toBe(original);
  });

  it('returns fully modified content when all hunks selected', () => {
    const original = 'a\nb\nc\nd\ne';
    const current = 'a\nb\nC\nd\ne';
    const hunks = computeHunks(original, current);
    expect(applySelectedHunks(original, hunks, new Set([0]))).toBe(current);
  });

  it('applies only the selected hunk when two hunks exist', () => {
    // Use a long file so the two changes are in separate hunks
    const lines = Array.from({ length: 20 }, (_, i) => `line${i}`);
    const original = lines.join('\n');
    const modifiedLines = [...lines];
    modifiedLines[2] = 'LINE2';
    modifiedLines[17] = 'LINE17';
    const current = modifiedLines.join('\n');

    const hunks = computeHunks(original, current);
    expect(hunks).toHaveLength(2);

    // Accept only hunk 0 (line2 change)
    const result0 = applySelectedHunks(original, hunks, new Set([0]));
    const resultLines0 = result0.split('\n');
    expect(resultLines0[2]).toBe('LINE2');
    expect(resultLines0[17]).toBe('line17'); // unchanged

    // Accept only hunk 1 (line17 change)
    const result1 = applySelectedHunks(original, hunks, new Set([1]));
    const resultLines1 = result1.split('\n');
    expect(resultLines1[2]).toBe('line2'); // unchanged
    expect(resultLines1[17]).toBe('LINE17');
  });

  it('returns original when hunks array is empty', () => {
    expect(applySelectedHunks('a\nb', [], new Set())).toBe('a\nb');
  });

  it('preserves lines before and after all hunks', () => {
    const original = 'first\nchange-me\nlast';
    const current = 'first\nCHANGED\nlast';
    const hunks = computeHunks(original, current);
    const result = applySelectedHunks(original, hunks, new Set([0]));
    expect(result.startsWith('first\n')).toBe(true);
    expect(result.endsWith('\nlast')).toBe(true);
  });
});
