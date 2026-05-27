import { describe, it, expect } from 'vitest';
import { cosine } from './math.js';

describe('cosine', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = new Float32Array([1, 0, 0]);
    expect(cosine(v, v)).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosine(a, b)).toBeCloseTo(0);
  });

  it('returns -1 for opposite unit vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosine(a, b)).toBeCloseTo(-1);
  });

  it('computes dot product correctly for multi-dimension vectors', () => {
    const a = new Float32Array([0.6, 0.8]);
    const b = new Float32Array([0.8, 0.6]);
    expect(cosine(a, b)).toBeCloseTo(0.6 * 0.8 + 0.8 * 0.6);
  });

  it('truncates to the shorter vector when lengths differ', () => {
    const a = new Float32Array([1, 0, 0, 999]);
    const b = new Float32Array([1, 0, 0]);
    // Only first 3 elements used; last element of a is ignored
    expect(cosine(a, b)).toBeCloseTo(1);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosine(new Float32Array([]), new Float32Array([]))).toBe(0);
  });
});
