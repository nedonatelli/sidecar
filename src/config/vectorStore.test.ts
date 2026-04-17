import { describe, it, expect, vi, beforeEach } from 'vitest';

// Simulated fs state — maps bin-file paths to their current contents.
// vi.mock below routes every fs.writeFileSync / readFileSync / etc.
// for bin-file paths into this map so roundtrip tests don't touch disk.
// Keyed by string path for simplicity.
const fsState = new Map<string, Buffer>();

/**
 * All fs calls under the mock `.sidecar/` root are routed through
 * fsState so tests never touch real disk. We gate on path prefix
 * (`/mock-workspace/.sidecar/`) rather than filename fragment so
 * directory-level calls (`existsSync('...')`, `mkdirSync`) are
 * handled too — otherwise FlatVectorStore's persist-time
 * `mkdirSync` would fall through to real fs and ENOENT.
 */
const MOCK_ROOT = '/mock-workspace/.sidecar/';

vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  const wrapped = {
    ...actual,
    writeFileSync: (p: string, data: Uint8Array | string) => {
      if (typeof p === 'string' && p.startsWith(MOCK_ROOT)) {
        fsState.set(p, Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data as Uint8Array));
        return;
      }
      return actual.writeFileSync(p, data);
    },
    readFileSync: ((p: string, enc?: BufferEncoding) => {
      if (typeof p === 'string' && p.startsWith(MOCK_ROOT)) {
        const buf = fsState.get(p);
        if (!buf) {
          const err = new Error('ENOENT: no such file');
          (err as NodeJS.ErrnoException).code = 'ENOENT';
          throw err;
        }
        return buf;
      }
      return actual.readFileSync(p, enc);
    }) as typeof actual.readFileSync,
    existsSync: (p: string) => {
      if (typeof p === 'string' && p.startsWith(MOCK_ROOT)) {
        // Directory check: true if any fsState key starts with this path + '/'.
        if (fsState.has(p)) return true;
        const dirPrefix = p.endsWith('/') ? p : p + '/';
        for (const key of fsState.keys()) {
          if (key.startsWith(dirPrefix)) return true;
        }
        return false;
      }
      return actual.existsSync(p);
    },
    mkdirSync: ((p: string, opts?: unknown) => {
      if (typeof p === 'string' && p.startsWith(MOCK_ROOT)) return undefined;
      return actual.mkdirSync(p, opts as never);
    }) as typeof actual.mkdirSync,
    unlinkSync: (p: string) => {
      if (typeof p === 'string' && p.startsWith(MOCK_ROOT)) {
        fsState.delete(p);
        return;
      }
      return actual.unlinkSync(p);
    },
  };
  return { ...wrapped, default: wrapped };
});

import { FlatVectorStore, cosine, UnsupportedBackendError, type VectorStore } from './vectorStore.js';

/**
 * Tests exercise the FlatVectorStore against a synthetic metadata
 * type — the same store powers the SymbolEmbeddingIndex's storage
 * internals, but these tests don't know anything about symbols.
 * That's deliberate: the store is the backend seam, and testing it
 * through the symbol domain would couple the two layers.
 *
 * Persistence tests use `vi.spyOn(workspace.fs, ...)` patterns
 * established by the existing config/*.test.ts suites — we don't
 * hit real disk, but we DO exercise the real FlatVectorStore
 * read/write paths including `fs.writeFileSync` / `fs.readFileSync`
 * for the binary vector file.
 */

interface TestMeta {
  path: string;
  kind: string;
  hash: string;
}

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

/**
 * Build a unit-vector from a 4-dim sparse input. Keeps tests
 * readable — we don't need 384 dimensions to prove store semantics.
 */
const DIM = 4;

function makeStore(sidecarDir: unknown = null) {
  return new FlatVectorStore<TestMeta>(sidecarDir as never, {
    dimension: DIM,
    version: 1,
    binFile: 'cache/test-vectors.bin',
    metaFile: 'cache/test-vectors-meta.json',
  });
}

