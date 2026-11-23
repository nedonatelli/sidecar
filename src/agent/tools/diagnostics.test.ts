import { describe, it, expect, vi } from 'vitest';
import { languages, Uri } from 'vscode';
import * as nodePath from 'path';
import { getDiagnostics } from './diagnostics.js';
import { getRoot } from './shared.js';

vi.mock('../securityScanner.js', () => ({
  scanFile: vi.fn().mockResolvedValue([]),
  formatIssues: vi.fn().mockReturnValue(''),
}));

describe('getDiagnostics', () => {
  it('returns "No diagnostics found" for whole workspace when no issues', async () => {
    vi.spyOn(languages, 'getDiagnostics').mockReturnValue([]);
    const result = await getDiagnostics({});
    expect(result).toMatch(/^No diagnostics found\./);
  });

  it('returns workspace diagnostics when issues exist', async () => {
    const mockUri = { fsPath: '/workspace/src/app.ts' } as unknown as ReturnType<typeof Uri.file>;
    const mockDiag = {
      range: { start: { line: 4 } },
      severity: 0,
      message: 'Cannot find name "foo"',
    };
    vi.spyOn(languages, 'getDiagnostics').mockReturnValue([[mockUri, [mockDiag as never]]]);
    const result = await getDiagnostics({});
    expect(result).toContain('app.ts');
    expect(result).toContain('[Error]');
    expect(result).toContain('Cannot find name "foo"');
  });

  it('skips node_modules files in workspace scan', async () => {
    const mockUri = { fsPath: '/workspace/node_modules/lib/index.ts' } as unknown as ReturnType<typeof Uri.file>;
    const mockDiag = { range: { start: { line: 0 } }, severity: 0, message: 'err' };
    vi.spyOn(languages, 'getDiagnostics').mockReturnValue([[mockUri, [mockDiag as never]]]);
    const result = await getDiagnostics({});
    expect(result).toMatch(/^No diagnostics found\./);
  });

  it('skips entries with no diagnostics', async () => {
    const mockUri = { fsPath: '/workspace/src/empty.ts' } as unknown as ReturnType<typeof Uri.file>;
    vi.spyOn(languages, 'getDiagnostics').mockReturnValue([[mockUri, []]]);
    const result = await getDiagnostics({});
    expect(result).toMatch(/^No diagnostics found\./);
  });

  it('returns no diagnostics message for specific file with no issues', async () => {
    vi.spyOn(languages, 'getDiagnostics').mockReturnValue([]);
    const result = await getDiagnostics({ path: 'src/app.ts' });
    expect(result).toContain('No diagnostics');
    expect(result).toContain('src/app.ts');
  });

  it('includes severity labels for all types', async () => {
    const mockUri = { fsPath: '/workspace/src/main.ts' } as unknown as ReturnType<typeof Uri.file>;
    const diags = [
      { range: { start: { line: 0 } }, severity: 0, message: 'Error msg' },
      { range: { start: { line: 1 } }, severity: 1, message: 'Warning msg' },
      { range: { start: { line: 2 } }, severity: 2, message: 'Info msg' },
      { range: { start: { line: 3 } }, severity: 3, message: 'Hint msg' },
    ];
    vi.spyOn(languages, 'getDiagnostics').mockReturnValue([[mockUri, diags as never]]);
    const result = await getDiagnostics({});
    expect(result).toContain('[Error]');
    expect(result).toContain('[Warning]');
    expect(result).toContain('[Info]');
    expect(result).toContain('[Hint]');
  });
});

// get_diagnostics needs no approval: it opened '..' paths and credential files
// in an editor and secret-scanned them, reporting which lines held secrets.
describe('get_diagnostics follows the read rules', () => {
  it.each(['../outside/creds.ts', '.env', 'certs/server.pem'])('refuses %s', async (path) => {
    await expect(getDiagnostics({ path })).rejects.toThrow(/traversal|credential|outside the workspace/);
  });
});

// #476: a shadow or fork run read the main workspace's diagnostics for its own
// files, and the completion gate credited that as a lint run.
describe('get_diagnostics in a run with its own working tree', () => {
  it('refuses when the run works outside the workspace root', async () => {
    const getDiags = vi.spyOn(languages, 'getDiagnostics').mockReturnValue([]);
    getDiags.mockClear();
    const elsewhere = nodePath.resolve(getRoot(), '..', 'shadow-worktree');
    await expect(getDiagnostics({ path: 'src/app.ts' }, { cwd: elsewhere } as never)).rejects.toThrow(
      /not this run's working tree/,
    );
    expect(getDiags).not.toHaveBeenCalled();
  });

  it('reads them when the run works at the workspace root, as a SWE run does', async () => {
    vi.spyOn(languages, 'getDiagnostics').mockReturnValue([]);
    const result = await getDiagnostics({ path: 'src/app.ts' }, { cwd: getRoot() } as never);
    expect(result).toContain('No diagnostics reported');
  });
});
