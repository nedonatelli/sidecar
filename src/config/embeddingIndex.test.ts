import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { cosine, EmbeddingIndex } from './embeddingIndex.js';

describe('cosine', () => {
  it('returns 1 for identical unit vectors', () => {
    const v = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    // Normalize
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    const unit = new Float32Array(v.map((x) => x / norm));
    expect(cosine(unit, unit)).toBeCloseTo(1, 5);
  });

  it('returns 0 for orthogonal vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosine(a, b)).toBeCloseTo(0, 5);
  });

  it('returns -1 for opposite vectors', () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosine(a, b)).toBeCloseTo(-1, 5);
  });

  it('computes correct similarity for arbitrary vectors', () => {
    // Dot product of [0.6, 0.8] and [1, 0] = 0.6
    // Both are unit vectors (0.6^2 + 0.8^2 = 1)
    const a = new Float32Array([0.6, 0.8]);
    const b = new Float32Array([1, 0]);
    expect(cosine(a, b)).toBeCloseTo(0.6, 5);
  });

  it('handles zero-length overlap gracefully', () => {
    const a = new Float32Array(0);
    const b = new Float32Array(0);
    expect(cosine(a, b)).toBe(0);
  });
});

describe('EmbeddingIndex', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-embed-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates an instance with no sidecarDir', () => {
    const index = new EmbeddingIndex(null);
    expect(index.isReady()).toBe(false);
    expect(index.getCount()).toBe(0);
  });

  it('isReady returns false before model loads', () => {
    const index = new EmbeddingIndex(null);
    expect(index.isReady()).toBe(false);
  });

  it('search returns empty when not ready', async () => {
    const index = new EmbeddingIndex(null);
    const results = await index.search('test query');
    expect(results).toEqual([]);
  });

  it('removeFile is a no-op for unknown paths', () => {
    const index = new EmbeddingIndex(null);
    // Should not throw
    index.removeFile('nonexistent.ts');
    expect(index.getCount()).toBe(0);
  });

  it('dispose cleans up timers without throwing', () => {
    const index = new EmbeddingIndex(null);
    // Should not throw even when nothing is initialized
    index.dispose();
  });

  it('queuePath reads file and queues update', () => {
    const filePath = path.join(tempDir, 'test.ts');
    fs.writeFileSync(filePath, 'export function hello() { return "world"; }');

    const index = new EmbeddingIndex(null);
    // Should not throw — queues the file for embedding
    index.queuePath('test.ts', tempDir);
    index.dispose(); // cleanup timer
  });

  it('queuePath silently ignores missing files', () => {
    const index = new EmbeddingIndex(null);
    // Should not throw for nonexistent file
    expect(() => index.queuePath('nonexistent.ts', tempDir)).not.toThrow();
    index.dispose();
  });

  it('drops queuePath calls when MAX_CONCURRENT_READS cap is reached', () => {
    const index = new EmbeddingIndex(null);
    type EmbeddingIndexInternals = { activeReads: number };
    type EmbeddingIndexStatics = { MAX_CONCURRENT_READS: number };
    const cap = (EmbeddingIndex as unknown as EmbeddingIndexStatics).MAX_CONCURRENT_READS;
    // Artificially fill the active-reads counter to the cap.
    (index as unknown as EmbeddingIndexInternals).activeReads = cap;

    index.queuePath('src/app.ts', tempDir);

    // activeReads must remain at the cap — the call was dropped, not started.
    expect((index as unknown as EmbeddingIndexInternals).activeReads).toBe(cap);
    index.dispose();
  });

  it('removeFile decrements count for known paths', () => {
    // Access internal state to simulate a stored entry
    const index = new EmbeddingIndex(null);
    const meta = (index as unknown as { meta: { entries: Record<string, unknown>; count: number } }).meta;
    meta.entries['src/app.ts'] = { offset: 0, hash: 'abc123' };
    meta.count = 1;

    expect(index.getCount()).toBe(1);
    index.removeFile('src/app.ts');
    expect(index.getCount()).toBe(0);
  });
});

