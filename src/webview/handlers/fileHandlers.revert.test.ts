import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';
import { workspace, Uri } from 'vscode';
import { revertEditPlanFile } from './fileHandlers.js';

const execFileMock = vi.hoisted(() => vi.fn((_cmd: string, _args: string[], _opts: unknown, cb: () => void) => cb()));
vi.mock('child_process', () => ({ execFile: execFileMock }));

// Real VS Code resolves `..` in joinPath and uses native separators in fsPath;
// the shared mock does neither, which would make the containment check vacuous.
const ROOT = path.resolve('/ws');

// The edit-plan Revert button. Its path is the MODEL's choice and its op is the
// model's claim, so neither may reach a shell, and the user's own uncommitted
// work must survive the revert.

describe('revertEditPlanFile', () => {
  beforeEach(() => {
    execFileMock.mockClear();
    vi.restoreAllMocks();
    (workspace as unknown as Record<string, unknown>).workspaceFolders = [
      { uri: { fsPath: ROOT }, name: 'ws', index: 0 },
    ];
    vi.spyOn(Uri, 'joinPath').mockImplementation(((base: { fsPath: string }, ...segs: string[]) => {
      const p = path.join(base.fsPath, ...segs);
      return { fsPath: p, scheme: 'file', path: p };
    }) as never);
  });

  it('restores the pre-agent snapshot when one exists, without touching git', async () => {
    const changelog = { rollbackFile: vi.fn().mockResolvedValue(true) };
    await revertEditPlanFile('src/a.ts', 'edit', changelog);
    expect(changelog.rollbackFile).toHaveBeenCalledWith('src/a.ts');
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('hands a hostile file name to git as one argv element, never to a shell', async () => {
    const name = 'notes/$(touch pwned).md';
    await revertEditPlanFile(name, 'edit', { rollbackFile: vi.fn().mockResolvedValue(false) });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = execFileMock.mock.calls[0];
    expect(cmd).toBe('git');
    expect(args).toEqual(['checkout', 'HEAD', '--', name]);
    expect((opts as { shell?: unknown }).shell).toBeUndefined();
  });

  it('trashes a created file only when there is no snapshot to restore', async () => {
    const del = vi.spyOn(workspace.fs, 'delete').mockResolvedValue(undefined as never);
    await revertEditPlanFile('src/new.ts', 'create', { rollbackFile: vi.fn().mockResolvedValue(false) });
    expect(del).toHaveBeenCalledWith(expect.anything(), { useTrash: true });

    del.mockClear();
    // The model said "create", but the changelog knows the file pre-existed.
    await revertEditPlanFile('src/old.ts', 'create', { rollbackFile: vi.fn().mockResolvedValue(true) });
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses a path outside the workspace', async () => {
    const changelog = { rollbackFile: vi.fn().mockResolvedValue(false) };
    await revertEditPlanFile('../../outside.txt', 'edit', changelog);
    expect(changelog.rollbackFile).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });
});
