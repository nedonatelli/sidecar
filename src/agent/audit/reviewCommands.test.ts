import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { workspace, Uri } from 'vscode';
import { AuditBuffer } from './auditBuffer.js';
import {
  reviewAuditBuffer,
  acceptAllAuditBuffer,
  rejectAllAuditBuffer,
  acceptFileAuditBuffer,
  rejectFileAuditBuffer,
  type AuditReviewDeps,
  type AuditReviewUi,
} from './reviewCommands.js';

/**
 * Builds a fake UI shim where every method is a vi.fn. Tests drive
 * user interactions by pre-programming `showQuickPick` / `showWarningConfirm`
 * return values and assert against the info/error/openDiff calls.
 */
function makeUi(overrides: Partial<AuditReviewUi> = {}): AuditReviewUi & {
  showQuickPick: ReturnType<typeof vi.fn>;
  showInfo: ReturnType<typeof vi.fn>;
  showWarningConfirm: ReturnType<typeof vi.fn>;
  showError: ReturnType<typeof vi.fn>;
  openDiff: ReturnType<typeof vi.fn>;
  showConflictDialog: ReturnType<typeof vi.fn>;
} {
  return {
    showQuickPick: vi.fn(async () => undefined),
    showInfo: vi.fn(),
    showWarningConfirm: vi.fn(async () => undefined),
    showError: vi.fn(),
    openDiff: vi.fn(async () => {}),
    // Default: no conflict dialog response pre-programmed; tests that
    // exercise the conflict path override this.
    showConflictDialog: vi.fn(async () => undefined),
    ...overrides,
  } as never;
}

async function makeBufferWith(
  entries: Array<{ op: 'write' | 'delete'; path: string; content?: string }>,
  originals: Record<string, string | undefined> = {},
) {
  const buf = new AuditBuffer();
  const readDisk = async (p: string) => originals[p];
  for (const e of entries) {
    if (e.op === 'write') {
      await buf.write(e.path, e.content ?? '', readDisk);
    } else {
      await buf.deleteFile(e.path, readDisk);
    }
  }
  return buf;
}

function baseDeps(buf: AuditBuffer, ui: AuditReviewUi): AuditReviewDeps {
  return {
    buffer: buf,
    rootUri: Uri.file('/mock-workspace'),
    ui,
  };
}

