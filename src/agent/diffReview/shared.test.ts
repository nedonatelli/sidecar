import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import { filesTouchedByDiff, writeTempDiffFile } from './shared.js';

describe('filesTouchedByDiff', () => {
  it('extracts paths from git diff headers', () => {
    const diff = ['diff --git a/src/a.ts b/src/a.ts', '@@ -1 +1 @@', '-x', '+y'].join('\n');
    expect(filesTouchedByDiff(diff)).toEqual(['src/a.ts']);
  });

  it('surfaces both names on a rename', () => {
    const diff = 'diff --git a/old.ts b/new.ts\n';
    expect(filesTouchedByDiff(diff).sort()).toEqual(['new.ts', 'old.ts']);
  });

  it('falls back to +++ lines for non-git patches', () => {
    const diff = ['--- a/src/x.ts', '+++ b/src/x.ts', '@@ -1 +1 @@'].join('\n');
    expect(filesTouchedByDiff(diff)).toEqual(['src/x.ts']);
  });

  it('ignores /dev/null in the fallback path', () => {
    const diff = ['--- a/gone.ts', '+++ /dev/null'].join('\n');
    expect(filesTouchedByDiff(diff)).toEqual([]);
  });
});

describe('writeTempDiffFile', () => {
  const written: string[] = [];
  afterEach(() => {
    for (const f of written.splice(0)) fs.rmSync(f, { force: true });
  });

  it('writes content to a temp .diff file tagged with the infix and sanitized label', async () => {
    const uri = await writeTempDiffFile('fork', 'fork/1: weird name', 'patch-body');
    written.push(uri.fsPath);
    expect(uri.fsPath).toMatch(/sidecar-fork-fork_1__weird_name-\d+\.diff$/);
    expect(fs.readFileSync(uri.fsPath, 'utf-8')).toBe('patch-body');
  });
});
