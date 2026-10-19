import { describe, it, expect } from 'vitest';
import { editableTarget, pythonForUv, setupPyPins, setupTaskEnv, usesPytest, type SpecMap } from './taskEnv.js';

describe('setupPyPins (#216)', () => {
  it("turns sphinx's setup.py sed pins into constraints", () => {
    expect(
      setupPyPins([
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py",
        "sed -i 's/alabaster>=0.7,<0.8/alabaster>=0.7,<0.7.12/' setup.py",
        `sed -i "s/'packaging',/'packaging', 'markupsafe<=2.0.1',/" setup.py`,
      ]),
    ).toEqual(['Jinja2<3.0', 'alabaster>=0.7,<0.7.12', 'markupsafe<=2.0.1']);
  });
  it('ignores non-setup.py and non-sed steps', () => {
    expect(setupPyPins(["sed -i 's/x/y<1/' pyproject.toml", 'apt-get install -y ffmpeg'])).toEqual([]);
    expect(setupPyPins(undefined)).toEqual([]);
  });
});

describe('usesPytest (#216)', () => {
  it('is true for the pytest and tox test commands in env-specs.json', () => {
    expect(usesPytest('pytest -rA')).toBe(true);
    expect(usesPytest('pytest --no-header -rA')).toBe(true);
    expect(usesPytest('tox --current-env -epy39 -v --')).toBe(true);
  });
  it('is false for django, sympy and a missing command', () => {
    expect(usesPytest('./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1')).toBe(false);
    expect(usesPytest("PYTHONWARNINGS='ignore::UserWarning' bin/test -C --verbose")).toBe(false);
    expect(usesPytest(undefined)).toBe(false);
  });
});

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

describe('editableTarget (#216)', () => {
  it('keeps the extras from the spec install command', () => {
    expect(editableTarget('python -m pip install -e .[test]')).toBe('.[test]');
    expect(editableTarget('python -m pip install -e .[dev]')).toBe('.[dev]');
    expect(editableTarget('python -m pip install -e .[test] --verbose')).toBe('.[test]');
  });
  it('is a bare . when the install names no extras', () => {
    expect(editableTarget('python -m pip install -e .')).toBe('.');
    expect(editableTarget('python -m pip install .')).toBe('.');
    expect(editableTarget(undefined)).toBe('.');
  });
});
