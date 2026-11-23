import { describe, it, expect } from 'vitest';
import { hasLocalEnv } from './taskEnv.js';

// #472: the native-dependency list was written for arm64 Macs. seaborn and
// xarray are pure Python with Windows wheels for their pins, so they get a
// venv there; the repos that build C extensions still do not.

describe('hasLocalEnv (#472)', () => {
  it('builds an environment for pure-Python repos everywhere', () => {
    for (const platform of ['win32', 'darwin', 'linux'] as const) {
      expect(hasLocalEnv('django/django', platform)).toBe(true);
      expect(hasLocalEnv('sympy/sympy', platform)).toBe(true);
    }
  });

  it('builds one for seaborn and xarray on Windows only', () => {
    expect(hasLocalEnv('mwaskom/seaborn', 'win32')).toBe(true);
    expect(hasLocalEnv('pydata/xarray', 'win32')).toBe(true);
    expect(hasLocalEnv('mwaskom/seaborn', 'darwin')).toBe(false);
    expect(hasLocalEnv('pydata/xarray', 'linux')).toBe(false);
  });

  it('builds none for repos with C extensions of their own', () => {
    for (const repo of ['matplotlib/matplotlib', 'scikit-learn/scikit-learn', 'astropy/astropy']) {
      expect(hasLocalEnv(repo, 'win32')).toBe(false);
    }
  });
});