describe('reviewAuditBuffer', () => {
  it('shows an info toast and returns early when the buffer is empty', async () => {
    const buf = new AuditBuffer();
    const ui = makeUi();
    await reviewAuditBuffer(baseDeps(buf, ui));
    expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('empty'));
    expect(ui.showQuickPick).not.toHaveBeenCalled();
  });

  it('lists bulk actions + each entry in the pick list', async () => {
    const buf = await makeBufferWith(
      [
        { op: 'write', path: 'new.ts', content: 'created' },
        { op: 'write', path: 'existing.ts', content: 'modified' },
      ],
      { 'existing.ts': 'original' },
    );
    const ui = makeUi();
    await reviewAuditBuffer(baseDeps(buf, ui));
    const items = ui.showQuickPick.mock.calls[0][0] as Array<{ label: string; action: string }>;
    expect(items).toHaveLength(4);
    expect(items[0].action).toBe('accept-all');
    expect(items[1].action).toBe('reject-all');
    // Both file rows are present. Sort agnostic.
    const openLabels = items.filter((i) => i.action === 'open').map((i) => i.label);
    expect(openLabels.some((l) => l.includes('new.ts'))).toBe(true);
    expect(openLabels.some((l) => l.includes('existing.ts'))).toBe(true);
  });

  it('dispatches to acceptAll when the user picks Accept All', async () => {
    const buf = await makeBufferWith([{ op: 'write', path: 'a.ts', content: 'A' }]);
    const writeFileSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined);
    const createDirSpy = vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined);
    const readFileSpy = vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(new Error('FileNotFound'));
    try {
      const ui = makeUi({
        showQuickPick: vi.fn(async (items: readonly { label: string; action?: string }[]) =>
          items.find((i) => i.action === 'accept-all'),
        ) as unknown as AuditReviewUi['showQuickPick'],
      });
      await reviewAuditBuffer(baseDeps(buf, ui));
      expect(writeFileSpy).toHaveBeenCalled();
      expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('accepted 1'));
      expect(buf.isEmpty).toBe(true);
    } finally {
      writeFileSpy.mockRestore();
      createDirSpy.mockRestore();
      readFileSpy.mockRestore();
    }
  });

  it('dispatches to rejectAll when the user picks Reject All', async () => {
    const buf = await makeBufferWith([{ op: 'write', path: 'a.ts', content: 'A' }]);
    const ui = makeUi({
      showQuickPick: vi.fn(async (items: readonly { label: string; action?: string }[]) =>
        items.find((i) => i.action === 'reject-all'),
      ) as unknown as AuditReviewUi['showQuickPick'],
      showWarningConfirm: vi.fn(async () => 'Reject All'),
    });
    await reviewAuditBuffer(baseDeps(buf, ui));
    expect(ui.showWarningConfirm).toHaveBeenCalled();
    expect(buf.isEmpty).toBe(true);
    expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('rejected 1'));
  });

  it('opens a diff when the user picks a specific entry', async () => {
    const buf = await makeBufferWith([{ op: 'write', path: 'a.ts', content: 'new-content' }], {
      'a.ts': 'orig-content',
    });
    // 1st call: review picker returns 'open' row. 2nd: post-diff picker
    // returns undefined (ESC — loops back to review). 3rd: review picker
    // returns undefined (user ESC's out, terminating the loop).
    let callIdx = 0;
    const ui = makeUi({
      showQuickPick: vi.fn(async (items: readonly { label: string; action?: string }[]) => {
        callIdx += 1;
        if (callIdx === 1) return items.find((i) => i.action === 'open');
        return undefined;
      }) as unknown as AuditReviewUi['showQuickPick'],
    });
    await reviewAuditBuffer(baseDeps(buf, ui));
    expect(ui.openDiff).toHaveBeenCalledTimes(1);
    const [, , title] = ui.openDiff.mock.calls[0];
    expect(title).toContain('a.ts');
    expect(title).toContain('modify');
  });

  it('does nothing when the user cancels the picker', async () => {
    const buf = await makeBufferWith([{ op: 'write', path: 'a.ts', content: 'A' }]);
    const ui = makeUi();
    await reviewAuditBuffer(baseDeps(buf, ui));
    expect(ui.openDiff).not.toHaveBeenCalled();
    expect(buf.isEmpty).toBe(false);
  });

  it('accepts a single file via the post-diff picker', async () => {
    const buf = await makeBufferWith([
      { op: 'write', path: 'a.ts', content: 'A' },
      { op: 'write', path: 'b.ts', content: 'B' },
    ]);
    const writeFileSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined);
    const createDirSpy = vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined);
    const readFileSpy = vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(new Error('FileNotFound'));
    try {
      // Call sequence: (1) review→open a.ts, (2) post-diff→accept-one,
      // (3) review (one entry left, b.ts)→cancel to exit.
      let callIdx = 0;
      const ui = makeUi({
        showQuickPick: vi.fn(async (items: readonly { label: string; action?: string }[]) => {
          callIdx += 1;
          if (callIdx === 1) return items.find((i) => i.action === 'open');
          if (callIdx === 2) return items.find((i) => i.action === 'accept-one');
          return undefined;
        }) as unknown as AuditReviewUi['showQuickPick'],
      });
      await reviewAuditBuffer(baseDeps(buf, ui));
      expect(writeFileSpy).toHaveBeenCalledTimes(1);
      expect(buf.has('a.ts')).toBe(false);
      expect(buf.has('b.ts')).toBe(true); // untouched
    } finally {
      writeFileSpy.mockRestore();
      createDirSpy.mockRestore();
      readFileSpy.mockRestore();
    }
  });

  it('rejects a single file via the post-diff picker without modal', async () => {
    const buf = await makeBufferWith([
      { op: 'write', path: 'a.ts', content: 'A' },
      { op: 'write', path: 'b.ts', content: 'B' },
    ]);
    let callIdx = 0;
    const ui = makeUi({
      showQuickPick: vi.fn(async (items: readonly { label: string; action?: string }[]) => {
        callIdx += 1;
        if (callIdx === 1) return items.find((i) => i.action === 'open');
        if (callIdx === 2) return items.find((i) => i.action === 'reject-one');
        return undefined;
      }) as unknown as AuditReviewUi['showQuickPick'],
    });
    await reviewAuditBuffer(baseDeps(buf, ui));
    // No modal confirmation on per-file reject — the diff view was the confirmation.
    expect(ui.showWarningConfirm).not.toHaveBeenCalled();
    expect(buf.has('a.ts')).toBe(false);
    expect(buf.has('b.ts')).toBe(true);
  });

  it('loops back to review when the user picks "Back to Review"', async () => {
    const buf = await makeBufferWith([{ op: 'write', path: 'a.ts', content: 'A' }]);
    let callIdx = 0;
    const ui = makeUi({
      showQuickPick: vi.fn(async (items: readonly { label: string; action?: string }[]) => {
        callIdx += 1;
        if (callIdx === 1) return items.find((i) => i.action === 'open');
        if (callIdx === 2) return items.find((i) => i.action === 'back');
        return undefined; // terminating cancel on 3rd call
      }) as unknown as AuditReviewUi['showQuickPick'],
    });
    await reviewAuditBuffer(baseDeps(buf, ui));
    // Back-to-Review means the review picker re-opened — 3 total calls.
    expect(callIdx).toBe(3);
    // Entry still pending.
    expect(buf.has('a.ts')).toBe(true);
  });
});

