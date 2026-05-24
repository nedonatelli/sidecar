import { describe, it, expect } from 'vitest';
import { computeUnifiedDiff, diffStats } from './unifiedDiff.js';

describe('diffStats', () => {
  it('returns zero for identical strings', () => {
    expect(diffStats('hello\nworld', 'hello\nworld')).toEqual({ added: 0, removed: 0 });
  });

  it('counts added lines', () => {
    const { added, removed } = diffStats('a\nb', 'a\nb\nc');
    expect(added).toBe(1);
    expect(removed).toBe(0);
  });

  it('counts removed lines', () => {
    const { added, removed } = diffStats('a\nb\nc', 'a\nc');
    expect(added).toBe(0);
    expect(removed).toBe(1);
  });

  it('counts both added and removed for substitution', () => {
    const { added, removed } = diffStats('a\nb\nc', 'a\nX\nc');
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });
});

describe('computeUnifiedDiff', () => {
  it('returns empty string for identical inputs', () => {
    expect(computeUnifiedDiff('foo\nbar', 'foo\nbar')).toBe('');
  });

  it('marks added lines with "+"', () => {
    const diff = computeUnifiedDiff('a\nb', 'a\nb\nc');
    expect(diff).toContain('+c');
  });

  it('marks removed lines with "-"', () => {
    const diff = computeUnifiedDiff('a\nb\nc', 'a\nc');
    expect(diff).toContain('-b');
  });

  it('includes context lines around changes', () => {
    const original = Array.from({ length: 20 }, (_, i) => `line${i}`).join('\n');
    const proposed = original.replace('line10', 'CHANGED');
    const diff = computeUnifiedDiff(original, proposed);
    // Line 7–9 are context before the change at line 10
    expect(diff).toContain(' line9');
    expect(diff).toContain('-line10');
    expect(diff).toContain('+CHANGED');
    expect(diff).toContain(' line11');
  });

  it('uses @@ as hunk separator when changes are far apart', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line${i}`);
    lines[2] = 'CHANGED_A';
    lines[48] = 'CHANGED_B';
    const original = Array.from({ length: 50 }, (_, i) => `line${i}`).join('\n');
    const proposed = lines.join('\n');
    const diff = computeUnifiedDiff(original, proposed);
    expect(diff).toContain('@@');
  });

  it('preserves equal lines as " line" prefix', () => {
    const diff = computeUnifiedDiff('a\nb\nc', 'a\nX\nc');
    expect(diff).toContain(' a');
    expect(diff).toContain(' c');
  });

  it('handles adding to an empty file', () => {
    const diff = computeUnifiedDiff('', 'hello\nworld');
    expect(diff).toContain('+hello');
    expect(diff).toContain('+world');
  });

  it('handles removing all content', () => {
    const diff = computeUnifiedDiff('hello\nworld', '');
    expect(diff).toContain('-hello');
    expect(diff).toContain('-world');
  });

  it('falls back to summary message for oversized files', () => {
    const big = Array.from({ length: 301 }, (_, i) => `line${i}`).join('\n');
    const diff = computeUnifiedDiff(big, big + '\nextra');
    expect(diff).toMatch(/too large|lines added/);
  });
});
