import { describe, it, expect } from 'vitest';
import { wilsonInterval, binomCdf, mcnemarExactP, pairedDiffCI } from './stats.js';

const near = (a: number, b: number, eps = 1e-3): boolean => Math.abs(a - b) <= eps;

describe('wilsonInterval', () => {
  it('matches the known 95% interval for 5/10', () => {
    const { low, high } = wilsonInterval(5, 10);
    expect(near(low, 0.2366)).toBe(true);
    expect(near(high, 0.7634)).toBe(true);
  });

  it('stays in [0,1] at the boundaries (0/10 and 10/10)', () => {
    const zero = wilsonInterval(0, 10);
    expect(zero.low).toBe(0);
    expect(near(zero.high, 0.2775, 2e-3)).toBe(true);
    const all = wilsonInterval(10, 10);
    expect(all.high).toBe(1);
    expect(near(all.low, 0.7225, 2e-3)).toBe(true);
  });

  it('returns maximal uncertainty for n=0', () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe('binomCdf', () => {
  it('P(X≤0) and P(X≤n) for Binom(n,0.5)', () => {
    expect(near(binomCdf(0, 10, 0.5), Math.pow(0.5, 10))).toBe(true);
    expect(binomCdf(10, 10, 0.5)).toBe(1);
  });
  it('P(X≤5 | Binom(10,0.5)) ≈ 0.623', () => {
    expect(near(binomCdf(5, 10, 0.5), 0.623)).toBe(true);
  });
  it('clamps k out of range', () => {
    expect(binomCdf(-3, 10, 0.5)).toBe(binomCdf(0, 10, 0.5));
    expect(binomCdf(99, 10, 0.5)).toBe(1);
  });
});

describe('mcnemarExactP', () => {
  it('no discordant pairs ⇒ p=1 (no evidence)', () => {
    expect(mcnemarExactP(0, 0)).toBe(1);
  });

  it('5 rescued / 0 regressed = 0.0625 (not yet significant)', () => {
    expect(near(mcnemarExactP(5, 0), 0.0625)).toBe(true);
    expect(mcnemarExactP(5, 0) < 0.05).toBe(false);
  });

  it('6 rescued / 0 regressed crosses 0.05', () => {
    expect(near(mcnemarExactP(6, 0), 0.03125)).toBe(true);
    expect(mcnemarExactP(6, 0) < 0.05).toBe(true);
  });

  it('8 / 2 ≈ 0.109', () => {
    expect(near(mcnemarExactP(8, 2), 0.1094)).toBe(true);
  });

  it('is symmetric in rescued/regressed', () => {
    expect(mcnemarExactP(8, 2)).toBe(mcnemarExactP(2, 8));
  });

  it('caps at 1 for a balanced split', () => {
    expect(mcnemarExactP(3, 3)).toBe(1);
  });
});

describe('pairedDiffCI', () => {
  it('CI for 5 rescued / 0 regressed over 50 tasks', () => {
    const { low, high } = pairedDiffCI(5, 0, 50);
    expect(near(low, 0.0168, 2e-3)).toBe(true);
    expect(near(high, 0.1832, 2e-3)).toBe(true);
  });

  it('is centered on the lift and symmetric for balanced discordant counts', () => {
    const { low, high } = pairedDiffCI(4, 4, 50); // diff 0
    expect(near((low + high) / 2, 0)).toBe(true);
  });

  it('total=0 ⇒ [0,0]', () => {
    expect(pairedDiffCI(0, 0, 0)).toEqual({ low: 0, high: 0 });
  });
});
