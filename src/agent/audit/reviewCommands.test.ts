import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { workspace, Uri } from 'vscode';
import { AuditBuffer } from './auditBuffer.js';
import {
  reviewAuditBuffer,
  acceptAllAuditBuffer,
  rejectAllAuditBuffer,
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
} {
  return {
    showQuickPick: vi.fn(async () => undefined),
    showInfo: vi.fn(),
    showWarningConfirm: vi.fn(async () => undefined),
    showError: vi.fn(),
    openDiff: vi.fn(async () => {}),
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
    const ui = makeUi({
      showQuickPick: vi.fn(async (items: readonly { label: string; action?: string }[]) =>
        items.find((i) => i.action === 'open'),
      ) as unknown as AuditReviewUi['showQuickPick'],
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
});

describe('acceptAllAuditBuffer', () => {
  let writeFileSpy: ReturnType<typeof vi.spyOn>;
  let deleteSpy: ReturnType<typeof vi.spyOn>;
  let createDirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    writeFileSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined);
    deleteSpy = vi.spyOn(workspace.fs, 'delete').mockResolvedValue(undefined);
    createDirSpy = vi.spyOn(workspace.fs, 'createDirectory').mockResolvedValue(undefined);
  });

  afterEach(() => {
    writeFileSpy.mockRestore();
    deleteSpy.mockRestore();
    createDirSpy.mockRestore();
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
