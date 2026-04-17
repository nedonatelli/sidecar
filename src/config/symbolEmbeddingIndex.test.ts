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

  describe('Merkle tree integration (v0.62 d.2)', () => {
    it('setMerkleTree replays stored entries into the tree', async () => {
      const { MerkleTree } = await import('./merkleTree.js');
      // Index two symbols first, then attach a tree — replay should
      // populate the tree from persisted-in-memory state without
      // re-running embeddings.
      await index.indexSymbol(makeInput({ qualifiedName: 'a', name: 'a' }));
      await index.indexSymbol(makeInput({ qualifiedName: 'b', name: 'b' }));

      const tree = new MerkleTree();
      index.setMerkleTree(tree);

      expect(tree.getLeafCount()).toBe(2);
      expect(tree.getRootHash()).not.toBe('');
    });

    it('addLeaf mirrors every indexSymbol call when a tree is wired', async () => {
      const { MerkleTree } = await import('./merkleTree.js');
      const tree = new MerkleTree();
      index.setMerkleTree(tree);

      await index.indexSymbol(makeInput({ qualifiedName: 'new', name: 'new' }));
      tree.rebuild();

      expect(tree.getLeafCount()).toBe(1);
    });

    it('flushQueue fires tree.rebuild() after a batch drain', async () => {
      const { MerkleTree } = await import('./merkleTree.js');
      const tree = new MerkleTree();
      index.setMerkleTree(tree);

      index.queueSymbol(makeInput({ qualifiedName: 'a', name: 'a' }));
      index.queueSymbol(makeInput({ qualifiedName: 'b', name: 'b' }));
      await index.flushQueueForTests();

      // rebuild() gets called during the drain, so getRootHash
      // reflects both queued leaves without a manual rebuild here.
      expect(tree.getLeafCount()).toBe(2);
      expect(tree.getRootHash()).not.toBe('');
    });

    it('removeSymbol and removeFile mirror into the tree', async () => {
      const { MerkleTree } = await import('./merkleTree.js');
      const tree = new MerkleTree();
      index.setMerkleTree(tree);

      await index.indexSymbol(makeInput({ qualifiedName: 'a', name: 'a', filePath: 'foo.ts' }));
      await index.indexSymbol(makeInput({ qualifiedName: 'b', name: 'b', filePath: 'foo.ts' }));
      await index.indexSymbol(makeInput({ qualifiedName: 'c', name: 'c', filePath: 'bar.ts' }));
      tree.rebuild();
      expect(tree.getLeafCount()).toBe(3);

      index.removeSymbol(makeSymbolId('foo.ts', 'a'));
      tree.rebuild();
      expect(tree.getLeafCount()).toBe(2);

      index.removeFile('foo.ts');
      tree.rebuild();
      expect(tree.getLeafCount()).toBe(1);
      expect(tree.getFileNode('bar.ts')).not.toBeNull();
    });

    it('getMerkleRoot returns empty string when no tree is wired', () => {
      expect(index.getMerkleRoot()).toBe('');
    });

    it('search uses Merkle descent when a tree is wired and populated', async () => {
      const { MerkleTree } = await import('./merkleTree.js');
      const tree = new MerkleTree();
      index.setMerkleTree(tree);

      // Index symbols across 4 distinct files so descent has real
      // candidates to prune.
      await index.indexSymbol(
        makeInput({ filePath: 'src/auth.ts', qualifiedName: 'requireAuth', name: 'requireAuth', body: 'auth logic' }),
      );
      await index.indexSymbol(
        makeInput({ filePath: 'src/auth.ts', qualifiedName: 'verifyToken', name: 'verifyToken', body: 'token verify' }),
      );
      await index.indexSymbol(
        makeInput({ filePath: 'src/db.ts', qualifiedName: 'findUser', name: 'findUser', body: 'database find' }),
      );
      await index.indexSymbol(
        makeInput({ filePath: 'src/util.ts', qualifiedName: 'logInfo', name: 'logInfo', body: 'log console' }),
      );
      tree.rebuild();

      // Query should still find auth-related symbols even with
      // descent active. Invariant: descent pruning doesn't drop
      // relevant results on queries that should match them.
      const results = await index.search('auth token', 5);
      expect(results.length).toBeGreaterThan(0);
      const names = results.map((r) => r.name);
      expect(names).toEqual(expect.arrayContaining(['requireAuth']));
    });

    it('search works correctly with an empty Merkle tree (no descent filter applied)', async () => {
      const { MerkleTree } = await import('./merkleTree.js');
      const tree = new MerkleTree(); // empty
      // Index BEFORE attaching the tree so the tree stays empty
      // even after attach. (setMerkleTree's replay populates it
      // from persisted state, so we put nothing in the store
      // until after attach to simulate an empty-tree edge case.)
      index.setMerkleTree(tree);

      // Now index — this should add to the tree too.
      await index.indexSymbol(makeInput({ qualifiedName: 'foo', name: 'foo' }));
      // Don't call tree.rebuild() — leave the tree unpopulated in
      // its file-node layer. search() should detect the empty tree
      // and fall through to the full scan.
      const freshTree = new MerkleTree(); // truly empty
      index.setMerkleTree(freshTree);

      const results = await index.search('query', 5);
      // With a truly-empty tree, descent is skipped. Our single
      // indexed symbol should still surface.
      expect(results.length).toBe(1);
    });

    it('skips replay for entries lacking merkleHash (pre-d.2 caches)', async () => {
      // Hand-craft a metadata entry without merkleHash via direct
      // store access. `index.setMerkleTree` should skip it on
      // replay rather than crash.
      const { MerkleTree } = await import('./merkleTree.js');
      const { FlatVectorStore } = await import('./vectorStore.js');
      // Typed as the real SymbolMetadata shape so we can upsert an
      // entry with `merkleHash` omitted — TypeScript's optional
      // field semantics let the test insert "pre-d.2" state
      // directly, which is exactly the case we're exercising.
      const legacyStore = new FlatVectorStore<import('./symbolEmbeddingIndex.js').SymbolMetadata>(null, {
        dimension: 384,
        version: 1,
        binFile: 'cache/x.bin',
        metaFile: 'cache/x.json',
      });
      const legacyIndex = new SymbolEmbeddingIndex(null, legacyStore);
      legacyIndex.setPipelineForTests(fakePipeline() as never);
      // Pre-d.2 entry: no merkleHash. 384-dim zero vector is enough
      // to satisfy the FlatVectorStore dimension check; content
      // doesn't matter for the replay-skip path.
      const vector = new Float32Array(384);
      vector[0] = 1;
      await legacyStore.upsert({
        id: 'src/a.ts::foo',
        vector,
        metadata: {
          filePath: 'src/a.ts',
          qualifiedName: 'foo',
          name: 'foo',
          kind: 'function',
          startLine: 1,
          endLine: 5,
          hash: 'h',
          // merkleHash intentionally omitted
        },
      });

      const tree = new MerkleTree();
      legacyIndex.setMerkleTree(tree);

      // Replay skipped — no leaves added.
      expect(tree.getLeafCount()).toBe(0);
    });
  });

  describe('queueSymbol + flush (v0.61 b.2)', () => {
    it('drains queued symbols through indexSymbol on flush', async () => {
      index.queueSymbol(makeInput({ qualifiedName: 'a', name: 'a' }));
      index.queueSymbol(makeInput({ qualifiedName: 'b', name: 'b' }));
      index.queueSymbol(makeInput({ qualifiedName: 'c', name: 'c' }));
      expect(index.getCount()).toBe(0); // nothing indexed yet — queued only

      await index.flushQueueForTests();

      expect(index.getCount()).toBe(3);
    });

    it('coalesces re-queues of the same symbol — last body wins', async () => {
      const pipeline = vi.fn(fakePipeline() as never);
      index.setPipelineForTests(pipeline);

      // Three rapid queues for the same symbol with distinct bodies.
      // The last one's hash is what should end up in the index.
      index.queueSymbol(makeInput({ body: 'body v1' }));
      index.queueSymbol(makeInput({ body: 'body v2' }));
      index.queueSymbol(makeInput({ body: 'body v3' }));

      await index.flushQueueForTests();

      // Only ONE embed because earlier queue entries were overwritten
      // before the flush drained them — coalesce-in-place semantics.
      expect(pipeline).toHaveBeenCalledTimes(1);
      expect(index.getCount()).toBe(1);
    });

    it('removeFile also drops entries still sitting in the queue', async () => {
      index.queueSymbol(makeInput({ filePath: 'src/doomed.ts', qualifiedName: 'a' }));
      index.queueSymbol(makeInput({ filePath: 'src/doomed.ts', qualifiedName: 'b' }));
      index.queueSymbol(makeInput({ filePath: 'src/kept.ts', qualifiedName: 'c' }));

      index.removeFile('src/doomed.ts');
      await index.flushQueueForTests();

      expect(index.getCount()).toBe(1);
      expect(index.getSymbolMeta(makeSymbolId('src/kept.ts', 'c'))).not.toBeNull();
    });

    it('survives a per-symbol embed error without dropping the rest of the batch', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        // Pipeline throws only for the middle input; first + third embed cleanly.
        const pipeline = vi.fn(async (texts: string[]) => {
          if (texts[0].includes('bad')) throw new Error('embed failed');
          const out = await (fakePipeline() as (t: string[]) => Promise<{ data: Float32Array }>)(texts);
          return out;
        }) as never;
        index.setPipelineForTests(pipeline);

        index.queueSymbol(makeInput({ qualifiedName: 'ok1', body: 'good body' }));
        index.queueSymbol(makeInput({ qualifiedName: 'bad', body: 'bad body' }));
        index.queueSymbol(makeInput({ qualifiedName: 'ok2', body: 'also good' }));

        await index.flushQueueForTests();

        expect(index.getCount()).toBe(2); // two succeeded, one failed
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Symbol embed failed'), expect.any(Error));
      } finally {
        warnSpy.mockRestore();
      }
    });

    it('drains in parallel (v0.62.1 p.4) — batch runs concurrent embeds', async () => {
      // Slow pipeline that measures max concurrency by tracking how
      // many embeds are "in flight" at the peak. Pre-p.4 this was 1
      // (serial). Post-p.4 it should be ~FLUSH_CONCURRENCY (4).
      let inFlight = 0;
      let peak = 0;
      const slowPipeline = vi.fn(async (texts: string[]) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Small delay gives other tasks a chance to enter the "in
        // flight" window before we decrement. Without this, embeds
        // resolve synchronously and peak=1.
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        // Use the real fake pipeline for the actual vector.
        return (await fakePipeline()(texts)) as never;
      }) as never;
      index.setPipelineForTests(slowPipeline);

      // 10 symbols → 2–3 batches of 4-way concurrent work.
      for (let i = 0; i < 10; i++) {
        index.queueSymbol(makeInput({ qualifiedName: `sym${i}`, name: `sym${i}`, body: `body${i}` }));
      }
      await index.flushQueueForTests();

      expect(index.getCount()).toBe(10);
      // Parallelism actually fired. With FLUSH_CONCURRENCY=4 and
      // 10 queued symbols, we expect peak >= 2 consistently; on a
      // healthy runtime it reaches 4. Accept >=2 so the test isn't
      // flaky on slow CI.
      expect(peak).toBeGreaterThanOrEqual(2);
    });

    it('concurrent upserts do not clobber each other (no race on offset slots)', async () => {
      // Sanity check: with parallel embeds, the store's offset
      // allocation stays consistent. Indexing 50 symbols in
      // parallel should land all 50 in the store with distinct
      // offsets.
      for (let i = 0; i < 50; i++) {
        index.queueSymbol(makeInput({ qualifiedName: `par${i}`, name: `par${i}`, body: `unique-body-${i}` }));
      }
      await index.flushQueueForTests();

      expect(index.getCount()).toBe(50);
      // Every symbol queryable — proves no offset collision.
      for (let i = 0; i < 50; i++) {
        const meta = index.getSymbolMeta(makeSymbolId('src/auth/middleware.ts', `par${i}`));
        expect(meta).not.toBeNull();
      }
    });
  });
});
