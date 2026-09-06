import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listTestModules, renderTestModuleHint } from './testModules.js';

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
