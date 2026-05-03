import { describe, it, expect, vi } from 'vitest';
import { languages, Uri } from 'vscode';
import { getDiagnostics } from './diagnostics.js';

vi.mock('../securityScanner.js', () => ({
  scanFile: vi.fn().mockResolvedValue([]),
  formatIssues: vi.fn().mockReturnValue(''),
}));

describe('getDiagnostics', () => {
  it('returns "No diagnostics found" for whole workspace when no issues', async () => {
    vi.spyOn(languages, 'getDiagnostics').mockReturnValue([]);
    const result = await getDiagnostics({});
    expect(result).toBe('No diagnostics found.');
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
    expect(result).toBe('No diagnostics found.');
  });

  it('skips entries with no diagnostics', async () => {
    const mockUri = { fsPath: '/workspace/src/empty.ts' } as unknown as ReturnType<typeof Uri.file>;
    vi.spyOn(languages, 'getDiagnostics').mockReturnValue([[mockUri, []]]);
    const result = await getDiagnostics({});
    expect(result).toBe('No diagnostics found.');
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
