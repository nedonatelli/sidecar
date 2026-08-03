import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  INDEX_EXCLUDE_DIRS,
  INDEX_EXCLUDE_PATTERN,
  INDEX_MAX_FILES_PER_PATTERN,
  indexScanTruncated,
} from './indexExcludes.js';

// Four scanners walk the whole workspace. They had four different exclude
// lists, and v0.122.2 converged only two of them — so the symbol graph and the
// workspace index went on indexing 2.2 GB of `.vscode-test/` after the release
// that claimed to stop it. Fixing the scanner whose failure happened to appear
// in a log, rather than the class, is what the shared constant exists to
// prevent.

const SCANNERS = [
  'src/config/documentationIndexer.ts',
  'src/config/workspaceIndex.ts',
  'src/config/symbolIndexer.ts',
  'src/agent/codebaseInit.ts',
];

describe('INDEX_EXCLUDE_DIRS', () => {
  it('covers every directory the individual scanners used to list', () => {
    // The union of what each list carried before converging. Dropping any of
    // these would silently re-admit a directory some scanner had already
    // learned to skip — `.stryker-tmp` copies the entire repo per mutation
    // sandbox, and graphify writes a ~7 MB graph into the directory it scans.
    for (const dir of [
      'node_modules',
      '.git',
      '.sidecar',
      'coverage',
      'out',
      'dist',
      'build',
      '.venv',
      'venv',
      '__pycache__',
      '.next',
      '.turbo',
      '.cache',
      '.stryker-tmp',
      'graphify-out',
      'vendor',
      'target',
      '.vscode-test',
    ]) {
      expect(INDEX_EXCLUDE_DIRS, `${dir} must stay excluded`).toContain(dir);
    }
  });

  it('excludes Python environments by layout, not by conventional name', () => {
    // `.venv`/`venv` only catch the two usual names. A `.graphify-venv` created
    // to run the code-graph differential landed 23,284 symbols across 1,348
    // site-packages files in the symbol graph — 76% of everything in it, all of
    // it third-party Python competing with the user's own code at retrieval.
    // Every virtualenv puts packages under `site-packages` whatever the env is
    // called, so that is the durable thing to exclude.
    expect(INDEX_EXCLUDE_DIRS).toContain('site-packages');
    expect(INDEX_EXCLUDE_PATTERN).toContain('site-packages');
  });

  it('is the only exclude list the workspace-wide scanners define', () => {
    // A scanner that builds its own `**/{...}/**` is a fifth list waiting to
    // diverge. This is the check that would have caught the incomplete fix.
    const offenders: string[] = [];
    for (const file of SCANNERS) {
      const src = readFileSync(resolve(process.cwd(), file), 'utf-8');
      if (!src.includes('INDEX_EXCLUDE_PATTERN') && !src.includes('INDEX_EXCLUDE_DIRS')) {
        offenders.push(`${file}: does not use the shared exclude list`);
      }
      if (/\{\$\{\[?\.{3}?[A-Z_]*(EXCLUDE|IGNORE)[A-Z_]*\]?\.join\(','\)\}\}/.test(src)) {
        offenders.push(`${file}: builds its own exclude glob`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('renders a glob that matches nested artifact paths', () => {
    expect(INDEX_EXCLUDE_PATTERN.startsWith('**/{')).toBe(true);
    expect(INDEX_EXCLUDE_PATTERN.endsWith('}/**')).toBe(true);
    expect(INDEX_EXCLUDE_PATTERN).toContain('.vscode-test');
  });
});

// `workspace.findFiles` truncates at maxResults and returns nothing to say it
// did — a short array from a truncated scan is identical to a short array from
// a small workspace. The symbol indexer asked for 1000 against this repo's 1035
// `.ts` files, so every run dropped a different ~35 and reported success. 30 of
// src/config's 64 files were absent from the cached graph, taking ~72 exported
// symbols out of find_references, analyze_impact and PKI retrieval (#40).

describe('indexScanTruncated', () => {
  it('is silent for a scan that came back under the limit', () => {
    expect(indexScanTruncated('symbolIndexer', '**/*.ts', INDEX_MAX_FILES_PER_PATTERN - 1)).toBeNull();
  });

  it('warns when a scan comes back exactly at the limit', () => {
    // At-the-limit is the truncation signal: findFiles stops once it has
    // maxResults, so equality is the only evidence available.
    const w = indexScanTruncated('symbolIndexer', '**/*.ts', INDEX_MAX_FILES_PER_PATTERN);
    expect(w).toContain('truncated');
    expect(w).toContain('INCOMPLETE');
  });

  it('names the scanner and the pattern that truncated', () => {
    // Four scanners walk the workspace with different patterns. A warning that
    // says only "truncated" sends the reader looking through all of them.
    const w = indexScanTruncated('workspaceIndex', '**/*.py', INDEX_MAX_FILES_PER_PATTERN);
    expect(w).toContain('workspaceIndex');
    expect(w).toContain('**/*.py');
  });

  it('sets the limit far above any plausible single-language file count', () => {
    // The old limits (1000 symbol / 500 workspace) were below this repo's own
    // file count, so truncation was the normal case rather than the exception.
    expect(INDEX_MAX_FILES_PER_PATTERN).toBeGreaterThanOrEqual(10_000);
  });
});

describe('the whole-workspace scanners use the shared limit', () => {
  // The exclude-list bug was one list diverging into four. This is the same
  // shape: a scanner with its own hardcoded maxResults is a fifth limit waiting
  // to be too low, and its truncation would be silent again.
  for (const file of ['src/config/symbolIndexer.ts', 'src/config/workspaceIndex.ts']) {
    it(`${file} requests INDEX_MAX_FILES_PER_PATTERN and reports truncation`, () => {
      const src = readFileSync(resolve(process.cwd(), file), 'utf-8');
      expect(src).toContain('INDEX_MAX_FILES_PER_PATTERN');
      expect(src).toContain('indexScanTruncated');
      // No bare numeric maxResults left behind on a findFiles call.
      expect(src).not.toMatch(/findFiles\([^)]*,\s*\d+\s*\)/);
    });
  }
});
