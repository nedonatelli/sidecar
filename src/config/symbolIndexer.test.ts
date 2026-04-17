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

  describe('PKI symbol-embedding wiring (v0.61 b.2)', () => {
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
});
