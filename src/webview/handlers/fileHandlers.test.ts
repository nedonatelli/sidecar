import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { workspace, window, Uri, FileType } from 'vscode';
import {
  handleDroppedPaths,
  handleAttachFile,
  handleAttachActiveFile,
  handleAcceptAllChanges,
} from './fileHandlers.js';

// ---------------------------------------------------------------------------
// Mutable audit buffer mock — allows individual tests to set isEmpty
// ---------------------------------------------------------------------------
const mockAuditBuf = {
  isEmpty: true,
  flush: vi.fn().mockResolvedValue({ applied: [] }),
  has: vi.fn().mockReturnValue(false),
  clear: vi.fn(),
};
vi.mock('../../agent/audit/auditBuffer.js', () => ({
  getDefaultAuditBuffer: () => mockAuditBuf,
}));

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

// ---------------------------------------------------------------------------
// handleAcceptAllChanges — audit buffer flush path
// ---------------------------------------------------------------------------
describe('handleAcceptAllChanges — audit buffer non-empty', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAuditBuf.isEmpty = false;
    mockAuditBuf.flush.mockClear();
    mockAuditBuf.flush.mockResolvedValue({ applied: [] });
  });

  afterEach(() => {
    // Reset to the safe default so other tests are not affected.
    mockAuditBuf.isEmpty = true;
    mockAuditBuf.flush.mockClear();
  });

  it('calls buf.flush with writeDisk/deleteDisk helpers when audit buffer is non-empty', async () => {
    const state = {
      changelog: { clear: vi.fn() },
      postMessage: vi.fn(),
    };

    await handleAcceptAllChanges(state as never);

    expect(mockAuditBuf.flush).toHaveBeenCalled();
    // writeDisk and deleteDisk are arrow functions passed as the first two args
    const [writeDiskArg, deleteDiskArg] = mockAuditBuf.flush.mock.calls[0] as [
      (rel: string, content: string) => Promise<void>,
      (rel: string) => Promise<void>,
    ];
    expect(typeof writeDiskArg).toBe('function');
    expect(typeof deleteDiskArg).toBe('function');
  });

  it('invokes workspace.fs.writeFile via the writeDisk closure', async () => {
    const state = {
      changelog: { clear: vi.fn() },
      postMessage: vi.fn(),
    };
    const writeSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined as never);

    // Override flush to immediately invoke writeDisk with a test path
    mockAuditBuf.flush.mockImplementation(async (writeDisk: (rel: string, content: string) => Promise<void>) => {
      await writeDisk('src/generated.ts', 'export const x = 1;');
      return { applied: ['src/generated.ts'] };
    });

    await handleAcceptAllChanges(state as never);

    expect(writeSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: expect.stringContaining('generated.ts') }),
      expect.any(Uint8Array),
    );
  });

  it('invokes workspace.fs.delete via the deleteDisk closure', async () => {
    const state = {
      changelog: { clear: vi.fn() },
      postMessage: vi.fn(),
    };
    const deleteSpy = vi.spyOn(workspace.fs, 'delete').mockResolvedValue(undefined as never);

    mockAuditBuf.flush.mockImplementation(async (_writeDisk: unknown, deleteDisk: (rel: string) => Promise<void>) => {
      await deleteDisk('src/old.ts');
      return { applied: ['src/old.ts'] };
    });

    await handleAcceptAllChanges(state as never);

    expect(deleteSpy).toHaveBeenCalledWith(expect.objectContaining({ fsPath: expect.stringContaining('old.ts') }), {
      useTrash: true,
    });
  });

  it('still posts confirmation even when flush throws', async () => {
    const state = {
      changelog: { clear: vi.fn() },
      postMessage: vi.fn(),
    };
    mockAuditBuf.flush.mockRejectedValue(new Error('disk full'));

    await handleAcceptAllChanges(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('accepted') }),
    );
  });

  it('skips flush when there are no workspace folders', async () => {
    const origFolders = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;

    const state = {
      changelog: { clear: vi.fn() },
      postMessage: vi.fn(),
    };

    await handleAcceptAllChanges(state as never);

    expect(mockAuditBuf.flush).not.toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'assistantMessage' }));

    (workspace as Record<string, unknown>).workspaceFolders = origFolders;
  });
});
