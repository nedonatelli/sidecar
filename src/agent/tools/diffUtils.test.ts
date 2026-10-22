import { describe, it, expect } from 'vitest';
import { computeLineDiff } from './diffUtils.js';

describe('computeLineDiff', () => {
  it('returns empty string when texts are identical', () => {
    const text = 'line one\nline two\nline three';
    expect(computeLineDiff(text, text, 'foo.ts')).toBe('');
  });

  it('produces a unified diff with --- +++ @@ headers for a single-line change', () => {
    const old = 'line one\nline two\nline three';
    const next = 'line one\nline TWO\nline three';
    const diff = computeLineDiff(old, next, 'src/foo.ts');
    expect(diff).toContain('--- a/src/foo.ts');
    expect(diff).toContain('+++ b/src/foo.ts');
    expect(diff).toContain('@@');
    expect(diff).toContain('-line two');
    expect(diff).toContain('+line TWO');
  });

  it('produces a diff with additions when old text is empty', () => {
    const diff = computeLineDiff('', 'hello\nworld', 'new.ts');
    expect(diff).toContain('+hello');
    expect(diff).toContain('+world');
    expect(diff).toContain('--- a/new.ts');
    expect(diff).toContain('+++ b/new.ts');
  });

  it('returns empty string when old text is empty and new text is also empty', () => {
    expect(computeLineDiff('', '', 'x.ts')).toBe('');
  });

  // #165 ML-36: an end index of 0 was read as "to the end", so these listed the
  // whole file as deleted (or added).
  it('an insert above line 1 shows only the inserted line', () => {
    const diff = computeLineDiff('a\nb\nc', 'x\na\nb\nc', 'f.ts');
    const body = diff.split('\n').slice(3);
    expect(body).toEqual(['+x', ' a', ' b', ' c']);
    expect(diff).toContain('@@ -1,3 +1,4 @@');
  });

  it('deleting line 1 shows only the deleted line', () => {
    const diff = computeLineDiff('a\nb\nc', 'b\nc', 'f.ts');
    expect(diff.split('\n').slice(3)).toEqual(['-a', ' b', ' c']);
    expect(diff).toContain('@@ -1,3 +1,2 @@');
  });

  it('replacing line 1 still shows one removal and one addition', () => {
    const diff = computeLineDiff('a\nb\nc', 'A\nb\nc', 'f.ts');
    expect(diff.split('\n').slice(3)).toEqual(['-a', '+A', ' b', ' c']);
  });
});
