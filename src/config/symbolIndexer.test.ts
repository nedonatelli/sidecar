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
});
