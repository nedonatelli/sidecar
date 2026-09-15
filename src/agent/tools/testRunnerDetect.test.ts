import { describe, it, expect } from 'vitest';
import { detectTestRunner, manifestFiles, normalizeTestTarget } from './testRunnerDetect.js';

// The motivating failure is in the module header: on 2026-08-18 `run_tests`
// linted JavaScript on a Django task and reported `ok`, because detection
// asked package.json first. These pin the real repos it got wrong.

describe('detectTestRunner — the Django false pass', () => {
  it('does NOT pick npm on a Python repo that also ships a package.json', () => {
    // Django's package.json test script is `eslint django/ js_tests/...`.
    const d = detectTestRunner(['setup.py', 'setup.cfg', 'tox.ini'], true);
    expect(d.command).not.toBe('npm test');
    expect(d.ecosystem).toBe('python');
    expect(d.ambiguous).toBe(true);
    // The pick must be explainable — a silent wrong choice is the whole defect.
    expect(d.reason).toMatch(/package\.json test script is also present/);
  });

  it.each([
    ['sympy', ['setup.py']],
    ['matplotlib', ['pyproject.toml', 'setup.py']],
    ['scikit-learn', ['setup.py', 'pyproject.toml']],
    ['pytest itself', ['pyproject.toml', 'tox.ini']],
  ])('picks a Python runner for %s even with a package.json present', (_name, files) => {
    expect(detectTestRunner(files, true).ecosystem).toBe('python');
  });
});

describe('detectTestRunner — unambiguous projects', () => {
  it('picks npm when package.json is the only evidence', () => {
    const d = detectTestRunner(['README.md'], true);
    expect(d.command).toBe('npm test');
    expect(d.ambiguous).toBe(false);
  });

  it.each([
    [['pytest.ini'], 'pytest', 'python'],
    [['Cargo.toml'], 'cargo test', 'rust'],
    [['go.mod'], 'go test ./...', 'go'],
    [['build.gradle'], './gradlew test', 'jvm'],
  ])('%s -> %s', (files, command, ecosystem) => {
    const d = detectTestRunner(files, false);
    expect(d.command).toBe(command);
    expect(d.ecosystem).toBe(ecosystem);
    expect(d.ambiguous).toBe(false);
  });

  it('returns null rather than guessing when nothing identifies a runner', () => {
    const d = detectTestRunner(['README.md', 'LICENSE'], false);
    expect(d.command).toBeNull();
    expect(d.reason).toBe('no test manifest found');
  });
});

describe('detectTestRunner — priority', () => {
  it('prefers the most specific Python marker when several are present', () => {
    // pytest.ini is an explicit pytest config; pyproject.toml may be packaging only.
    expect(detectTestRunner(['pyproject.toml', 'pytest.ini'], false).reason).toBe('pytest.ini');
  });

  it('routes a Django project through pytest rather than a bare pytest call', () => {
    expect(detectTestRunner(['manage.py'], false).command).toBe('python -m pytest');
  });

  it('exposes the manifest list the caller must stat', () => {
    const files = manifestFiles();
    expect(files).toContain('pyproject.toml');
    expect(files).toContain('Cargo.toml');
    // Order is the priority order the decision relies on.
    expect(files.indexOf('pytest.ini')).toBeLessThan(files.indexOf('pyproject.toml'));
  });
});

describe('detectTestRunner — project-specific runner scripts', () => {
  it("uses Django's runtests.py rather than bare pytest", () => {
    // The Django repo root has setup.py/setup.cfg/tox.ini, which would
    // otherwise resolve to pytest — and bare pytest cannot run its suite.
    const d = detectTestRunner(['tests/runtests.py', 'setup.py', 'setup.cfg', 'tox.ini'], true);
    expect(d.command).toBe('python tests/runtests.py');
    expect(d.reason).toMatch(/runtests\.py/);
  });

  it("uses sympy's bin/test rather than bare pytest", () => {
    expect(detectTestRunner(['bin/test', 'setup.py'], false).command).toBe('python bin/test');
  });

  it('still falls through to pytest for a plain Python project', () => {
    expect(detectTestRunner(['pyproject.toml'], false).command).toBe('pytest');
  });
});

describe('normalizeTestTarget — the label Django actually accepts', () => {
  it.each([
    ['tests/file_uploads/', 'file_uploads'],
    ['tests/file_uploads', 'file_uploads'],
    ['./tests/file_uploads/tests.py', 'file_uploads.tests'],
    ['tests/utils_tests/test_html.py', 'utils_tests.test_html'],
    ['tests\\file_uploads\\', 'file_uploads'],
  ])('converts the path %s to the label %s', (input, expected) => {
    expect(normalizeTestTarget('python tests/runtests.py', input)).toBe(expected);
  });

  it('leaves an already-dotted label alone', () => {
    expect(normalizeTestTarget('python tests/runtests.py', 'file_uploads.tests')).toBe('file_uploads.tests');
  });

  it('does NOT touch targets for runners that want paths', () => {
    // pytest genuinely takes a path; sympy's bin/test accepts either.
    expect(normalizeTestTarget('pytest', 'tests/file_uploads/test_x.py')).toBe('tests/file_uploads/test_x.py');
    expect(normalizeTestTarget('python bin/test', 'sympy/assumptions/tests/test_matrices.py')).toBe(
      'sympy/assumptions/tests/test_matrices.py',
    );
  });

  it('handles an empty target without producing a stray argument', () => {
    expect(normalizeTestTarget('python tests/runtests.py', '   ')).toBe('');
  });
});