describe('search() query embeds carry priority (157s-stall regression)', () => {
  it('passes priority:true through embed() to the LazyEmbedder', async () => {
    // Two identical live stalls proved the file-level query embed queued
    // FIFO behind the batch backlogs on the shared pipeline. Pin the flag
    // so it cannot silently regress.
    const { EmbeddingIndex } = await import('./embeddingIndex.js');
    const idx = new EmbeddingIndex(null as never);
    const calls: Array<{ text: string; opts?: { priority?: boolean } }> = [];
    (idx as unknown as { embedder: { embed: unknown; ensureReady: () => Promise<boolean>; ready: boolean } }).embedder =
      {
        ready: true,
        ensureReady: async () => true,
        embed: async (text: string, opts?: { priority?: boolean }) => {
          calls.push({ text, opts });
          return new Float32Array(384);
        },
      };
    // Seed one entry so search doesn't early-return on an empty index.
    (idx as unknown as { meta: { count: number; entries: Record<string, { offset: number; hash: string }> } }).meta = {
      count: 1,
      entries: { 'a.ts': { offset: 0, hash: 'h' } },
    };
    (idx as unknown as { vectors: Float32Array }).vectors = new Float32Array(384);
    (idx as unknown as { ready: boolean }).ready = true;

    await idx.search('where is auth handled?');

    expect(calls).toHaveLength(1);
    expect(calls[0].opts).toEqual({ priority: true });
  });
});

describe('removeFile must not corrupt the vector store (live RangeError)', () => {
  // Observed in a real extension host:
  //   RangeError: offset is out of bounds
  //     at Float32Array.set (<anonymous>)
  //     at storeVector → flushUpdates
  //
  // removeFile deleted the entry and recomputed `count` from the entry list,
  // but never compacted `vectors` and never re-assigned the offsets of the
  // entries after the hole. That breaks the invariant the whole file assumes:
  // offsets are 0..count-1 and `vectors` holds exactly `count` rows.

  type Internals = {
    meta: { entries: Record<string, { offset: number; hash: string }>; count: number };
    vectors: Float32Array;
    storeVector(relativePath: string, vector: Float32Array, hash: string): void;
  };
  const DIM = 384;
  /** A vector whose every element is `fill` — makes each row identifiable. */
  const rowOf = (fill: number) => new Float32Array(DIM).fill(fill);
  const internals = (i: EmbeddingIndex) => i as unknown as Internals;

  it('keeps offsets dense and vectors sized after a removal', () => {
    const index = new EmbeddingIndex(null);
    const inner = internals(index);
    inner.storeVector('a.ts', rowOf(1), 'h1');
    inner.storeVector('b.ts', rowOf(2), 'h2');
    inner.storeVector('c.ts', rowOf(3), 'h3');
    expect(inner.vectors.length).toBe(3 * DIM);

    index.removeFile('b.ts');

    // The invariant every other method relies on.
    const offsets = Object.values(inner.meta.entries)
      .map((e) => e.offset)
      .sort((x, y) => x - y);
    expect(offsets).toEqual([0, 1]);
    expect(inner.meta.count).toBe(2);
    expect(inner.vectors.length).toBe(2 * DIM);
    index.dispose();
  });

  it('does not alias a new file onto a surviving file’s row', () => {
    // With one removal the sizes happen to line up, so nothing throws — the
    // new entry silently lands on top of a live one and search returns the
    // wrong file's vector. Corruption without a crash is the worse half.
    const index = new EmbeddingIndex(null);
    const inner = internals(index);
    inner.storeVector('a.ts', rowOf(1), 'h1');
    inner.storeVector('b.ts', rowOf(2), 'h2');
    inner.storeVector('c.ts', rowOf(3), 'h3');

    index.removeFile('a.ts');
    inner.storeVector('d.ts', rowOf(9), 'h9');

    const used = Object.values(inner.meta.entries).map((e) => e.offset);
    expect(new Set(used).size).toBe(used.length); // no two entries share a row

    // And every surviving file still reads back ITS OWN vector.
    for (const [name, fill] of [
      ['b.ts', 2],
      ['c.ts', 3],
      ['d.ts', 9],
    ] as const) {
      const off = inner.meta.entries[name].offset * DIM;
      expect({ name, v: inner.vectors[off] }).toEqual({ name, v: fill });
    }
    index.dispose();
  });

  it('survives two removals followed by an append (the exact crash)', () => {
    const index = new EmbeddingIndex(null);
    const inner = internals(index);
    inner.storeVector('a.ts', rowOf(1), 'h1');
    inner.storeVector('b.ts', rowOf(2), 'h2');
    inner.storeVector('c.ts', rowOf(3), 'h3');

    index.removeFile('a.ts');
    index.removeFile('b.ts');

    // Before the fix: newVectors is 2 rows, this.vectors is 3 → RangeError.
    expect(() => inner.storeVector('d.ts', rowOf(9), 'h9')).not.toThrow();
    index.dispose();
  });
});

