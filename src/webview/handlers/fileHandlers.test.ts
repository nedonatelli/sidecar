import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { workspace, window, Uri, FileType } from 'vscode';
import { handleDroppedPaths, handleAttachFile, handleAttachActiveFile, handleCreateFile } from './fileHandlers.js';
import * as nodePath from 'path';

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

// ---------------------------------------------------------------------------
// handleAttachFile
// ---------------------------------------------------------------------------
describe('handleAttachFile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns early when user cancels the quick-pick (no editor)', async () => {
    // No active editor → only "Browse..." in the list → showQuickPick is called
    vi.spyOn(window, 'showQuickPick').mockResolvedValue(undefined as never);
    const state = makeState();
    await handleAttachFile(state as never);
    expect(state.postMessage).not.toHaveBeenCalled();
  });

  it('posts fileAttached for the active text file (no editor dialog)', async () => {
    const mockEditor = {
      document: {
        fileName: '/workspace/src/foo.ts',
        getText: vi.fn().mockReturnValue('const x = 1;'),
      },
    };
    vi.spyOn(window, 'activeTextEditor', 'get').mockReturnValue(mockEditor as never);
    // Two options are built: "Active File: foo.ts" and "Browse..."
    // Simulate user picking the active file option.
    vi.spyOn(window, 'showQuickPick').mockResolvedValue('Active File: foo.ts' as never);

    const state = makeState();
    await handleAttachFile(state as never);

    expect(state.postMessage).toHaveBeenCalledWith({
      command: 'fileAttached',
      fileName: 'foo.ts',
      fileContent: 'const x = 1;',
    });
  });

  it('shows warning when active text file is too large', async () => {
    const bigContent = 'x'.repeat(500_001);
    const mockEditor = {
      document: {
        fileName: '/workspace/src/big.ts',
        getText: vi.fn().mockReturnValue(bigContent),
      },
    };
    vi.spyOn(window, 'activeTextEditor', 'get').mockReturnValue(mockEditor as never);
    vi.spyOn(window, 'showQuickPick').mockResolvedValue('Active File: big.ts' as never);
    const warnSpy = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);

    const state = makeState();
    await handleAttachFile(state as never);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('too large'));
    expect(state.postMessage).not.toHaveBeenCalled();
  });

  it('posts imageAttached when the active file is an image', async () => {
    const mockEditor = {
      document: {
        fileName: '/workspace/assets/logo.png',
        getText: vi.fn().mockReturnValue(''),
      },
    };
    vi.spyOn(window, 'activeTextEditor', 'get').mockReturnValue(mockEditor as never);
    vi.spyOn(window, 'showQuickPick').mockResolvedValue('Active File: logo.png' as never);
    // attachImage reads the file via workspace.fs.readFile
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]) as never, // PNG header
    );

    const state = makeState();
    await handleAttachFile(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'imageAttached', mediaType: 'image/png' }),
    );
  });

  it('returns early when browse dialog is cancelled', async () => {
    // No active editor → only Browse option → auto-selected (options.length === 1)
    vi.spyOn(window, 'showOpenDialog').mockResolvedValue(undefined as never);

    const state = makeState();
    await handleAttachFile(state as never);

    expect(state.postMessage).not.toHaveBeenCalled();
  });

  it('posts fileAttached when a text file is chosen via Browse', async () => {
    // No active editor → only Browse option is in list → length===1, auto-picked
    vi.spyOn(window, 'showOpenDialog').mockResolvedValue([Uri.file('/workspace/docs/readme.txt')] as never);
    vi.spyOn(workspace, 'openTextDocument').mockResolvedValue({
      getText: () => 'hello from readme',
      uri: Uri.file('/workspace/docs/readme.txt'),
    } as never);

    const state = makeState();
    await handleAttachFile(state as never);

    expect(state.postMessage).toHaveBeenCalledWith({
      command: 'fileAttached',
      fileName: 'readme.txt',
      fileContent: 'hello from readme',
    });
  });

  it('shows warning when a browsed text file is too large', async () => {
    vi.spyOn(window, 'showOpenDialog').mockResolvedValue([Uri.file('/workspace/huge.txt')] as never);
    vi.spyOn(workspace, 'openTextDocument').mockResolvedValue({
      getText: () => 'x'.repeat(500_001),
      uri: Uri.file('/workspace/huge.txt'),
    } as never);
    const warnSpy = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);

    const state = makeState();
    await handleAttachFile(state as never);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('too large'));
    expect(state.postMessage).not.toHaveBeenCalled();
  });

  it('posts imageAttached when an image is chosen via Browse', async () => {
    vi.spyOn(window, 'showOpenDialog').mockResolvedValue([Uri.file('/workspace/photo.jpg')] as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(
      new Uint8Array([0xff, 0xd8, 0xff]) as never, // JPEG header
    );

    const state = makeState();
    await handleAttachFile(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'imageAttached', mediaType: 'image/jpeg' }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleAttachActiveFile
// ---------------------------------------------------------------------------
describe('handleAttachActiveFile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns immediately when there is no active editor', async () => {
    vi.spyOn(window, 'activeTextEditor', 'get').mockReturnValue(undefined as never);
    const state = makeState();
    await handleAttachActiveFile(state as never);
    expect(state.postMessage).not.toHaveBeenCalled();
  });

  it('posts fileAttached for a normal text file', async () => {
    const mockEditor = {
      document: {
        fileName: '/workspace/src/utils.ts',
        getText: vi.fn().mockReturnValue('export function add(a: number, b: number) { return a + b; }'),
      },
    };
    vi.spyOn(window, 'activeTextEditor', 'get').mockReturnValue(mockEditor as never);

    const state = makeState();
    await handleAttachActiveFile(state as never);

    expect(state.postMessage).toHaveBeenCalledWith({
      command: 'fileAttached',
      fileName: 'utils.ts',
      fileContent: 'export function add(a: number, b: number) { return a + b; }',
    });
  });

  it('shows warning and does not post when the file is too large', async () => {
    const mockEditor = {
      document: {
        fileName: '/workspace/src/giant.ts',
        getText: vi.fn().mockReturnValue('y'.repeat(500_001)),
      },
    };
    vi.spyOn(window, 'activeTextEditor', 'get').mockReturnValue(mockEditor as never);
    const warnSpy = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);

    const state = makeState();
    await handleAttachActiveFile(state as never);

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('too large'));
    expect(state.postMessage).not.toHaveBeenCalled();
  });

  it('posts imageAttached when the active file is an image', async () => {
    const mockEditor = {
      document: {
        fileName: '/workspace/assets/banner.webp',
        getText: vi.fn().mockReturnValue(''),
      },
    };
    vi.spyOn(window, 'activeTextEditor', 'get').mockReturnValue(mockEditor as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(
      new Uint8Array([0x52, 0x49, 0x46, 0x46]) as never, // RIFF header (WebP)
    );

    const state = makeState();
    await handleAttachActiveFile(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'imageAttached', mediaType: 'image/webp' }),
    );
  });
});