describe('acceptAllAuditBuffer', () => {
  let writeFileSpy: ReturnType<typeof vi.spyOn>;
  let deleteSpy: ReturnType<typeof vi.spyOn>;
  let createDirSpy: ReturnType<typeof vi.spyOn>;
  let readFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeFileSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined);
    deleteSpy = vi.spyOn(workspace.fs, 'delete').mockResolvedValue(undefined);
    createDirSpy = vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined);
    // Conflict detection reads disk before flushing. Default to
    // FileNotFound so buffers with `originalContent: undefined`
    // (fresh creates) don't register as conflicts — tests that
    // want to exercise the conflict path override this.
    readFileSpy = vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(new Error('FileNotFound'));
  });

  afterEach(() => {
    writeFileSpy.mockRestore();
    deleteSpy.mockRestore();
    createDirSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it('flushes every create/modify entry through workspace.fs.writeFile', async () => {
    const buf = await makeBufferWith([
      { op: 'write', path: 'a.ts', content: 'A' },
      { op: 'write', path: 'b/c.ts', content: 'C' },
    ]);
    const ui = makeUi();
    await acceptAllAuditBuffer(baseDeps(buf, ui));
    // Both files written — we don't assert exact URIs because joinPath
    // behavior in the mock is simple concat, but both calls should have fired.
    expect(writeFileSpy).toHaveBeenCalledTimes(2);
    expect(createDirSpy).toHaveBeenCalled();
    expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('accepted 2'));
    expect(buf.isEmpty).toBe(true);
  });

  it('routes delete entries through workspace.fs.delete with useTrash', async () => {
    const buf = await makeBufferWith([{ op: 'delete', path: 'gone.ts' }], { 'gone.ts': 'previous' });
    // Buffer captured 'previous' as originalContent; make readFile
    // return matching bytes so conflict detection stays quiet.
    readFileSpy.mockResolvedValueOnce(Buffer.from('previous') as never);
    const ui = makeUi();
    await acceptAllAuditBuffer(baseDeps(buf, ui));
    expect(deleteSpy).toHaveBeenCalledTimes(1);
    const [, opts] = deleteSpy.mock.calls[0];
    expect(opts).toEqual({ useTrash: true });
    expect(writeFileSpy).not.toHaveBeenCalled();
  });

  it('shows an error and preserves the buffer when flush fails', async () => {
    const buf = await makeBufferWith([
      { op: 'write', path: 'ok.ts', content: 'A' },
      { op: 'write', path: 'bad.ts', content: 'B' },
    ]);
    let call = 0;
    writeFileSpy.mockImplementation(async (uri: unknown) => {
      call += 1;
      const p = (uri as { fsPath: string }).fsPath;
      if (p.endsWith('bad.ts')) throw new Error('disk full');
    });
    const ui = makeUi();
    await acceptAllAuditBuffer(baseDeps(buf, ui));
    expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining('failed'));
    // Buffer NOT cleared — flush threw, user can retry after fixing.
    expect(buf.isEmpty).toBe(false);
    expect(call).toBeGreaterThan(0);
  });

  it('returns early on an empty buffer with an info toast', async () => {
    const buf = new AuditBuffer();
    const ui = makeUi();
    await acceptAllAuditBuffer(baseDeps(buf, ui));
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('empty'));
  });
});

