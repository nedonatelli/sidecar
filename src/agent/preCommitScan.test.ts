import { describe, it, expect } from 'vitest';
import { workspace } from 'vscode';
import { scanStagedFiles } from './preCommitScan.js';
import { scanContent } from './securityScanner.js';

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

  it('scanStagedFiles returns empty when no workspace', async () => {
    const orig = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;

    const { issues, scannedCount } = await scanStagedFiles();
    expect(issues).toEqual([]);
    expect(scannedCount).toBe(0);

    (workspace as Record<string, unknown>).workspaceFolders = orig;
  });
});
