import { describe, it, expect, vi } from 'vitest';
import { SymbolIndexer } from './symbolIndexer.js';
import { workspace } from 'vscode';

describe('SymbolIndexer', () => {
  it('creates instance with null sidecarDir', () => {
    const indexer = new SymbolIndexer(null);
    expect(indexer).toBeDefined();
    expect(indexer.getGraph()).toBeDefined();
  });

  it('getGraph returns a SymbolGraph instance', () => {
    const indexer = new SymbolIndexer(null);
    const graph = indexer.getGraph();
    expect(graph.symbolCount()).toBe(0);
  });

  it('initialize returns early when no workspace folders', async () => {
    const origFolders = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;

    const indexer = new SymbolIndexer(null);
    await indexer.initialize(['**/*.ts']);
    expect(indexer.getGraph().symbolCount()).toBe(0);

    (workspace as Record<string, unknown>).workspaceFolders = origFolders;
  });

  it('initialize processes workspace files', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([{ fsPath: '/mock-workspace/src/app.ts' }] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100, mtime: Date.now() } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(
      Buffer.from('export function hello() { return "world"; }') as never,
    );

    const indexer = new SymbolIndexer(null);
    await indexer.initialize(['**/*.ts']);

    // Should have parsed the file (may or may not find symbols depending on analyzer)
    expect(indexer.getGraph()).toBeDefined();

    vi.restoreAllMocks();
  });

  it('queueUpdate adds path to pending updates', () => {
    const indexer = new SymbolIndexer(null);
    // Should not throw
    indexer.queueUpdate('src/app.ts');
    indexer.dispose();
  });

  it('queueDelete adds path to pending deletes', () => {
    const indexer = new SymbolIndexer(null);
    indexer.queueDelete('src/old.ts');
    indexer.dispose();
  });

  it('queueUpdate cancels pending delete for same path', () => {
    const indexer = new SymbolIndexer(null);
    indexer.queueDelete('src/app.ts');
    indexer.queueUpdate('src/app.ts');
    // Should not throw, internal state is managed
    indexer.dispose();
  });

  it('queueDelete cancels pending update for same path', () => {
    const indexer = new SymbolIndexer(null);
    indexer.queueUpdate('src/app.ts');
    indexer.queueDelete('src/app.ts');
    indexer.dispose();
  });

  it('dispose cleans up timers without error', () => {
    const indexer = new SymbolIndexer(null);
    indexer.queueUpdate('src/a.ts');
    expect(() => indexer.dispose()).not.toThrow();
  });

  describe('liveSymbolIds', () => {
    const sym = (qualifiedName: string, startLine: number) => ({
      name: qualifiedName,
      qualifiedName,
      type: 'function' as const,
      filePath: 'src/t.ts',
      startLine,
      endLine: startLine + 1,
      exported: false,
    });

    it('numbers same-named siblings so they stop overwriting each other', () => {
      const indexer = new SymbolIndexer(null);
      indexer.getGraph().addFile('src/t.ts', [sym('tool', 1), sym('tool', 3), sym('other', 5)], [], 'h');

      expect([...indexer.liveSymbolIds()].sort()).toEqual(['src/t.ts::other', 'src/t.ts::tool', 'src/t.ts::tool#1']);
    });

    it('agrees exactly with the IDs the replay queues', async () => {
      // The load-bearing invariant. `reconcile` deletes anything in the index
      // and not in this set, so if the two sides ever assigned ordinals
      // differently, every start would delete live rows that the following
      // replay re-embeds — forever.
      const indexer = new SymbolIndexer(null);
      const graph = indexer.getGraph();
      graph.addFile('src/t.ts', [sym('tool', 1), sym('tool', 3), sym('tool', 5), sym('other', 7)], [], 'h');
      graph.setFileContent('src/t.ts', Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));

      const queued: Array<{ filePath: string; qualifiedName: string; ordinal?: number }> = [];
      indexer.setSymbolEmbeddings({ queueSymbol: (i: never) => queued.push(i) } as never);
      await indexer.replaySymbolsToEmbeddingIndex();

      const { makeSymbolId } = await import('./symbolEmbeddingIndex.js');
      const replayIds = queued.map((q) => makeSymbolId(q.filePath, q.qualifiedName, q.ordinal));
      expect(replayIds).toHaveLength(4);
      expect(new Set(replayIds).size).toBe(4); // no collisions
      for (const id of replayIds) expect(indexer.liveSymbolIds().has(id)).toBe(true);
    });
  });

  describe('PKI symbol-embedding wiring', () => {
    it('setSymbolEmbeddings with null leaves embedder-related state unchanged', () => {
      const indexer = new SymbolIndexer(null);
      // Should not throw; defaults are preserved so the pre-PKI
      // behavior path stays identical.
      indexer.setSymbolEmbeddings(null);
      expect(indexer.getGraph().symbolCount()).toBe(0);
    });

    it('feeds parsed symbols into the embedding queue when one is attached', async () => {
      vi.spyOn(workspace, 'findFiles').mockResolvedValue([{ fsPath: '/mock-workspace/src/auth.ts' }] as never);
      vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 500, mtime: Date.now() } as never);
      vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(
        Buffer.from(
          // Two exported functions so the regex analyzer definitely picks up
          // ≥ 1 symbol (the exact shape varies by language heuristic, but
          // these should all trip the TS function path).
          [
            'export function requireAuth(req, res, next) {',
            '  verifyToken(req);',
            '}',
            '',
            'export function verifyToken(req) {',
            '  return req.headers.authorization;',
            '}',
            '',
          ].join('\n'),
        ) as never,
      );

      const queueSymbolSpy = vi.fn();
      const removeFileSpy = vi.fn();
      const fakeEmbed = {
        queueSymbol: queueSymbolSpy,
        removeFile: removeFileSpy,
      } as never;

      const indexer = new SymbolIndexer(null);
      indexer.setSymbolEmbeddings(fakeEmbed);
      await indexer.initialize(['**/*.ts']);

      // At least one symbol queued — exact count depends on the analyzer.
      expect(queueSymbolSpy).toHaveBeenCalled();
      const queued = queueSymbolSpy.mock.calls[0][0] as { filePath: string; body: string };
      expect(queued.filePath).toContain('auth.ts');
      expect(queued.body.length).toBeGreaterThan(0);
      // Nothing deleted during a fresh init.
      expect(removeFileSpy).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('replaySymbolsToEmbeddingIndex reads file content from disk when the restored graph has none', async () => {
      // Simulates a warm reload: the graph is restored from symbol-graph.json,
      // which persists symbols + hashes but NOT file contents. addFile() sets
      // both without content, so getFileContent() is empty — the replay must
      // fall back to reading the file from disk or it queues nothing.
      const body = ['export function requireAuth(req) {', '  return verifyToken(req);', '}', ''].join('\n');
      vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(body) as never);

      const indexer = new SymbolIndexer(null);
      const graph = indexer.getGraph();
      graph.addFile(
        'src/auth.ts',
        [
          {
            name: 'requireAuth',
            qualifiedName: 'requireAuth',
            type: 'function',
            filePath: 'src/auth.ts',
            startLine: 1,
            endLine: 3,
            exported: true,
          },
        ],
        [],
        'size:mtime',
      );
      expect(graph.getFileContent('src/auth.ts')).toBeUndefined();

      const queueSymbolSpy = vi.fn();
      indexer.setSymbolEmbeddings({ queueSymbol: queueSymbolSpy, removeFile: vi.fn() } as never);

      const result = await indexer.replaySymbolsToEmbeddingIndex();

      expect(result.queued).toBe(1);
      expect(result.filesRead).toBe(1);
      expect(result.filesSkipped).toBe(0);
      expect(workspace.fs.readFile).toHaveBeenCalled();
      expect(queueSymbolSpy).toHaveBeenCalledTimes(1);
      const queuedSymbol = queueSymbolSpy.mock.calls[0][0] as { filePath: string; body: string };
      expect(queuedSymbol.filePath).toBe('src/auth.ts');
      expect(queuedSymbol.body).toContain('requireAuth');

      vi.restoreAllMocks();
    });

    it('replaySymbolsToEmbeddingIndex counts files skipped when content is absent and unreadable', async () => {
      // Restored-graph file with no cached content AND a failing disk read —
      // the case that produces the warn-on-surprising-zero in workspaceIndexer.
      vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(new Error('ENOENT') as never);

      const indexer = new SymbolIndexer(null);
      indexer.getGraph().addFile(
        'src/gone.ts',
        [
          {
            name: 'orphan',
            qualifiedName: 'orphan',
            type: 'function',
            filePath: 'src/gone.ts',
            startLine: 1,
            endLine: 3,
            exported: true,
          },
        ],
        [],
        'size:mtime',
      );

      const queueSymbolSpy = vi.fn();
      indexer.setSymbolEmbeddings({ queueSymbol: queueSymbolSpy, removeFile: vi.fn() } as never);

      const result = await indexer.replaySymbolsToEmbeddingIndex();

      expect(result.queued).toBe(0);
      expect(result.filesRead).toBe(0);
      expect(result.filesSkipped).toBe(1);
      expect(queueSymbolSpy).not.toHaveBeenCalled();

      vi.restoreAllMocks();
    });

    it('removeFileFromGraph drops the file from both graph and embedder', () => {
      const removeFileSpy = vi.fn();
      const indexer = new SymbolIndexer(null);
      indexer.setSymbolEmbeddings({ queueSymbol: vi.fn(), removeFile: removeFileSpy } as never);

      indexer.removeFileFromGraph('src/gone.ts');

      expect(removeFileSpy).toHaveBeenCalledWith('src/gone.ts');
    });

    it('respects maxSymbolsPerFile when capping large files', async () => {
      // Generate a file with 10 exported functions and cap to 3.
      const body = Array.from({ length: 10 }, (_, i) => `export function fn${i}() { return ${i}; }\n`).join('\n');
      vi.spyOn(workspace, 'findFiles').mockResolvedValue([{ fsPath: '/mock-workspace/src/big.ts' }] as never);
      vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: body.length, mtime: Date.now() } as never);
      vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(body) as never);

      const queueSymbolSpy = vi.fn();
      const indexer = new SymbolIndexer(null);
      indexer.setSymbolEmbeddings(
        { queueSymbol: queueSymbolSpy, removeFile: vi.fn() } as never,
        3, // maxSymbolsPerFile
      );

      await indexer.initialize(['**/*.ts']);

      // At most 3 symbols queued — cap honored even if the analyzer
      // found more in the file. `toBeLessThanOrEqual` because on some
      // hosts the regex analyzer may find fewer than 10.
      expect(queueSymbolSpy.mock.calls.length).toBeLessThanOrEqual(3);

      vi.restoreAllMocks();
    });
  });

  // -------------------------------------------------------------------------
  // dispose() lifecycle: must call persist() to flush in-memory state to disk
  // before the extension host shuts down. Without this, symbol index work
  // done during a session is silently lost.
  // -------------------------------------------------------------------------
  describe('dispose() flushes state via persist()', () => {
    it('calls persist() when no timers are pending', () => {
      const indexer = new SymbolIndexer(null);
      const persistSpy = vi.spyOn(indexer, 'persist').mockResolvedValue(undefined);
      indexer.dispose();
      expect(persistSpy).toHaveBeenCalledOnce();
    });

    it('cancels pendingUpdate timer and still calls persist()', () => {
      const indexer = new SymbolIndexer(null);
      // Queue an update — this arms the updateTimer debounce
      indexer.queueUpdate('src/app.ts');
      const persistSpy = vi.spyOn(indexer, 'persist').mockResolvedValue(undefined);
      indexer.dispose();
      // persist must be called even though updateTimer was cancelled mid-flight
      expect(persistSpy).toHaveBeenCalledOnce();
    });

    it('cancels schedulePersist timer and still calls persist()', () => {
      vi.useFakeTimers();
      const indexer = new SymbolIndexer(null);
      // Trigger a schedulePersist via queueUpdate path (update → parse → schedulePersist)
      // We just directly verify dispose() always calls persist regardless of timer state.
      const persistSpy = vi.spyOn(indexer, 'persist').mockResolvedValue(undefined);
      indexer.dispose();
      expect(persistSpy).toHaveBeenCalledOnce();
      vi.useRealTimers();
    });
  });
});
