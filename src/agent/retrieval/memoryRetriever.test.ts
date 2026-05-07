import { describe, it, expect, vi } from 'vitest';
import { MemoryRetriever } from './memoryRetriever.js';
import type { MemoryEntry } from '../agentMemory.js';
import type { EmbeddingIndex } from '../../config/embeddingIndex.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id: 'm1',
    type: 'pattern',
    category: 'auth',
    content: 'Always validate the JWT before processing.',
    useCount: 1,
    timestamp: Date.now(),
    ...overrides,
  };
}

function makeMemory(entries: MemoryEntry[] = []) {
  return {
    queryAll: vi.fn(() => entries),
    search: vi.fn((_q: string, _cat: string | undefined, _k: number) => entries),
  };
}

function fakeVec(): Float32Array {
  return new Float32Array(384).fill(1 / Math.sqrt(384));
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

describe('MemoryRetriever — isReady()', () => {
  it('always returns true (memory is always available)', () => {
    const mr = new MemoryRetriever(makeMemory() as never);
    expect(mr.isReady()).toBe(true);
  });
});

describe('MemoryRetriever — keyword fallback', () => {
  it('falls back to memory.search when no embeddingIndex is provided', async () => {
    const entry = makeEntry();
    const memory = makeMemory([entry]);
    const mr = new MemoryRetriever(memory as never);
    const hits = await mr.retrieve('auth', 5);
    expect(memory.search).toHaveBeenCalledWith('auth', undefined, 5);
    expect(hits).toHaveLength(1);
    expect(hits[0].source).toBe('memory');
  });

  it('falls back to memory.search when embedding model is not ready', async () => {
    const entry = makeEntry();
    const memory = makeMemory([entry]);
    const mr = new MemoryRetriever(memory as never, makeEmbeddingIndex(false));
    const hits = await mr.retrieve('auth', 5);
    expect(memory.search).toHaveBeenCalled();
    expect(hits).toHaveLength(1);
  });
});

describe('MemoryRetriever — vector search', () => {
  it('uses vector search (not keyword) when the embedding index is ready', async () => {
    const entry = makeEntry();
    const memory = makeMemory([entry]);
    const mr = new MemoryRetriever(memory as never, makeEmbeddingIndex(true));
    const hits = await mr.retrieve('auth', 5);
    expect(memory.search).not.toHaveBeenCalled();
    expect(hits).toHaveLength(1);
  });

  it('skips re-embedding entries that are already synced', async () => {
    const entry = makeEntry();
    const memory = makeMemory([entry]);
    const embIdx = makeEmbeddingIndex(true);
    const mr = new MemoryRetriever(memory as never, embIdx);

    await mr.retrieve('auth', 5);
    await mr.retrieve('auth', 5);

    // entry embed (1) + query (1) + query (1) = 3 total
    const embedCalls = (embIdx.embed as ReturnType<typeof vi.fn>).mock.calls;
    expect(embedCalls).toHaveLength(3);
  });
});

describe('MemoryRetriever — hit formatting', () => {
  it('shows a use badge when useCount > 3', async () => {
    const entry = makeEntry({ useCount: 5, category: 'auth' });
    const memory = makeMemory([entry]);
    const mr = new MemoryRetriever(memory as never);
    const hits = await mr.retrieve('auth', 5);
    expect(hits[0].content).toContain('used 5 times');
  });

  it('omits the use badge when useCount <= 3', async () => {
    const entry = makeEntry({ useCount: 3, category: 'auth' });
    const memory = makeMemory([entry]);
    const mr = new MemoryRetriever(memory as never);
    const hits = await mr.retrieve('auth', 5);
    expect(hits[0].content).not.toContain('used');
  });

  it('capitalizes the type label', async () => {
    const entry = makeEntry({ type: 'pattern', category: 'auth' });
    const memory = makeMemory([entry]);
    const mr = new MemoryRetriever(memory as never);
    const hits = await mr.retrieve('auth', 5);
    expect(hits[0].content).toContain('Pattern');
  });

  it('truncates content at 400 characters', async () => {
    const longContent = 'y'.repeat(500);
    const entry = makeEntry({ content: longContent });
    const memory = makeMemory([entry]);
    const mr = new MemoryRetriever(memory as never);
    const hits = await mr.retrieve('auth', 5);
    expect(hits[0].content).toContain('y'.repeat(400));
    expect(hits[0].content).not.toContain('y'.repeat(401));
  });

  it('sets hit id to memory:<entry.id>', async () => {
    const entry = makeEntry({ id: 'abc-123' });
    const memory = makeMemory([entry]);
    const mr = new MemoryRetriever(memory as never);
    const hits = await mr.retrieve('auth', 5);
    expect(hits[0].id).toBe('memory:abc-123');
  });
});
