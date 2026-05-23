import { describe, it, expect } from 'vitest';
import { parseModifiedRanges } from './agentModDecoration.js';

describe('parseModifiedRanges', () => {
  it('returns empty array for empty patch', () => {
    expect(parseModifiedRanges('')).toEqual([]);
  });

  it('returns empty array for removal-only patch', () => {
    const patch = ['--- a/foo.ts', '+++ b/foo.ts', '@@ -1,3 +1,2 @@', ' line one', '-line two', ' line three'].join(
      '\n',
    );
    expect(parseModifiedRanges(patch)).toEqual([]);
  });

  it('returns one range for a simple one-line change', () => {
    const patch = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,3 +1,3 @@',
      ' line one',
      '-line two',
      '+line TWO',
      ' line three',
    ].join('\n');
    const ranges = parseModifiedRanges(patch);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start.line).toBe(1);
    expect(ranges[0].end.line).toBe(1);
  });

  it('merges consecutive added lines into a single range', () => {
    const patch = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,2 +1,4 @@',
      ' context',
      '+added one',
      '+added two',
      '+added three',
      ' end',
    ].join('\n');
    const ranges = parseModifiedRanges(patch);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start.line).toBe(1);
    expect(ranges[0].end.line).toBe(3);
  });

  it('only includes + lines, not context lines', () => {
    const patch = [
      '--- a/foo.ts',
      '+++ b/foo.ts',
      '@@ -1,5 +1,5 @@',
      ' context before',
      ' context before 2',
      '-removed',
      '+added',
      ' context after',
      ' context after 2',
    ].join('\n');
    const ranges = parseModifiedRanges(patch);
    expect(ranges).toHaveLength(1);
    expect(ranges[0].start.line).toBe(2);
    expect(ranges[0].end.line).toBe(2);
  });
});