describe('FlatVectorStore', () => {
  describe('upsert + size + getMetadata', () => {
    it('stores a new record', async () => {
      const store = makeStore();
      await store.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'p', kind: 'k', hash: 'h' } });
      expect(store.size()).toBe(1);
      expect(store.getMetadata('a')).toEqual({ path: 'p', kind: 'k', hash: 'h' });
    });

    it('overwrites an existing record in place (no size growth)', async () => {
      const store = makeStore();
      await store.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'p1', kind: 'k', hash: 'h1' } });
      await store.upsert({ id: 'a', vector: vec(0, 1, 0, 0), metadata: { path: 'p2', kind: 'k', hash: 'h2' } });
      expect(store.size()).toBe(1);
      expect(store.getMetadata('a')?.hash).toBe('h2');
    });

    it('grows the backing array as more records come in', async () => {
      const store = makeStore();
      for (let i = 0; i < 5; i++) {
        await store.upsert({
          id: `id${i}`,
          vector: vec(i, 0, 0, 0),
          metadata: { path: `p${i}`, kind: 'k', hash: 'h' },
        });
      }
      expect(store.size()).toBe(5);
    });

    it('rejects a vector whose length does not match the configured dimension', async () => {
      const store = makeStore();
      await expect(
        store.upsert({ id: 'bad', vector: new Float32Array(3), metadata: { path: 'p', kind: 'k', hash: 'h' } }),
      ).rejects.toThrow(/dimension/);
    });
  });

  describe('remove / removeWhere', () => {
    it('remove returns true iff the record existed', async () => {
      const store = makeStore();
      await store.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'p', kind: 'k', hash: 'h' } });

      expect(await store.remove('a')).toBe(true);
      expect(await store.remove('a')).toBe(false); // already gone
      expect(store.size()).toBe(0);
    });

    it('removeWhere drops every match and returns the count', async () => {
      const store = makeStore();
      await store.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'src/x.ts', kind: 'fn', hash: 'h' } });
      await store.upsert({ id: 'b', vector: vec(0, 1, 0, 0), metadata: { path: 'src/x.ts', kind: 'fn', hash: 'h' } });
      await store.upsert({ id: 'c', vector: vec(0, 0, 1, 0), metadata: { path: 'src/y.ts', kind: 'fn', hash: 'h' } });

      const removed = await store.removeWhere((m) => m.path === 'src/x.ts');
      expect(removed).toBe(2);
      expect(store.size()).toBe(1);
      expect(store.getMetadata('c')).not.toBeNull();
    });

    it('removeWhere returns 0 when nothing matches', async () => {
      const store = makeStore();
      await store.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'p', kind: 'k', hash: 'h' } });
      expect(await store.removeWhere((m) => m.kind === 'unknown')).toBe(0);
      expect(store.size()).toBe(1);
    });
  });

  describe('search', () => {
    it('returns results ordered by descending similarity', async () => {
      const store = makeStore();
      // Three orthogonal unit vectors — cosine with (1,0,0,0) gives
      // 1 for 'a', 0 for 'b' and 'c'.
      await store.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'a', kind: 'k', hash: 'h' } });
      await store.upsert({ id: 'b', vector: vec(0, 1, 0, 0), metadata: { path: 'b', kind: 'k', hash: 'h' } });
      await store.upsert({ id: 'c', vector: vec(0, 0, 1, 0), metadata: { path: 'c', kind: 'k', hash: 'h' } });

      const hits = await store.search(vec(1, 0, 0, 0), 5);
      expect(hits).toHaveLength(3);
      expect(hits[0].id).toBe('a');
      expect(hits[0].similarity).toBeCloseTo(1);
      expect(hits[1].similarity).toBeCloseTo(0);
    });

    it('respects topK', async () => {
      const store = makeStore();
      for (let i = 0; i < 10; i++) {
        await store.upsert({
          id: `id${i}`,
          vector: vec(1, i / 10, 0, 0),
          metadata: { path: `p${i}`, kind: 'k', hash: 'h' },
        });
      }
      const hits = await store.search(vec(1, 0, 0, 0), 3);
      expect(hits).toHaveLength(3);
    });

    it('applies the metadata filter', async () => {
      const store = makeStore();
      await store.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'src/a.ts', kind: 'fn', hash: 'h' } });
      await store.upsert({ id: 'b', vector: vec(1, 0, 0, 0), metadata: { path: 'src/b.ts', kind: 'cls', hash: 'h' } });

      const hits = await store.search(vec(1, 0, 0, 0), 10, (m) => m.kind === 'fn');
      expect(hits).toHaveLength(1);
      expect(hits[0].id).toBe('a');
    });

    it('returns [] when the store is empty', async () => {
      const store = makeStore();
      expect(await store.search(vec(1, 0, 0, 0), 5)).toEqual([]);
    });

    it('returns [] when the query vector length differs from the configured dimension', async () => {
      const store = makeStore();
      await store.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'p', kind: 'k', hash: 'h' } });
      expect(await store.search(new Float32Array(3), 5)).toEqual([]);
    });
  });

  describe('entries', () => {
    it('iterates every stored (id, metadata) pair', async () => {
      const store = makeStore();
      await store.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'a', kind: 'k', hash: 'h' } });
      await store.upsert({ id: 'b', vector: vec(0, 1, 0, 0), metadata: { path: 'b', kind: 'k', hash: 'h' } });

      const seen = [...store.entries()].map((e) => e.id).sort();
      expect(seen).toEqual(['a', 'b']);
    });
  });
});

