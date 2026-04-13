/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted gives us mock refs that survive vi.mock's top-of-file hoisting.
const { mockWriteFile, mockCreateDirectory, mockExecuteCommand } = vi.hoisted(() => ({
  mockWriteFile: vi.fn(async () => undefined),
  mockCreateDirectory: vi.fn(async () => undefined),
  mockExecuteCommand: vi.fn(async () => undefined),
}));

vi.mock('vscode', () => {
  class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => {
      this.listeners.push(listener);
      return { dispose: () => {} };
    };
    fire(data: T): void {
      for (const l of this.listeners) l(data);
    }
    dispose(): void {
      this.listeners = [];
    }
  }
  return {
    EventEmitter,
    Uri: {
      file: (p: string) => ({ fsPath: p, scheme: 'file', path: p }),
      parse: (s: string) => ({ fsPath: s, scheme: 'sidecar-proposed', path: s }),
    },
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/test' } }],
      fs: {
        writeFile: mockWriteFile,
        createDirectory: mockCreateDirectory,
      },
    },
    commands: {
      executeCommand: mockExecuteCommand,
    },
    TreeItem: class TreeItem {
      description?: string;
      tooltip?: string;
      iconPath?: unknown;
      resourceUri?: unknown;
      contextValue?: string;
      command?: unknown;
      constructor(
        public label: string,
        public collapsibleState: number,
      ) {}
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class ThemeIcon {
      constructor(public id: string) {}
    },
  };
});

import { ReviewTreeProvider, applyPendingEdit, openReviewDiff } from './reviewPanel.js';
import { PendingEditStore, type PendingEdit } from './pendingEdits.js';
import type { ProposedContentProvider } from '../edits/proposedContentProvider.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEdit(filePath: string, extras: Partial<PendingEdit> = {}): PendingEdit {
  return {
    filePath,
    originalContent: 'before',
    newContent: 'after',
    updatedAt: Date.now(),
    lastTool: 'write_file',
    ...extras,
  };
}

function makeFakeContentProvider() {
  const proposals = new Map<string, string>();
  return {
    addProposal: vi.fn((key: string, content: string) => {
      proposals.set(key, content);
      return { fsPath: `sidecar-proposed:${key}`, scheme: 'sidecar-proposed', path: key };
    }),
    removeProposal: vi.fn((key: string) => {
      proposals.delete(key);
    }),
    _proposals: proposals,
  } as unknown as ProposedContentProvider & { _proposals: Map<string, string> };
}

beforeEach(() => {
  mockWriteFile.mockClear();
  mockCreateDirectory.mockClear();
  mockExecuteCommand.mockClear();
});

// ---------------------------------------------------------------------------
// ReviewTreeProvider
// ---------------------------------------------------------------------------

