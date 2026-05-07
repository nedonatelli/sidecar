import { describe, it, expect, vi } from 'vitest';
import { DocRetriever } from './docRetriever.js';
import type { DocumentationEntry } from '../../config/documentationIndexer.js';
import type { EmbeddingIndex } from '../../config/embeddingIndex.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<DocumentationEntry> = {}): DocumentationEntry {
  return {
    id: 'e1',
    filePath: 'src/auth.ts',
    lineNumber: 10,
    type: 'function',
    title: 'requireAuth',
    content: 'Middleware that checks the JWT.',
    relevanceScore: 0.9,
    ...overrides,
  };
}

function makeIndexer(entries: DocumentationEntry[] = [], ready = true) {
  return {
    isReady: () => ready,
    search: vi.fn((_q: string, _k: number) => entries),
    getAll: vi.fn(() => entries),
  };
}

// Produces a 384-dim unit vector (all same value so cosine = 1.0 for any pair).
function fakeVec(): Float32Array {
  const v = new Float32Array(384).fill(1 / Math.sqrt(384));
  return v;
}

function makeEmbeddingIndex(ready = true): EmbeddingIndex {
  return {
    isReady: () => ready,
    embed: vi.fn(async () => fakeVec()),
  } as unknown as EmbeddingIndex;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DocRetriever — isReady()', () => {
  it('delegates to the underlying indexer', () => {
    const dr = new DocRetriever(makeIndexer([], false) as never);
    expect(dr.isReady()).toBe(false);
  });
});

describe('DocRetriever — keyword fallback', () => {
  it('returns empty when the indexer is not ready', async () => {
    const indexer = makeIndexer([makeEntry()], false);
    const dr = new DocRetriever(indexer as never);
    const hits = await dr.retrieve('auth', 5);
    expect(hits).toHaveLength(0);
    expect(indexer.search).not.toHaveBeenCalled();
  });

  it('falls back to keyword search when no embeddingIndex is provided', async () => {
    const entry = makeEntry();
    const indexer = makeIndexer([entry]);
    const dr = new DocRetriever(indexer as never);
    const hits = await dr.retrieve('auth', 5);
    expect(indexer.search).toHaveBeenCalledWith('auth', 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('docs');
    expect(hits[0].title).toBe('requireAuth');
  });

  it('falls back to keyword search when the embedding model is not ready', async () => {
    const entry = makeEntry();
    const indexer = makeIndexer([entry]);
    const notReady = makeEmbeddingIndex(false);
    const dr = new DocRetriever(indexer as never, notReady);
    const hits = await dr.retrieve('auth', 5);
    expect(indexer.search).toHaveBeenCalled();
    expect(hits).toHaveLength(1);
  });
});

describe('DocRetriever — vector search', () => {
  it('uses the vector store (not keyword search) when the embedding index is ready', async () => {
    const entry = makeEntry();
    const indexer = makeIndexer([entry]);
    const embIdx = makeEmbeddingIndex(true);
    const dr = new DocRetriever(indexer as never, embIdx);
    const hits = await dr.retrieve('auth', 5);
    expect(indexer.search).not.toHaveBeenCalled();
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('docs');
  });

  it('skips re-embedding entries that are already synced', async () => {
    const entry = makeEntry();
    const indexer = makeIndexer([entry]);
    const embIdx = makeEmbeddingIndex(true);
    const dr = new DocRetriever(indexer as never, embIdx);

    await dr.retrieve('auth', 5);
    await dr.retrieve('auth', 5);

    // embed should be called once for the entry + once per query = 3 total.
    // On the second retrieve the entry is already cached, so no extra entry embed.
    const embedCalls = (embIdx.embed as ReturnType<typeof vi.fn>).mock.calls;
    // Calls: entry sync (1) + query (1) + query (1) = 3
    expect(embedCalls).toHaveLength(3);
  });
});

describe('DocRetriever — hit formatting', () => {
  it('truncates content at 500 characters', async () => {
    const longContent = 'x'.repeat(600);
    const entry = makeEntry({ content: longContent });
    const indexer = makeIndexer([entry]);
    const dr = new DocRetriever(indexer as never);
    const hits = await dr.retrieve('auth', 5);
    // Content is wrapped in a code fence; the raw content portion is sliced to 500 chars.
    expect(hits[0].content).toContain('x'.repeat(500));
    expect(hits[0].content).not.toContain('x'.repeat(501));
  });

  it('includes the file path and line number in the hit content', async () => {
    const entry = makeEntry({ filePath: 'src/auth.ts', lineNumber: 42 });
    const indexer = makeIndexer([entry]);
    const dr = new DocRetriever(indexer as never);
    const hits = await dr.retrieve('auth', 5);
    expect(hits[0].content).toContain('src/auth.ts:42');
  });

  it('sets hit id to docs:<filePath>:<lineNumber>', async () => {
    const entry = makeEntry({ filePath: 'src/auth.ts', lineNumber: 10 });
    const indexer = makeIndexer([entry]);
    const dr = new DocRetriever(indexer as never);
    const hits = await dr.retrieve('auth', 5);
    expect(hits[0].id).toBe('docs:src/auth.ts:10');
  });
});