describe('FlatVectorStore persistence', () => {
  /**
   * Minimal SidecarDir fake. Stores JSON writes in an in-memory map;
   * the fs module mock at the top of the file handles the bin files.
   */
  const jsonStore = new Map<string, unknown>();

  const fakeSidecarDir = {
    isReady: () => true,
    getPath: (...segs: string[]) => '/mock-workspace/.sidecar/' + segs.join('/'),
    readJson: vi.fn(async <T>(p: string): Promise<T | null> => (jsonStore.get(p) as T | undefined) ?? null),
    writeJson: vi.fn(async (p: string, data: unknown) => {
      jsonStore.set(p, data);
    }),
  } as never;

  beforeEach(() => {
    jsonStore.clear();
    fsState.clear();
  });

  it('persist + restore roundtrips records preserving metadata and similarity', async () => {
    const store1 = new FlatVectorStore<TestMeta>(fakeSidecarDir, {
      dimension: DIM,
      version: 1,
      binFile: 'cache/test-vectors.bin',
      metaFile: 'cache/test-vectors-meta.json',
    });
    await store1.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'a.ts', kind: 'fn', hash: 'h1' } });
    await store1.upsert({ id: 'b', vector: vec(0, 1, 0, 0), metadata: { path: 'b.ts', kind: 'cls', hash: 'h2' } });
    await store1.persist();

    // Second store instance reads the persisted state.
    const store2 = new FlatVectorStore<TestMeta>(fakeSidecarDir, {
      dimension: DIM,
      version: 1,
      binFile: 'cache/test-vectors.bin',
      metaFile: 'cache/test-vectors-meta.json',
    });
    await store2.restore();

    expect(store2.size()).toBe(2);
    expect(store2.getMetadata('a')).toEqual({ path: 'a.ts', kind: 'fn', hash: 'h1' });
    const hits = await store2.search(vec(1, 0, 0, 0), 5);
    expect(hits[0].id).toBe('a');
    expect(hits[0].similarity).toBeCloseTo(1);
  });

  it('extraMeta is written into the envelope and visible to validateMeta on restore', async () => {
    const validateSpy = vi.fn((meta: Record<string, unknown>) => meta.modelId === 'test-model');
    const store1 = new FlatVectorStore<TestMeta>(fakeSidecarDir, {
      dimension: DIM,
      version: 1,
      binFile: 'cache/test-vectors.bin',
      metaFile: 'cache/test-vectors-meta.json',
      extraMeta: { modelId: 'test-model' },
      validateMeta: validateSpy,
    });
    await store1.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'a', kind: 'k', hash: 'h' } });
    await store1.persist();

    const envelope = jsonStore.get('cache/test-vectors-meta.json') as Record<string, unknown>;
    expect(envelope.modelId).toBe('test-model');

    // Restore — validateMeta sees the modelId.
    const store2 = new FlatVectorStore<TestMeta>(fakeSidecarDir, {
      dimension: DIM,
      version: 1,
      binFile: 'cache/test-vectors.bin',
      metaFile: 'cache/test-vectors-meta.json',
      validateMeta: validateSpy,
    });
    await store2.restore();
    expect(validateSpy).toHaveBeenCalled();
    const validatedMeta = validateSpy.mock.calls[0][0];
    expect(validatedMeta.modelId).toBe('test-model');
    expect(store2.size()).toBe(1);
  });

  it('restore rejects a mismatched envelope', async () => {
    // Store with version 1 persists the data.
    const store1 = new FlatVectorStore<TestMeta>(fakeSidecarDir, {
      dimension: DIM,
      version: 1,
      binFile: 'cache/test-vectors.bin',
      metaFile: 'cache/test-vectors-meta.json',
    });
    await store1.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'a', kind: 'k', hash: 'h' } });
    await store1.persist();

    // Second store declares version 2 — default validator rejects it.
    const warnSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const store2 = new FlatVectorStore<TestMeta>(fakeSidecarDir, {
        dimension: DIM,
        version: 2,
        binFile: 'cache/test-vectors.bin',
        metaFile: 'cache/test-vectors-meta.json',
      });
      await store2.restore();
      // Rejected cache → empty store, ready for rebuild.
      expect(store2.size()).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('persist compacts orphan rows from prior removes', async () => {
    // Reproduces the v0.61 behavior: remove a symbol mid-session,
    // persist, and the on-disk file rewrites without the gap.
    const store = new FlatVectorStore<TestMeta>(fakeSidecarDir, {
      dimension: DIM,
      version: 1,
      binFile: 'cache/test-vectors.bin',
      metaFile: 'cache/test-vectors-meta.json',
    });
    await store.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'a', kind: 'k', hash: 'h' } });
    await store.upsert({ id: 'b', vector: vec(0, 1, 0, 0), metadata: { path: 'b', kind: 'k', hash: 'h' } });
    await store.remove('a');
    await store.persist();

    // Persisted envelope has only the live entry.
    const envelope = jsonStore.get('cache/test-vectors-meta.json') as {
      count: number;
      entries: Record<string, unknown>;
    };
    expect(envelope.count).toBe(1);
    expect(Object.keys(envelope.entries)).toEqual(['b']);

    // Reload into a fresh store — size matches the compacted view.
    const store2 = new FlatVectorStore<TestMeta>(fakeSidecarDir, {
      dimension: DIM,
      version: 1,
      binFile: 'cache/test-vectors.bin',
      metaFile: 'cache/test-vectors-meta.json',
    });
    await store2.restore();
    expect(store2.size()).toBe(1);
    expect(store2.getMetadata('b')).not.toBeNull();
  });

  it('clearPersisted removes both files', async () => {
    const store = new FlatVectorStore<TestMeta>(fakeSidecarDir, {
      dimension: DIM,
      version: 1,
      binFile: 'cache/test-vectors.bin',
      metaFile: 'cache/test-vectors-meta.json',
    });
    await store.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'a', kind: 'k', hash: 'h' } });
    await store.persist();

    // Verify persistence landed first.
    expect(fsState.size).toBe(1);
    expect(jsonStore.size).toBe(1);

    await store.clearPersisted();

    expect(fsState.size).toBe(0);
  });

  it('persist is a no-op when sidecarDir is not ready', async () => {
    const noDir: VectorStore<TestMeta> = new FlatVectorStore<TestMeta>(null, {
      dimension: DIM,
      version: 1,
      binFile: 'cache/test-vectors.bin',
      metaFile: 'cache/test-vectors-meta.json',
    });
    await noDir.upsert({ id: 'a', vector: vec(1, 0, 0, 0), metadata: { path: 'a', kind: 'k', hash: 'h' } });
    // Shouldn't throw; shouldn't hit fs.
    await expect(noDir.persist()).resolves.toBeUndefined();
    expect(fsState.size).toBe(0);
  });
});

describe('cosine', () => {
  it('returns 1 for identical unit vectors', () => {
    const a = vec(1, 0, 0, 0);
    expect(cosine(a, a)).toBeCloseTo(1);
  });

  it('returns 0 for orthogonal unit vectors', () => {
    expect(cosine(vec(1, 0, 0, 0), vec(0, 1, 0, 0))).toBe(0);
  });

  it('truncates to the shorter input length', () => {
    expect(cosine(vec(1, 0, 0, 0), new Float32Array([1]))).toBe(1);
  });
});

describe('UnsupportedBackendError', () => {
  it('carries both the requested and fallback backend names', () => {
    const err = new UnsupportedBackendError('lance', 'flat');
    expect(err.requestedBackend).toBe('lance');
    expect(err.fallbackTo).toBe('flat');
    expect(err.name).toBe('UnsupportedBackendError');
    expect(err.message).toContain('lance');
    expect(err.message).toContain('flat');
  });
});