describe('ReviewTreeProvider', () => {
  it('returns the store entries as top-level children', () => {
    const store = new PendingEditStore();
    store.record('/test/src/a.ts', 'x', 'y', 'write_file');
    store.record('/test/src/b.ts', 'x', 'y', 'write_file');

    const provider = new ReviewTreeProvider(store);
    const children = provider.getChildren();
    expect(children).toHaveLength(2);
    expect(children.map((e) => e.filePath).sort()).toEqual(['/test/src/a.ts', '/test/src/b.ts']);
  });

  it('returns an empty array for any non-root element (flat tree)', () => {
    const store = new PendingEditStore();
    store.record('/test/a.ts', 'x', 'y', 'write_file');
    const provider = new ReviewTreeProvider(store);
    const root = provider.getChildren()[0];
    expect(provider.getChildren(root)).toEqual([]);
  });

  it('builds a TreeItem with the basename as label and parent dir as description', () => {
    const store = new PendingEditStore();
    const edit = makeEdit('/test/src/agent/foo.ts');
    const provider = new ReviewTreeProvider(store);
    const item = provider.getTreeItem(edit);
    expect(item.label).toBe('foo.ts');
    expect(item.description).toBe('src/agent');
  });

  it('omits the description when the file is at workspace root', () => {
    const store = new PendingEditStore();
    const edit = makeEdit('/test/root.ts');
    const provider = new ReviewTreeProvider(store);
    const item = provider.getTreeItem(edit);
    expect(item.description).toBeUndefined();
  });

  it('wires a command on each TreeItem that opens the diff', () => {
    const store = new PendingEditStore();
    const edit = makeEdit('/test/a.ts');
    const provider = new ReviewTreeProvider(store);
    const item = provider.getTreeItem(edit);
    expect(item.command).toBeDefined();
    expect((item.command as any).command).toBe('sidecar.review.openDiff');
    expect((item.command as any).arguments).toEqual([edit]);
  });

  it('fires onDidChangeTreeData when the underlying store changes', () => {
    const store = new PendingEditStore();
    const provider = new ReviewTreeProvider(store);
    const listener = vi.fn();
    provider.onDidChangeTreeData(listener);
    store.record('/test/a.ts', 'x', 'y', 'write_file');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('uses diff-added icon for file creations (null originalContent)', () => {
    const store = new PendingEditStore();
    const provider = new ReviewTreeProvider(store);
    const item = provider.getTreeItem(makeEdit('/test/fresh.ts', { originalContent: null }));
    expect((item.iconPath as any).id).toBe('diff-added');
  });

  it('uses diff-modified icon for file updates (non-null originalContent)', () => {
    const store = new PendingEditStore();
    const provider = new ReviewTreeProvider(store);
    const item = provider.getTreeItem(makeEdit('/test/existing.ts', { originalContent: 'old' }));
    expect((item.iconPath as any).id).toBe('diff-modified');
  });
});

// ---------------------------------------------------------------------------
// applyPendingEdit
// ---------------------------------------------------------------------------

describe('applyPendingEdit', () => {
  it('writes the pending content to disk as UTF-8', async () => {
    await applyPendingEdit(makeEdit('/test/a.ts', { newContent: 'hello world' }));
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
    const args = mockWriteFile.mock.calls[0] as unknown as [{ fsPath: string }, Uint8Array];
    expect(args[0].fsPath).toBe('/test/a.ts');
    expect(Buffer.from(args[1]).toString('utf-8')).toBe('hello world');
  });

  it('creates parent directories for nested paths', async () => {
    await applyPendingEdit(makeEdit('/test/nested/deep/file.ts'));
    expect(mockCreateDirectory).toHaveBeenCalledTimes(1);
    const args = mockCreateDirectory.mock.calls[0] as unknown as [{ fsPath: string }];
    expect(args[0].fsPath).toBe('/test/nested/deep');
  });

  it('propagates filesystem errors so the caller can surface them', async () => {
    mockWriteFile.mockRejectedValueOnce(new Error('EACCES'));
    await expect(applyPendingEdit(makeEdit('/test/a.ts'))).rejects.toThrow('EACCES');
  });
});

// ---------------------------------------------------------------------------
// openReviewDiff
// ---------------------------------------------------------------------------

describe('openReviewDiff', () => {
  it('adds before and after proposals and opens the diff editor', async () => {
    const cp = makeFakeContentProvider();
    await openReviewDiff(makeEdit('/test/a.ts', { originalContent: 'OLD', newContent: 'NEW' }), cp);
    expect(cp.addProposal).toHaveBeenCalledTimes(2);
    // First call is "before", second is "after"
    expect((cp as any)._proposals.size).toBe(2);
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    const args = mockExecuteCommand.mock.calls[0] as unknown as [string, ...unknown[]];
    expect(args[0]).toBe('vscode.diff');
  });

  it('treats originalContent=null as an empty baseline (create case)', async () => {
    const cp = makeFakeContentProvider();
    await openReviewDiff(makeEdit('/test/fresh.ts', { originalContent: null, newContent: 'hi' }), cp);
    // Find which call held the "before" proposal and check its content.
    const beforeCall = (cp.addProposal as any).mock.calls.find((c: [string, string]) =>
      c[0].startsWith('review-before/'),
    );
    expect(beforeCall[1]).toBe('');
    const afterCall = (cp.addProposal as any).mock.calls.find((c: [string, string]) =>
      c[0].startsWith('review-after/'),
    );
    expect(afterCall[1]).toBe('hi');
  });

  it('labels the diff title differently for new vs modified files', async () => {
    const cp = makeFakeContentProvider();
    await openReviewDiff(makeEdit('/test/new.ts', { originalContent: null }), cp);
    const args1 = mockExecuteCommand.mock.calls[0] as unknown as [string, unknown, unknown, string];
    expect(args1[3]).toContain('new file');

    mockExecuteCommand.mockClear();
    await openReviewDiff(makeEdit('/test/mod.ts', { originalContent: 'x' }), cp);
    const args2 = mockExecuteCommand.mock.calls[0] as unknown as [string, unknown, unknown, string];
    expect(args2[3]).toContain('pending review');
  });
});
