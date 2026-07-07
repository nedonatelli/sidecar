import { describe, it, expect } from 'vitest';
import { extractTerms, selectRelevantFiles } from './retrieve.js';
import type { RepoFile } from './retrieve.js';

describe('extractTerms', () => {
  it('pulls CapWords, code identifiers, and backticked symbols; drops stopwords', () => {
    const terms = extractTerms('Require a non-empty name for Blueprints. Raise a `ValueError` when name is empty.');
    expect(terms).toContain('blueprints');
    expect(terms).toContain('valueerror');
    expect(terms).toContain('name');
    expect(terms).toContain('empty');
    // stopwords / short words excluded
    expect(terms).not.toContain('the');
    expect(terms).not.toContain('a');
  });

  it('captures snake_case and camelCase identifiers', () => {
    const terms = extractTerms('the get_loader call and parseConfig helper');
    expect(terms).toContain('get_loader');
    expect(terms).toContain('parseconfig');
  });
});

describe('selectRelevantFiles', () => {
  const files: RepoFile[] = [
    {
      path: 'src/flask/blueprints.py',
      content: 'class Blueprint:\n  def __init__(self, name):\n    if "." in name: raise ValueError()',
    },
    { path: 'src/flask/app.py', content: 'class Flask:\n  def run(self): pass' },
    { path: 'tests/test_blueprints.py', content: 'def test_blueprint(): Blueprint("x")' },
    { path: 'docs/index.rst', content: 'welcome to flask' },
  ];

  it('ranks the source file whose path+content match the issue first', () => {
    const top = selectRelevantFiles(files, 'Blueprint name should not be empty, raise ValueError', 3);
    expect(top[0].path).toBe('src/flask/blueprints.py');
    expect(top.map((f) => f.path)).not.toContain('docs/index.rst'); // no term overlap
  });

  it('down-weights test files below the source file', () => {
    const top = selectRelevantFiles(files, 'Blueprint', 5);
    const srcIdx = top.findIndex((f) => f.path === 'src/flask/blueprints.py');
    const testIdx = top.findIndex((f) => f.path === 'tests/test_blueprints.py');
    expect(srcIdx).toBeGreaterThanOrEqual(0);
    expect(srcIdx).toBeLessThan(testIdx === -1 ? Infinity : testIdx);
  });

  it('caps at k and returns nothing when no terms match', () => {
    expect(selectRelevantFiles(files, 'Blueprint name', 1)).toHaveLength(1);
    expect(selectRelevantFiles(files, 'zzz qqq', 5)).toHaveLength(0);
  });
});