describe('handleCreateFile -- the path and code are model output', () => {
  const root = nodePath.resolve('/create-ws');
  let writes: string[];
  let savedFolders: unknown;

  afterEach(() => {
    (workspace as { workspaceFolders: unknown }).workspaceFolders = savedFolders;
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    writes = [];
    vi.spyOn(Uri, 'joinPath').mockImplementation(((base: { fsPath: string }, ...segs: string[]) => {
      const joined = nodePath.join(base.fsPath, ...segs);
      return { fsPath: joined, scheme: 'file', path: joined };
    }) as never);
    savedFolders = workspace.workspaceFolders;
    (workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: root, scheme: 'file' }, name: 'ws', index: 0 },
    ];
    vi.spyOn(workspace.fs, 'stat').mockRejectedValue(new Error('FileNotFound'));
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined as never);
    vi.spyOn(workspace.fs, 'writeFile').mockImplementation((async (uri: { fsPath: string }) => {
      writes.push(nodePath.relative(root, uri.fsPath).replace(/\\/g, '/'));
    }) as never);
  });

  const stateFor = () => ({ postMessage: vi.fn(), requestConfirm: vi.fn() });

  it.each([['.git/hooks/pre-commit'], ['sub/.GIT/config'], ['.sidecar/memory/agent-memories.json'], ['.env']])(
    'refuses %s and writes nothing',
    async (filePath) => {
      const state = stateFor();
      await handleCreateFile(state as never, '#!/bin/sh\necho hi\n', filePath);
      expect(writes).toEqual([]);
      expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'error' }));
    },
  );

  it('creates an ordinary new file', async () => {
    const state = stateFor();
    await handleCreateFile(state as never, 'export const x = 1;\n', 'src/x.ts');
    expect(writes).toEqual(['src/x.ts']);
  });
});
