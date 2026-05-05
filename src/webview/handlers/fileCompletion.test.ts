import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace } from 'vscode';
import { handleRequestFileCompletion } from './fileHandlers.js';

function makeState() {
  return {
    postMessage: vi.fn(),
  };
}

describe('handleRequestFileCompletion', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('posts empty list when no workspace folders are open', async () => {
    const orig = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;

    const state = makeState();
    await handleRequestFileCompletion(state as never);

    expect(state.postMessage).toHaveBeenCalledWith({
      command: 'fileCompletionList',
      completionFiles: [],
    });

    (workspace as Record<string, unknown>).workspaceFolders = orig;
  });

  it('returns relative paths from workspace.findFiles', async () => {
    const root = '/mock-workspace';
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([
      { fsPath: `${root}/src/app.ts` } as never,
      { fsPath: `${root}/package.json` } as never,
    ]);

    const state = makeState();
    await handleRequestFileCompletion(state as never);

    const call = state.postMessage.mock.calls[0][0] as { command: string; completionFiles: string[] };
    expect(call.command).toBe('fileCompletionList');
    expect(call.completionFiles).toContain('src/app.ts');
    expect(call.completionFiles).toContain('package.json');
  });

  it('sorts the returned file list', async () => {
    const root = '/mock-workspace';
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([
      { fsPath: `${root}/z-last.ts` } as never,
      { fsPath: `${root}/a-first.ts` } as never,
      { fsPath: `${root}/m-middle.ts` } as never,
    ]);

    const state = makeState();
    await handleRequestFileCompletion(state as never);

    const call = state.postMessage.mock.calls[0][0] as { completionFiles: string[] };
    expect(call.completionFiles).toEqual(['a-first.ts', 'm-middle.ts', 'z-last.ts']);
  });

  it('normalizes Windows backslashes to forward slashes', async () => {
    const root = 'C:\\mock-workspace';
    // Simulate a workspace root that uses Windows separators
    const origFolders = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = [{ uri: { fsPath: root } }];

    vi.spyOn(workspace, 'findFiles').mockResolvedValue([{ fsPath: `${root}\\src\\components\\App.tsx` } as never]);

    const state = makeState();
    await handleRequestFileCompletion(state as never);

    const call = state.postMessage.mock.calls[0][0] as { completionFiles: string[] };
    expect(call.completionFiles[0]).not.toContain('\\');
    expect(call.completionFiles[0]).toBe('src/components/App.tsx');

    (workspace as Record<string, unknown>).workspaceFolders = origFolders;
  });

  it('uses the findFiles exclusion pattern to skip node_modules', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([]);

    const state = makeState();
    await handleRequestFileCompletion(state as never);

    expect(workspace.findFiles).toHaveBeenCalledWith('**/*', expect.stringContaining('node_modules'), 500);
  });
});
