import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace, FileType } from 'vscode';
import { handleDroppedPaths } from './fileHandlers.js';

function makeState() {
  return { postMessage: vi.fn() };
}

describe('handleDroppedPaths — folder drop eligible-file count', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // Default readFile returns empty content (text, not binary).
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(new Uint8Array());
  });

  it('counts only eligible files in the "not attached" message — excludes dotfiles, skipped dirs, and subdirs', async () => {
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: FileType.Directory, size: 0 } as never);
    vi.spyOn(workspace.fs, 'readDirectory').mockResolvedValue([
      ['a.ts', FileType.File],
      ['b.ts', FileType.File],
      ['.hidden', FileType.File], // dotfile — not eligible
      ['node_modules', FileType.Directory], // skipped name — not eligible
      ['src', FileType.Directory], // subdirectory — not eligible
      ['c.ts', FileType.File], // eligible but hits MAX_FOLDER_ENTRIES (set to 10; only 3 files here so all fit)
    ] as never);

    const state = makeState();
    await handleDroppedPaths(state as never, ['/project/myfolder']);

    // 3 eligible files (a.ts, b.ts, c.ts), all taken — no "not attached" message.
    // The skipped notification should NOT include a "more files not attached" entry
    // for dotfiles or subdirectories.
    const posted = state.postMessage.mock.calls[0]?.[0];
    expect(posted?.command).toBe('filesAttached');
    expect(posted?.files).toHaveLength(3);
  });

  it('reports only eligible-but-uncollected files when folder cap is hit', async () => {
    // 12 eligible .ts files; MAX_FOLDER_ENTRIES=10 so 2 are left out.
    // Non-eligible entries (1 dotfile + 1 subdir) must NOT inflate the count.
    const entries: [string, FileType][] = [
      ...Array.from({ length: 12 }, (_, i) => [`f${i}.ts`, FileType.File] as [string, FileType]),
      ['.eslintrc', FileType.File], // dotfile — not eligible
      ['dist', FileType.Directory], // subdir — not eligible
    ];
    vi.spyOn(workspace.fs, 'stat').mockImplementation(async (uri) => {
      const p = (uri as { fsPath: string }).fsPath;
      // Top-level folder stat → Directory; child files → File
      return (
        p.includes('.ts') || p.includes('.eslintrc')
          ? { type: FileType.File, size: 10 }
          : { type: FileType.Directory, size: 0 }
      ) as never;
    });
    vi.spyOn(workspace.fs, 'readDirectory').mockResolvedValue(entries as never);

    const state = makeState();
    // showInformationMessage is called when items are skipped — spy to capture it.
    const showInfo = vi
      .spyOn(await import('vscode').then((m) => m.window), 'showInformationMessage')
      .mockResolvedValue(undefined as never);

    await handleDroppedPaths(state as never, ['/project/myfolder']);

    // 12 eligible, 10 taken → 2 not attached. NOT 14 - 10 = 4 (old buggy calc).
    expect(showInfo).toHaveBeenCalledWith(expect.stringContaining('2 more files not attached'));
  });

  it('uses singular "file" when exactly 1 eligible file is not attached', async () => {
    const entries: [string, FileType][] = [
      ...Array.from({ length: 11 }, (_, i) => [`f${i}.ts`, FileType.File] as [string, FileType]),
    ];
    vi.spyOn(workspace.fs, 'stat').mockImplementation(async (uri) => {
      const p = (uri as { fsPath: string }).fsPath;
      return (p.includes('.ts') ? { type: FileType.File, size: 10 } : { type: FileType.Directory, size: 0 }) as never;
    });
    vi.spyOn(workspace.fs, 'readDirectory').mockResolvedValue(entries as never);

    const state = makeState();
    const showInfo = vi
      .spyOn(await import('vscode').then((m) => m.window), 'showInformationMessage')
      .mockResolvedValue(undefined as never);

    await handleDroppedPaths(state as never, ['/project/myfolder']);

    // 11 eligible, 10 taken → 1 not attached (singular)
    expect(showInfo).toHaveBeenCalledWith(expect.stringContaining('1 more file not attached'));
  });
});
