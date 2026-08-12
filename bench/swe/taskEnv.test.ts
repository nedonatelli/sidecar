import { describe, it, expect } from 'vitest';
import { pythonForUv, setupTaskEnv, type SpecMap } from './taskEnv.js';

describe('pythonForUv', () => {
  it('substitutes sub-3.8 pins up to 3.8 (uv standalone-CPython floor)', () => {
    expect(pythonForUv('3.6')).toBe('3.8');
    expect(pythonForUv('3.7')).toBe('3.8');
  });
  it('passes through 3.8+ unchanged', () => {
    expect(pythonForUv('3.8')).toBe('3.8');
    expect(pythonForUv('3.9')).toBe('3.9');
    expect(pythonForUv('3.11')).toBe('3.11');
  });
});

describe('setupTaskEnv — null paths (no venv build, no uv needed)', () => {
  const specs: SpecMap = { 'django/django': { '3.0': { python: '3.6', install: 'pip install -e .' } } };

  it('returns null for native-dep repos (container fallback)', () => {
    expect(setupTaskEnv('scikit-learn/scikit-learn', '1.3', '/tmp/x', '/tmp/c', specs)).toBeNull();
    expect(setupTaskEnv('matplotlib/matplotlib', '3.7', '/tmp/x', '/tmp/c', specs)).toBeNull();
  });

  it('returns null when no spec exists for the repo/version', () => {
    expect(setupTaskEnv('django/django', '9.9', '/tmp/x', '/tmp/c', specs)).toBeNull();
    expect(setupTaskEnv('unknown/repo', '1.0', '/tmp/x', '/tmp/c', specs)).toBeNull();
  });
});