describe('rejectAllAuditBuffer', () => {
  it('clears the buffer when the user confirms', async () => {
    const buf = await makeBufferWith([{ op: 'write', path: 'a.ts', content: 'A' }]);
    const ui = makeUi({ showWarningConfirm: vi.fn(async () => 'Reject All') });
    await rejectAllAuditBuffer(baseDeps(buf, ui));
    expect(buf.isEmpty).toBe(true);
    expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('rejected 1'));
  });

  it('leaves the buffer intact when the user dismisses the confirmation', async () => {
    const buf = await makeBufferWith([{ op: 'write', path: 'a.ts', content: 'A' }]);
    const ui = makeUi({ showWarningConfirm: vi.fn(async () => undefined) });
    await rejectAllAuditBuffer(baseDeps(buf, ui));
    expect(buf.isEmpty).toBe(false);
    expect(ui.showInfo).not.toHaveBeenCalled();
  });

  it('returns early on an empty buffer with an info toast', async () => {
    const buf = new AuditBuffer();
    const ui = makeUi();
    await rejectAllAuditBuffer(baseDeps(buf, ui));
    expect(buf.isEmpty).toBe(true);
    expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('empty'));
    expect(ui.showWarningConfirm).not.toHaveBeenCalled();
  });
});

describe('acceptFileAuditBuffer', () => {
  it('flushes just the named path and leaves the rest of the buffer alone', async () => {
    const buf = await makeBufferWith([
      { op: 'write', path: 'a.ts', content: 'A' },
      { op: 'write', path: 'b.ts', content: 'B' },
    ]);
    const writeFileSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined);
    const createDirSpy = vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined);
    const readFileSpy = vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(new Error('FileNotFound'));
    try {
      const ui = makeUi();
      await acceptFileAuditBuffer(baseDeps(buf, ui), 'a.ts');
      expect(writeFileSpy).toHaveBeenCalledTimes(1);
      expect(buf.has('a.ts')).toBe(false);
      expect(buf.has('b.ts')).toBe(true);
      expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('accepted 1'));
    } finally {
      writeFileSpy.mockRestore();
      createDirSpy.mockRestore();
      readFileSpy.mockRestore();
    }
  });

  it('is a no-op with info toast when the path is not in the buffer', async () => {
    const buf = await makeBufferWith([{ op: 'write', path: 'a.ts', content: 'A' }]);
    const writeFileSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined);
    try {
      const ui = makeUi();
      await acceptFileAuditBuffer(baseDeps(buf, ui), 'nonexistent.ts');
      expect(writeFileSpy).not.toHaveBeenCalled();
      expect(buf.has('a.ts')).toBe(true);
      expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('not in the buffer'));
    } finally {
      writeFileSpy.mockRestore();
    }
  });
});

describe('rejectFileAuditBuffer', () => {
  it('clears just the named path without touching disk', async () => {
    const buf = await makeBufferWith([
      { op: 'write', path: 'a.ts', content: 'A' },
      { op: 'write', path: 'b.ts', content: 'B' },
    ]);
    const writeFileSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined);
    const deleteSpy = vi.spyOn(workspace.fs, 'delete').mockResolvedValue(undefined);
    try {
      const ui = makeUi();
      await rejectFileAuditBuffer(baseDeps(buf, ui), 'a.ts');
      expect(writeFileSpy).not.toHaveBeenCalled();
      expect(deleteSpy).not.toHaveBeenCalled();
      expect(buf.has('a.ts')).toBe(false);
      expect(buf.has('b.ts')).toBe(true);
      expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('rejected a.ts'));
    } finally {
      writeFileSpy.mockRestore();
      deleteSpy.mockRestore();
    }
  });

  it('is a no-op with info toast when the path is not in the buffer', async () => {
    const buf = await makeBufferWith([{ op: 'write', path: 'a.ts', content: 'A' }]);
    const ui = makeUi();
    await rejectFileAuditBuffer(baseDeps(buf, ui), 'nonexistent.ts');
    expect(buf.has('a.ts')).toBe(true);
    expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('not in the buffer'));
  });
});

