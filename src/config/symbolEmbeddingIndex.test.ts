import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SymbolEmbeddingIndex, makeSymbolId, cosine, type SymbolEmbedInput } from './symbolEmbeddingIndex.js';

/**
 * Tests exercise the storage + similarity primitive against a
 * deterministic fake pipeline. The real `@xenova/transformers`
 * pipeline is a 23 MB ONNX model and hundreds of ms of cold load;
 * we want fast unit tests, so every test uses the `setPipelineForTests`
 * hook to inject a synthetic embedder that returns stable vectors.
 *
 * The fake below produces one-hot vectors keyed off the first word of
 * the input — enough to assert "these two inputs collide" and "this
 * input wins search for a related query" without actually running
 * semantic similarity.
 */

const DIMENSION = 384;

/**
 * Build a stable, deterministic pipeline that lights up a slot for
 * each known keyword present anywhere in the input text, then
 * normalizes the result. Matches on substrings so `auth`, `authFn`,
 * and `authentication` all trigger the same slot — good enough to
 * test the "similar inputs land close together" semantics without
 * needing real semantic similarity.
 */
function fakePipeline(): (texts: string[]) => Promise<{ data: Float32Array }> {
  const wordToSlot = new Map<string, number>();
  const getSlot = (word: string): number => {
    if (!wordToSlot.has(word)) {
      wordToSlot.set(word, wordToSlot.size);
    }
    return wordToSlot.get(word)!;
  };
  return async (texts: string[]) => {
    const vec = new Float32Array(DIMENSION);
    const input = texts[0].toLowerCase();
    // Extract all alphanumeric tokens ≥ 2 chars; first 3-letter prefix
    // of each gets its own slot. So "auth" and "authfn" share a slot,
    // matching the real-world "these two words are related" intuition.
    const tokens = input.match(/[a-z]{2,}/g) ?? [];
    for (const token of tokens) {
      const prefix = token.slice(0, 3);
      vec[getSlot(prefix) % DIMENSION] = 1;
    }
    // Normalize to a unit vector so cosine is well-defined.
    let norm = 0;
    for (const v of vec) norm += v * v;
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < vec.length; i++) vec[i] /= norm;
    return { data: vec };
  };
}

function makeInput(overrides: Partial<SymbolEmbedInput> = {}): SymbolEmbedInput {
  return {
    filePath: 'src/auth/middleware.ts',
    qualifiedName: 'requireAuth',
    name: 'requireAuth',
    kind: 'function',
    startLine: 10,
    endLine: 25,
    body: 'function requireAuth(req, res, next) { verifyToken(req); }',
    ...overrides,
  };
}

