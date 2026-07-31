import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { INDEX_EXCLUDE_DIRS, INDEX_EXCLUDE_PATTERN } from './indexExcludes.js';

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