describe('conflict detection on flush (v0.61 a.2)', () => {
  let writeFileSpy: ReturnType<typeof vi.spyOn>;
  let deleteSpy: ReturnType<typeof vi.spyOn>;
  let createDirSpy: ReturnType<typeof vi.spyOn>;
  let readFileSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeFileSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined);
    deleteSpy = vi.spyOn(workspace.fs, 'delete').mockResolvedValue(undefined);
    createDirSpy = vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined);
    readFileSpy = vi.spyOn(workspace.fs, 'readFile');
  });

  afterEach(() => {
    writeFileSpy.mockRestore();
    deleteSpy.mockRestore();
    createDirSpy.mockRestore();
    readFileSpy.mockRestore();
  });

  it('detects a conflict when disk content diverges from the captured baseline', async () => {
    // Buffer captured 'v1' as baseline; disk now has 'v2' — classic
    // user-edited-the-file-during-review case.
    const buf = await makeBufferWith([{ op: 'write', path: 'a.ts', content: 'v3' }], { 'a.ts': 'v1' });
    readFileSpy.mockResolvedValue(Buffer.from('v2') as never);
    const ui = makeUi({ showConflictDialog: vi.fn(async () => 'apply-anyway' as const) });

    await acceptAllAuditBuffer(baseDeps(buf, ui));

    expect(ui.showConflictDialog).toHaveBeenCalledWith(expect.stringContaining('a.ts was modified on disk'));
    // User said apply-anyway → flush proceeded.
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    expect(buf.isEmpty).toBe(true);
  });

  it('aborts flush and preserves buffer when user cancels the conflict dialog', async () => {
    const buf = await makeBufferWith([{ op: 'write', path: 'a.ts', content: 'v3' }], { 'a.ts': 'v1' });
    readFileSpy.mockResolvedValue(Buffer.from('v2') as never);
    const ui = makeUi({ showConflictDialog: vi.fn(async () => undefined) });

    await acceptAllAuditBuffer(baseDeps(buf, ui));

    expect(ui.showConflictDialog).toHaveBeenCalled();
    // Cancelled → nothing written.
    expect(writeFileSpy).not.toHaveBeenCalled();
    expect(buf.has('a.ts')).toBe(true);
    expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('flush cancelled'));
  });

  it('skips the dialog entirely when disk matches the captured baseline', async () => {
    const buf = await makeBufferWith([{ op: 'write', path: 'a.ts', content: 'new' }], { 'a.ts': 'baseline' });
    readFileSpy.mockResolvedValue(Buffer.from('baseline') as never);
    const ui = makeUi();

    await acceptAllAuditBuffer(baseDeps(buf, ui));

    expect(ui.showConflictDialog).not.toHaveBeenCalled();
    expect(writeFileSpy).toHaveBeenCalledTimes(1);
    expect(buf.isEmpty).toBe(true);
  });

  it('flags "deleted from disk" when baseline existed but disk no longer has the file', async () => {
    const buf = await makeBufferWith([{ op: 'write', path: 'a.ts', content: 'new' }], { 'a.ts': 'baseline' });
    readFileSpy.mockRejectedValue(new Error('FileNotFound'));
    const ui = makeUi({ showConflictDialog: vi.fn(async () => 'apply-anyway' as const) });

    await acceptAllAuditBuffer(baseDeps(buf, ui));

    const msg = (ui.showConflictDialog.mock.calls[0] as [string])[0];
    expect(msg).toContain('a.ts was deleted from disk');
  });

  it('lists every conflicting path in the multi-file message', async () => {
    const buf = await makeBufferWith(
      [
        { op: 'write', path: 'a.ts', content: 'new-a' },
        { op: 'write', path: 'b.ts', content: 'new-b' },
      ],
      { 'a.ts': 'base-a', 'b.ts': 'base-b' },
    );
    // Both files diverge on disk.
    readFileSpy.mockImplementation(async (uri: unknown) => {
      const p = (uri as { fsPath: string }).fsPath;
      if (p.endsWith('a.ts')) return Buffer.from('disk-a') as never;
      if (p.endsWith('b.ts')) return Buffer.from('disk-b') as never;
      throw new Error('FileNotFound');
    });
    const ui = makeUi({ showConflictDialog: vi.fn(async () => 'apply-anyway' as const) });

    await acceptAllAuditBuffer(baseDeps(buf, ui));

    const msg = (ui.showConflictDialog.mock.calls[0] as [string])[0];
    expect(msg).toContain('2 files changed');
    expect(msg).toContain('a.ts');
    expect(msg).toContain('b.ts');
  });

  it('only checks conflicts for the requested subset when flushing per-file', async () => {
    const buf = await makeBufferWith(
      [
        { op: 'write', path: 'a.ts', content: 'new-a' },
        { op: 'write', path: 'b.ts', content: 'new-b' },
      ],
      { 'a.ts': 'base-a', 'b.ts': 'base-b' },
    );
    // Only b.ts diverges. If we accept a.ts alone, no conflict should surface.
    readFileSpy.mockImplementation(async (uri: unknown) => {
      const p = (uri as { fsPath: string }).fsPath;
      if (p.endsWith('a.ts')) return Buffer.from('base-a') as never;
      if (p.endsWith('b.ts')) return Buffer.from('disk-b') as never;
      throw new Error('FileNotFound');
    });
    const ui = makeUi();

    await acceptFileAuditBuffer(baseDeps(buf, ui), 'a.ts');

    expect(ui.showConflictDialog).not.toHaveBeenCalled();
    expect(buf.has('a.ts')).toBe(false);
    expect(buf.has('b.ts')).toBe(true);
  });
});