describe('SymbolEmbeddingIndex', () => {
  let index: SymbolEmbeddingIndex;

  beforeEach(() => {
    index = new SymbolEmbeddingIndex(null);
    index.setPipelineForTests(fakePipeline() as never);
  });

  describe('indexSymbol', () => {
    it('embeds and stores a new symbol', async () => {
      await index.indexSymbol(makeInput());
      expect(index.getCount()).toBe(1);
      expect(index.getSymbolMeta(makeSymbolId('src/auth/middleware.ts', 'requireAuth'))).toMatchObject({
        filePath: 'src/auth/middleware.ts',
        qualifiedName: 'requireAuth',
        kind: 'function',
      });
    });

    it('skips re-embedding when the body hash is unchanged', async () => {
      const pipeline = vi.fn(fakePipeline() as never);
      index.setPipelineForTests(pipeline);

      await index.indexSymbol(makeInput());
      await index.indexSymbol(makeInput()); // same body
      await index.indexSymbol(makeInput()); // and again

      // Only the first call hits the pipeline — subsequent re-index
      // calls short-circuit on hash match.
      expect(pipeline).toHaveBeenCalledTimes(1);
      expect(index.getCount()).toBe(1);
    });

    it('re-embeds when the body changes', async () => {
      const pipeline = vi.fn(fakePipeline() as never);
      index.setPipelineForTests(pipeline);

      await index.indexSymbol(makeInput({ body: 'original body' }));
      await index.indexSymbol(makeInput({ body: 'modified body' }));

      expect(pipeline).toHaveBeenCalledTimes(2);
      expect(index.getCount()).toBe(1); // still one entry, overwritten in place
    });

    it('handles multiple distinct symbols', async () => {
      await index.indexSymbol(makeInput({ qualifiedName: 'a', body: 'alpha body' }));
      await index.indexSymbol(makeInput({ qualifiedName: 'b', body: 'beta body' }));
      await index.indexSymbol(makeInput({ qualifiedName: 'c', body: 'gamma body' }));

      expect(index.getCount()).toBe(3);
    });

    it('is a no-op when the model pipeline is unavailable', async () => {
      index.setPipelineForTests(null);
      await index.indexSymbol(makeInput());
      expect(index.getCount()).toBe(0);
    });
  });

  describe('removeSymbol / removeFile', () => {
    it('removeSymbol drops the entry by ID', async () => {
      await index.indexSymbol(makeInput({ qualifiedName: 'a' }));
      await index.indexSymbol(makeInput({ qualifiedName: 'b' }));

      index.removeSymbol(makeSymbolId('src/auth/middleware.ts', 'a'));

      expect(index.getCount()).toBe(1);
      expect(index.getSymbolMeta(makeSymbolId('src/auth/middleware.ts', 'a'))).toBeNull();
      expect(index.getSymbolMeta(makeSymbolId('src/auth/middleware.ts', 'b'))).not.toBeNull();
    });

    it('removeSymbol is a no-op when the ID is unknown', async () => {
      await index.indexSymbol(makeInput());
      index.removeSymbol('nonexistent::whatever');
      expect(index.getCount()).toBe(1);
    });

    it('removeFile drops every symbol in the file and returns the count', async () => {
      await index.indexSymbol(makeInput({ filePath: 'src/foo.ts', qualifiedName: 'a' }));
      await index.indexSymbol(makeInput({ filePath: 'src/foo.ts', qualifiedName: 'b' }));
      await index.indexSymbol(makeInput({ filePath: 'src/bar.ts', qualifiedName: 'c' }));

      const removed = index.removeFile('src/foo.ts');

      expect(removed).toBe(2);
      expect(index.getCount()).toBe(1);
      expect(index.getSymbolMeta(makeSymbolId('src/bar.ts', 'c'))).not.toBeNull();
    });

    it('removeFile returns 0 when no symbols match', async () => {
      await index.indexSymbol(makeInput());
      const removed = index.removeFile('src/unrelated.ts');
      expect(removed).toBe(0);
      expect(index.getCount()).toBe(1);
    });
  });

  describe('search', () => {
    it('returns results sorted by similarity', async () => {
      // Each body starts with a distinct word so our fake pipeline
      // embeds them into orthogonal slots. The query "auth" collides
      // with the "auth" body — that one should win.
      await index.indexSymbol(makeInput({ qualifiedName: 'authFn', name: 'authFn', body: 'auth logic here' }));
      await index.indexSymbol(makeInput({ qualifiedName: 'dbFn', name: 'dbFn', body: 'database code' }));
      await index.indexSymbol(makeInput({ qualifiedName: 'uiFn', name: 'uiFn', body: 'ui handler' }));

      const results = await index.search('auth query', 5);

      expect(results).toHaveLength(3);
      expect(results[0].name).toBe('authFn');
      expect(results[0].similarity).toBeGreaterThan(results[1].similarity);
    });

    it('respects topK', async () => {
      for (let i = 0; i < 10; i++) {
        await index.indexSymbol(makeInput({ qualifiedName: `sym${i}`, body: `body${i}` }));
      }
      const results = await index.search('query', 3);
      expect(results).toHaveLength(3);
    });

    it('returns empty when no symbols are indexed', async () => {
      const results = await index.search('anything');
      expect(results).toEqual([]);
    });

    it('returns empty when the model is unavailable', async () => {
      await index.indexSymbol(makeInput());
      index.setPipelineForTests(null);
      const results = await index.search('anything');
      expect(results).toEqual([]);
    });

    it('filters by kindFilter', async () => {
      await index.indexSymbol(makeInput({ qualifiedName: 'fn1', kind: 'function', body: 'a' }));
      await index.indexSymbol(makeInput({ qualifiedName: 'cls1', kind: 'class', body: 'b' }));
      await index.indexSymbol(makeInput({ qualifiedName: 'if1', kind: 'interface', body: 'c' }));

      const results = await index.search('query', 10, { kindFilter: ['function', 'class'] });

      expect(results).toHaveLength(2);
      expect(results.map((r) => r.kind).sort()).toEqual(['class', 'function']);
    });

    it('filters by pathPrefix', async () => {
      await index.indexSymbol(makeInput({ filePath: 'src/middleware/auth.ts', qualifiedName: 'a' }));
      await index.indexSymbol(makeInput({ filePath: 'src/middleware/cors.ts', qualifiedName: 'b' }));
      await index.indexSymbol(makeInput({ filePath: 'src/routes/users.ts', qualifiedName: 'c' }));

      const results = await index.search('query', 10, { pathPrefix: 'src/middleware/' });

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.filePath.startsWith('src/middleware/'))).toBe(true);
    });
  });

  describe('cosine', () => {
    it('returns 1 for identical unit vectors', () => {
      const a = new Float32Array(DIMENSION);
      a[0] = 1;
      expect(cosine(a, a)).toBeCloseTo(1);
    });

    it('returns 0 for orthogonal unit vectors', () => {
      const a = new Float32Array(DIMENSION);
      const b = new Float32Array(DIMENSION);
      a[0] = 1;
      b[1] = 1;
      expect(cosine(a, b)).toBe(0);
    });

    it('handles mismatched lengths by using the shorter', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([1, 0]);
      expect(cosine(a, b)).toBe(1);
    });
  });

  describe('makeSymbolId', () => {
    it('is deterministic and round-trips the inputs unambiguously', () => {
      expect(makeSymbolId('src/a.ts', 'foo')).toBe('src/a.ts::foo');
      expect(makeSymbolId('src/b.ts', 'foo')).not.toBe(makeSymbolId('src/a.ts', 'foo'));
    });
  });
});
