import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChunkRetriever } from './chunkRetriever.js';

vi.mock('vscode', async () => {
  const mock = await import('../../__mocks__/vscode.js');
  return mock;
});

import { workspace } from 'vscode';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeEmbeddingIndex(opts: { ready?: boolean; vec?: Float32Array } = {}) {
  const vec = opts.vec ?? new Float32Array(384).fill(0.1);
  return {
    isReady: vi.fn().mockReturnValue(opts.ready ?? true),
    embed: vi.fn().mockResolvedValue(vec),
  };
}

function fakeUri(fsPath: string) {
  return { fsPath, toString: () => fsPath } as import('vscode').Uri;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ChunkRetriever', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('name is "chunks"', () => {
    expect(new ChunkRetriever(null).name).toBe('chunks');
  });

  it('isReady returns false when embeddingIndex is null', () => {
    expect(new ChunkRetriever(null).isReady()).toBe(false);
  });

  it('isReady returns false when embeddingIndex is not ready', () => {
    const ei = makeEmbeddingIndex({ ready: false });
    expect(new ChunkRetriever(ei as never).isReady()).toBe(false);
  });

  it('isReady returns true when embeddingIndex is ready', () => {
    const ei = makeEmbeddingIndex({ ready: true });
    expect(new ChunkRetriever(ei as never).isReady()).toBe(true);
  });

  it('returns empty array when not ready', async () => {
    const r = new ChunkRetriever(null);
    await expect(r.retrieve('hello', 5)).resolves.toEqual([]);
  });

  it('returns empty array when no files are found', async () => {
    const ei = makeEmbeddingIndex();
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([]);
    const hits = await new ChunkRetriever(ei as never).retrieve('hello', 5);
    expect(hits).toEqual([]);
  });

  it('calls embed for discovered file content', async () => {
    const ei = makeEmbeddingIndex();
    const content = '## Getting Started\n\nRun npm install to set up the project.';

    vi.spyOn(workspace, 'findFiles').mockResolvedValue([fakeUri('/ws/README.md')]);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(content) as never);

    const retriever = new ChunkRetriever(ei as never);
    await retriever.retrieve('npm install', 5);

    // embed called at least once for the chunk content
    expect(ei.embed).toHaveBeenCalled();
  });

  it('hit ids are prefixed with "chunks:"', async () => {
    const ei = makeEmbeddingIndex();
    // Use vectors with high cosine similarity between query and chunk.
    const sharedVec = new Float32Array(384).fill(0.5);
    ei.embed.mockResolvedValue(sharedVec);

    vi.spyOn(workspace, 'findFiles').mockResolvedValue([fakeUri('/ws/NOTES.txt')]);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(
      Buffer.from('Useful prose documentation for testing retrieval.') as never,
    );

    const retriever = new ChunkRetriever(ei as never);
    // First call indexes the file.
    await retriever.retrieve('useful prose', 5);
    // Second call searches with the same vector (high similarity).
    const hits = await retriever.retrieve('useful prose', 5);
    for (const h of hits) {
      expect(h.id).toMatch(/^chunks:/);
    }
    // At least one hit should have been returned.
    expect(hits.length).toBeGreaterThan(0);
  });

  it('does not re-embed unchanged files on second retrieve', async () => {
    const ei = makeEmbeddingIndex();
    const content = 'Stable content that does not change between calls.';

    vi.spyOn(workspace, 'findFiles').mockResolvedValue([fakeUri('/ws/stable.md')]);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from(content) as never);

    const retriever = new ChunkRetriever(ei as never);
    await retriever.retrieve('stable', 5);
    const callsAfterFirst = ei.embed.mock.calls.length;

    // Second call — content unchanged — only the query embed fires.
    await retriever.retrieve('stable', 5);
    const additionalCalls = ei.embed.mock.calls.length - callsAfterFirst;
    expect(additionalCalls).toBe(1); // only query embed
  });

  it('re-embeds a file when content changes', async () => {
    const ei = makeEmbeddingIndex();

    vi.spyOn(workspace, 'findFiles').mockResolvedValue([fakeUri('/ws/changing.md')]);
    vi.spyOn(workspace.fs, 'readFile')
      .mockResolvedValueOnce(Buffer.from('Original content here.') as never)
      .mockResolvedValue(Buffer.from('Updated content — now different, new hash.') as never);

    const retriever = new ChunkRetriever(ei as never);
    await retriever.retrieve('content', 5);
    const callsAfterFirst = ei.embed.mock.calls.length;

    // Second retrieve: different content → re-embed (query + at least 1 chunk embed).
    await retriever.retrieve('content', 5);
    const additionalCalls = ei.embed.mock.calls.length - callsAfterFirst;
    expect(additionalCalls).toBeGreaterThan(1);
  });

  it('skips unreadable files gracefully', async () => {
    const ei = makeEmbeddingIndex();
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([fakeUri('/ws/bad.md')]);
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(new Error('EACCES'));

    const retriever = new ChunkRetriever(ei as never);
    await expect(retriever.retrieve('anything', 5)).resolves.toEqual([]);
  });

  it('deduplicates the same URI returned by multiple patterns', async () => {
    const ei = makeEmbeddingIndex();
    // findFiles always returns the same URI regardless of pattern.
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([fakeUri('/ws/README.md')]);
    const readFileSpy = vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from('Content.') as never);

    const retriever = new ChunkRetriever(ei as never);
    await retriever.retrieve('content', 5);

    // readFile should fire exactly once despite 4 patterns returning the same URI.
    expect(readFileSpy).toHaveBeenCalledTimes(1);
  });

  it('returns empty array when embed returns null for query', async () => {
    const ei = makeEmbeddingIndex();
    const sharedVec = new Float32Array(384).fill(0.5);
    // Chunk embeds succeed, query embed returns null.
    ei.embed.mockResolvedValueOnce(sharedVec); // chunk embed
    ei.embed.mockResolvedValueOnce(null); // query embed

    vi.spyOn(workspace, 'findFiles').mockResolvedValue([fakeUri('/ws/guide.md')]);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(
      Buffer.from('Guide text content here for retrieval testing.') as never,
    );

    const retriever = new ChunkRetriever(ei as never);
    await retriever.retrieve('guide', 5); // indexes file
    // Second call: query embed returns null.
    ei.embed.mockResolvedValue(null);
    const hits = await retriever.retrieve('guide', 5);
    expect(hits).toEqual([]);
  });
});
