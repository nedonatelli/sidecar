import { describe, it, expect, vi } from 'vitest';
import { PkiTreeProvider } from './pkiView.js';
import type { SymbolEmbeddingIndex } from '../config/symbolEmbeddingIndex.js';
import type { SymbolIndexer } from '../config/symbolIndexer.js';
import type { WorkspaceIndex } from '../config/workspaceIndex.js';

describe('PkiTreeProvider.rebuild (#113)', () => {
  it('re-embeds the symbols the graph holds after clearing, instead of leaving the index empty', async () => {
    const order: string[] = [];
    const embeddings = {
      clearAll: vi.fn(async () => void order.push('clear')),
      setOnDrained: vi.fn(),
      getDiskBytes: vi.fn(async () => 0),
    } as unknown as SymbolEmbeddingIndex;
    const indexer = {
      // queueUpdate hits the size:mtime short-circuit for unchanged files, so on
      // its own it rebuilds nothing; the replay is what refills the index.
      replaySymbolsToEmbeddingIndex: vi.fn(async () => {
        order.push('replay');
        return { queued: 12, filesRead: 3, filesSkipped: 0 };
      }),
      queueUpdate: vi.fn(() => void order.push('queue')),
    } as unknown as SymbolIndexer;
    const workspace = { getFiles: () => [{ relativePath: 'src/a.ts' }] } as unknown as WorkspaceIndex;

    const view = new PkiTreeProvider();
    view.setIndex(embeddings, indexer, workspace);
    await view.rebuild();

    expect(indexer.replaySymbolsToEmbeddingIndex).toHaveBeenCalledTimes(1);
    // Cleared first, then refilled; changed files are still re-parsed after.
    expect(order).toEqual(['clear', 'replay', 'queue']);
  });
});
