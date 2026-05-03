import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace, window } from 'vscode';
import { scanStagedFiles, runPreCommitScan } from './preCommitScan.js';
import { scanContent } from './securityScanner.js';

// Mock exec so tests don't invoke a real git process
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, exec: vi.fn() };
});

import { exec } from 'child_process';

type ExecCallback = (err: Error | null, result?: { stdout: string; stderr: string }) => void;
function mockExecOk(stdout: string) {
  vi.mocked(exec).mockImplementationOnce((_cmd, _opts, cb) => {
    (cb as unknown as ExecCallback)(null, { stdout, stderr: '' });
    return {} as never;
  });
}
function mockExecFail() {
  vi.mocked(exec).mockImplementationOnce((_cmd, _opts, cb) => {
    (cb as unknown as ExecCallback)(new Error('git error'));
    return {} as never;
  });
}

describe('pre-commit scan integration', () => {
  it('scanContent catches secrets that would be in staged files', () => {
    // Simulates what scanStagedFiles does internally with each file's content
    const stagedContent = 'const key = "AKIAIOSFODNN7EXAMPLE";';
    const issues = scanContent(stagedContent, 'config.ts');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].category).toBe('secret');
  });

  it('scanContent passes clean staged files', () => {
    const stagedContent = 'export function add(a: number, b: number) { return a + b; }';
    const issues = scanContent(stagedContent, 'math.ts');
    expect(issues).toHaveLength(0);
  });

  it('scanContent detects multiple issues in a single file', () => {
    const stagedContent = [
      'const aws = "AKIAIOSFODNN7EXAMPLE";',
      'element.innerHTML = userInput;',
      'const db = "mongodb://admin:pass@db.example.com/app";',
    ].join('\n');
    const issues = scanContent(stagedContent, 'bad.ts');
    expect(issues.length).toBeGreaterThanOrEqual(3);
  });

  it('scanStagedFiles returns empty even without exec when no workspace', async () => {
    const orig = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;

    const { issues, scannedCount } = await scanStagedFiles();
    expect(issues).toEqual([]);
    expect(scannedCount).toBe(0);

    (workspace as Record<string, unknown>).workspaceFolders = orig;
  });
});

describe('scanStagedFiles (with exec mock)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns empty when git diff returns no files', async () => {
    mockExecOk(''); // no staged files
    const result = await scanStagedFiles();
    expect(result.scannedCount).toBe(0);
    expect(result.issues).toEqual([]);
  });

  it('scans a staged file and returns its issues', async () => {
    mockExecOk('src/app.ts\n'); // git diff --cached
    mockExecOk('const x = 1;'); // git show :src/app.ts
    const result = await scanStagedFiles();
    expect(result.scannedCount).toBe(1);
    expect(result.issues).toEqual([]);
  });

  it('returns empty when git diff fails', async () => {
    mockExecFail();
    const result = await scanStagedFiles();
    expect(result.scannedCount).toBe(0);
  });

  it('skips files when git show fails', async () => {
    mockExecOk('src/binary.bin\n');
    mockExecFail(); // git show fails for this file
    const result = await scanStagedFiles();
    expect(result.scannedCount).toBe(1);
    expect(result.issues).toEqual([]);
  });
});

describe('runPreCommitScan (with exec mock)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows info and returns true when no staged files', async () => {
    mockExecOk('');
    const showInfo = vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);
    const result = await runPreCommitScan();
    expect(result).toBe(true);
    expect(showInfo).toHaveBeenCalledWith(expect.stringContaining('No staged files'));
    vi.restoreAllMocks();
  });

  it('returns true when staged files are clean', async () => {
    mockExecOk('src/clean.ts\n');
    mockExecOk('const x = 1;');
    const result = await runPreCommitScan();
    expect(result).toBe(true);
  });

  it('opens document with issues and returns false when secrets are found', async () => {
    // Return a staged file name
    mockExecOk('src/secrets.ts\n');
    // Return content with a secret
    mockExecOk('const apiKey = "AKIAIOSFODNN7EXAMPLE";');

    const openDoc = vi.spyOn(workspace, 'openTextDocument').mockResolvedValue({ uri: {} } as never);
    const showText = vi.spyOn(window, 'showTextDocument').mockResolvedValue(undefined as never);
    const showWarn = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);

    const result = await runPreCommitScan();

    expect(result).toBe(false);
    expect(openDoc).toHaveBeenCalled();
    expect(showText).toHaveBeenCalled();
    expect(showWarn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
