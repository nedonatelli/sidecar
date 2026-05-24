import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiagnosticSeverity } from 'vscode';
import { CiDiagnostics } from './ciDiagnostics.js';
import type { FailureBlock } from '../review/ciFailure.js';

const mockCollection = vi.hoisted(() => ({
  set: vi.fn(),
  clear: vi.fn(),
  delete: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock('vscode', async () => {
  const actual = await vi.importActual<typeof import('vscode')>('vscode');
  return {
    ...actual,
    languages: {
      createDiagnosticCollection: vi.fn().mockReturnValue(mockCollection),
    },
    workspace: {
      findFiles: vi.fn().mockResolvedValue([]),
    },
  };
});

const META = {
  runNumber: 42,
  branch: 'main',
  workflowName: 'CI',
  runUrl: 'https://github.com/org/repo/actions/runs/42',
};

describe('CiDiagnostics', () => {
  let diags: CiDiagnostics;

  beforeEach(() => {
    vi.clearAllMocks();
    diags = new CiDiagnostics();
  });

  it('clears and does nothing when blocks is empty', async () => {
    await diags.report([], META);
    expect(mockCollection.clear).toHaveBeenCalled();
    expect(mockCollection.set).not.toHaveBeenCalled();
  });

  it('does not set diagnostics when no target file is found', async () => {
    const { workspace } = await import('vscode');
    vi.mocked(workspace.findFiles).mockResolvedValue([]);

    const blocks: FailureBlock[] = [
      { stepName: 'Run tests', errorLines: ['Process completed with exit code 1.'], contextBefore: [], exitCode: 1 },
    ];
    await diags.report(blocks, META);
    expect(mockCollection.set).not.toHaveBeenCalled();
  });

  it('sets diagnostics against the workflow file when found', async () => {
    const { workspace, Uri } = await import('vscode');
    const fakeUri = Uri.file('/repo/.github/workflows/ci.yml');
    vi.mocked(workspace.findFiles).mockResolvedValueOnce([fakeUri]);

    const blocks: FailureBlock[] = [
      { stepName: 'Run tests', errorLines: ['exit code 1'], contextBefore: [], exitCode: 1 },
      { stepName: 'Lint', errorLines: ['lint error'], contextBefore: [] },
    ];
    await diags.report(blocks, META);
    expect(mockCollection.set).toHaveBeenCalledOnce();
    const [uri, diagnostics] = vi.mocked(mockCollection.set).mock.calls[0];
    expect(uri).toBe(fakeUri);
    expect(diagnostics).toHaveLength(2);
  });

  it('Error severity for blocks with exitCode, Warning without', async () => {
    const { workspace, Uri } = await import('vscode');
    vi.mocked(workspace.findFiles).mockResolvedValueOnce([Uri.file('/repo/.github/workflows/ci.yml')]);

    const blocks: FailureBlock[] = [
      { stepName: 'A', errorLines: ['fail'], contextBefore: [], exitCode: 1 },
      { stepName: 'B', errorLines: ['warn'], contextBefore: [] },
    ];
    await diags.report(blocks, META);
    const [, diagnostics] = vi.mocked(mockCollection.set).mock.calls[0];
    expect(diagnostics[0].severity).toBe(DiagnosticSeverity.Error);
    expect(diagnostics[1].severity).toBe(DiagnosticSeverity.Warning);
  });

  it('message includes run number and step name', async () => {
    const { workspace, Uri } = await import('vscode');
    vi.mocked(workspace.findFiles).mockResolvedValueOnce([Uri.file('/repo/package.json')]);

    const blocks: FailureBlock[] = [
      { stepName: 'Run integration tests', errorLines: ['FAIL src/foo.test.ts'], contextBefore: [], exitCode: 1 },
    ];
    await diags.report(blocks, META);
    const [, diagnostics] = vi.mocked(mockCollection.set).mock.calls[0];
    expect(diagnostics[0].message).toContain('42');
    expect(diagnostics[0].message).toContain('Run integration tests');
  });

  it('prefers workflow YAML matched by name', async () => {
    const { workspace, Uri } = await import('vscode');
    const ci = Uri.file('/repo/.github/workflows/ci.yml');
    const deploy = Uri.file('/repo/.github/workflows/deploy.yml');
    vi.mocked(workspace.findFiles).mockResolvedValueOnce([deploy, ci]);

    const blocks: FailureBlock[] = [{ stepName: 'Build', errorLines: ['error'], contextBefore: [], exitCode: 1 }];
    await diags.report(blocks, { ...META, workflowName: 'ci' });
    const [uri] = vi.mocked(mockCollection.set).mock.calls[0];
    expect(uri.fsPath).toContain('ci.yml');
  });

  it('falls back to manifest when no workflow file exists', async () => {
    const { workspace, Uri } = await import('vscode');
    const pkg = Uri.file('/repo/package.json');
    vi.mocked(workspace.findFiles)
      .mockResolvedValueOnce([]) // no .github/workflows
      .mockResolvedValueOnce([pkg]); // package.json

    const blocks: FailureBlock[] = [{ stepName: 'Test', errorLines: ['fail'], contextBefore: [] }];
    await diags.report(blocks, META);
    const [uri] = vi.mocked(mockCollection.set).mock.calls[0];
    expect(uri.fsPath).toContain('package.json');
  });

  it('clear() delegates to the collection', () => {
    diags.clear();
    expect(mockCollection.clear).toHaveBeenCalled();
  });

  it('dispose() disposes the collection', () => {
    diags.dispose();
    expect(mockCollection.dispose).toHaveBeenCalled();
  });
});