describe('a corrupt cache is rebuilt, not trusted', () => {
  // The corruption outlived a restart: persist() writes meta (including the
  // bogus offsets) and only `count` rows of vectors, so the next session loaded
  // an index whose entries pointed past the end of the array — a RangeError on
  // the first overwrite, or silently aliased vectors before that.
  type Restorable = {
    restoreCache(): Promise<void>;
    meta: {
      entries: Record<string, { offset: number; hash: string }>;
      count: number;
      version: number;
      modelId: string;
      dimension: number;
    };
    vectors: Float32Array;
    sidecarDir: unknown;
  };
  const DIM = 384;

  function fakeDir(dir: string, meta: unknown) {
    return {
      isReady: () => true,
      getPath: (...segs: string[]) => path.join(dir, ...segs),
      readJson: async () => meta,
      writeJson: async () => undefined,
    };
  }

  it('refuses an index whose offsets are not dense', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-embed-corrupt-'));
    const index = new EmbeddingIndex(null);
    const inner = index as unknown as Restorable;

    // Two entries, but one claims row 5 — the exact shape the old removeFile
    // left behind. The binary is big enough that nothing would throw on load,
    // which is what made this silent.
    const meta = {
      version: 1,
      modelId: inner.meta.modelId,
      dimension: DIM,
      count: 2,
      entries: { 'a.ts': { offset: 0, hash: 'h1' }, 'b.ts': { offset: 5, hash: 'h2' } },
    };
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cache', 'embeddings.bin'), Buffer.alloc(6 * DIM * 4));
    inner.sidecarDir = fakeDir(dir, meta);

    await inner.restoreCache();

    // Rebuilt from scratch rather than loaded. (The sibling test proves this
    // path can load a GOOD index, so an empty result here is the validation
    // rejecting corruption, not the fixture failing to be found.)
    expect(Object.keys(inner.meta.entries)).toEqual([]);
    expect(inner.meta.count).toBe(0);
    index.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('loads a consistent index normally', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-embed-ok-'));
    const index = new EmbeddingIndex(null);
    const inner = index as unknown as Restorable;
    const meta = {
      version: 1,
      modelId: inner.meta.modelId,
      dimension: DIM,
      count: 2,
      entries: { 'a.ts': { offset: 0, hash: 'h1' }, 'b.ts': { offset: 1, hash: 'h2' } },
    };
    fs.mkdirSync(path.join(dir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cache', 'embeddings.bin'), Buffer.alloc(2 * DIM * 4));
    inner.sidecarDir = fakeDir(dir, meta);

    await inner.restoreCache();

    expect(inner.meta.count).toBe(2);
    expect(inner.vectors.length).toBe(2 * DIM);
    index.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
