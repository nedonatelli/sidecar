import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listTestModules, renderTestModuleHint, runnerFamily, renderPathRunnerInstructions } from './testModules.js';

let repo: string;

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-testmods-'));
  const tests = path.join(repo, 'tests');
  for (const d of ['file_uploads', 'auth_tests', 'utils_tests', '__pycache__']) {
    fs.mkdirSync(path.join(tests, d), { recursive: true });
  }
  // Loose files in tests/ are not labels.
  fs.writeFileSync(path.join(tests, 'runtests.py'), '');
  fs.writeFileSync(path.join(tests, 'README.rst'), '');
});

afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));

describe('listTestModules', () => {
  it('returns the directory names under tests/', () => {
    expect(listTestModules(repo)).toEqual(['auth_tests', 'file_uploads', 'utils_tests']);
  });

  it('excludes __pycache__', () => {
    expect(listTestModules(repo)).not.toContain('__pycache__');
  });

  it('excludes loose files like runtests.py and README.rst', () => {
    const mods = listTestModules(repo);
    expect(mods).not.toContain('runtests.py');
    expect(mods).not.toContain('README.rst');
  });

  it('returns sorted names for a stable prompt across runs', () => {
    expect(listTestModules(repo)).toEqual([...listTestModules(repo)].sort());
  });

  it('returns empty when there is no tests/ directory', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-bare-'));
    expect(listTestModules(bare)).toEqual([]);
    fs.rmSync(bare, { recursive: true, force: true });
  });

  it('returns empty for a nonexistent path rather than throwing', () => {
    expect(listTestModules('/nope/does/not/exist')).toEqual([]);
  });
});

describe('renderTestModuleHint', () => {
  it('renders the labels as a comma list', () => {
    const hint = renderTestModuleHint(repo);
    expect(hint).toContain('file_uploads');
    expect(hint).toContain('auth_tests');
  });

  it('says the labels come from the test directory, not the source tree', () => {
    expect(renderTestModuleHint(repo).toLowerCase()).toContain('source');
  });

  it('returns empty string when there are no modules, so the prompt stays clean', () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-bare2-'));
    expect(renderTestModuleHint(bare)).toBe('');
    fs.rmSync(bare, { recursive: true, force: true });
  });
});

// #213: path-based runners were given Django's dotted-label instructions.
describe('runner-specific test instructions (#213)', () => {
  const RUNNERS = {
    django: './tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1',
    pytest: 'pytest -rA',
    seaborn: 'pytest --no-header -rA',
    tox: 'tox --current-env -epy39 -v --',
    sympy: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
  };

  it('classifies each canary runner', () => {
    expect(runnerFamily(RUNNERS.django)).toBe('django');
    expect(runnerFamily(RUNNERS.pytest)).toBe('pytest');
    expect(runnerFamily(RUNNERS.seaborn)).toBe('pytest');
    expect(runnerFamily(RUNNERS.tox)).toBe('tox');
    expect(runnerFamily(RUNNERS.sympy)).toBe('sympy');
    expect(runnerFamily('make check')).toBe('other');
  });

  it('leaves Django (and unknown runners) on the existing dotted-label text', () => {
    expect(renderPathRunnerInstructions(RUNNERS.django, 'django', repo)).toBeNull();
    expect(renderPathRunnerInstructions('make check', 'other', repo)).toBeNull();
  });

  it('tells pytest to target a test file path, with a real example from the repo', () => {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-pytest-'));
    try {
      fs.mkdirSync(path.join(r, 'testing'));
      fs.writeFileSync(path.join(r, 'testing', 'test_skipping.py'), '');
      const text = renderPathRunnerInstructions(RUNNERS.pytest, 'pytest', r)!;
      expect(text).toContain('pytest -rA testing/test_skipping.py');
      expect(text).toContain('::TestClass::test_name');
      expect(text).toContain('`testing.test_skipping`'); // named as the WRONG form
      expect(text).toMatch(/selects NO tests/);
      expect(text).not.toMatch(/use dots, not slashes/);
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  });

  it('gives tox the same file-path form after its -- separator', () => {
    const text = renderPathRunnerInstructions(RUNNERS.tox, 'tox', repo)!;
    expect(text).toContain('tox --current-env -epy39 -v -- tests/test_<module>.py');
  });

  it('gives sympy bin/test a test file path under the package, without a pytest node id', () => {
    const text = renderPathRunnerInstructions(RUNNERS.sympy, 'sympy', repo)!;
    expect(text).toContain('bin/test -C --verbose sympy/<area>/tests/test_<module>.py');
    expect(text).not.toContain('::TestClass');
    // bin/test matches a bare name as a keyword (`test_basic` ran 16 tests in
    // sympy's venv); only the dotted form selects nothing.
    expect(text).toContain('`sympy.<area>.tests.test_<module>`');
    expect(text).not.toMatch(/bare name/);
  });

  it('does not carry the regression-check advice, which is a separate candidate (#214 A2)', () => {
    expect(renderPathRunnerInstructions(RUNNERS.pytest, 'pytest', repo)!).not.toMatch(/previously passing/);
  });
});
