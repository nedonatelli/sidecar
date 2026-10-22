import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'path';
import { workspace, Uri } from 'vscode';
import { WorkspaceIndex } from './workspaceIndex.js';
import { SymbolIndexer } from './symbolIndexer.js';

// #113: in a multi-root workspace the file watcher keyed a change relative to
// the folder that saw it and handed that key to the symbol indexer, which
// resolves keys against the FIRST folder. A change to b/src/x.ts re-read (or,
// when absent, dropped from the graph) a/src/x.ts.

const A = path.resolve('/ws/a');
const B = path.resolve('/ws/b');
const folders = [
  { uri: Uri.file(A), name: 'a', index: 0 },
  { uri: Uri.file(B), name: 'b', index: 1 },
];

type Handler = (uri: { fsPath: string }) => void;
let handlersByRoot: Map<string, { create?: Handler; change?: Handler; del?: Handler }>;
let savedFolders: unknown;

beforeEach(() => {
  vi.restoreAllMocks();
  savedFolders = workspace.workspaceFolders;
  (workspace as { workspaceFolders: unknown }).workspaceFolders = folders;
  handlersByRoot = new Map();
  vi.spyOn(workspace, 'findFiles').mockResolvedValue([] as never);
  vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 10 } as never);
  vi.spyOn(workspace, 'createFileSystemWatcher').mockImplementation(((pattern: { base?: { fsPath: string } }) => {
    const root = pattern.base?.fsPath ?? '';
    const h: { create?: Handler; change?: Handler; del?: Handler } = {};
    handlersByRoot.set(root, h);
    return {
      onDidCreate: (fn: Handler) => ((h.create = fn), { dispose() {} }),
      onDidChange: (fn: Handler) => ((h.change = fn), { dispose() {} }),
      onDidDelete: (fn: Handler) => ((h.del = fn), { dispose() {} }),
      dispose() {},
    };
  }) as never);
});

afterEach(() => {
  (workspace as { workspaceFolders: unknown }).workspaceFolders = savedFolders;
});

describe('symbol graph keys in a multi-root workspace (#113)', () => {
  it("SymbolIndexer.keyFor keys another folder's file relative to the first folder, as initialize does", async () => {
    const indexer = new SymbolIndexer(null);
    await indexer.initialize(['**/*.ts']);
    expect(indexer.keyFor(path.join(A, 'src', 'x.ts'))).toBe('src/x.ts');
    expect(indexer.keyFor(path.join(B, 'src', 'x.ts'))).toBe('../b/src/x.ts');
  });

  it("a change in the second folder reaches the graph under that file's own key", async () => {
    const index = new WorkspaceIndex(5000);
    const queued: string[] = [];
    const deleted: string[] = [];
    index.setSymbolIndexer({
      keyFor: (fsPath: string) => path.relative(A, fsPath).split(path.sep).join('/'),
      queueUpdate: (k: string) => void queued.push(k),
      queueDelete: (k: string) => void deleted.push(k),
      setIgnoreMatchers: () => {},
      getGraph: () => null,
    } as never);
    await index.initialize(['**/*.ts']);

    const inB = handlersByRoot.get(B);
    expect(inB?.change).toBeDefined();
    inB!.change!({ fsPath: path.join(B, 'src', 'x.ts') });
    inB!.del!({ fsPath: path.join(B, 'src', 'gone.ts') });

    // Not 'src/x.ts', which the indexer would resolve inside folder a.
    expect(queued).toEqual(['../b/src/x.ts']);
    expect(deleted).toEqual(['../b/src/gone.ts']);
  });
});
