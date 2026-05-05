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
    promises: {
      writeFile: async (p: string, data: Uint8Array | string) => {
        if (typeof p === 'string' && p.startsWith(MOCK_ROOT)) {
          fsState.set(p, Buffer.isBuffer(data) ? Buffer.from(data) : Buffer.from(data as Uint8Array));
          return;
        }
        return actual.promises.writeFile(p, data);
      },
      readFile: async (p: string) => {
        if (typeof p === 'string' && p.startsWith(MOCK_ROOT)) {
          const buf = fsState.get(p);
          if (!buf) {
            const err = new Error('ENOENT: no such file');
            (err as NodeJS.ErrnoException).code = 'ENOENT';
            throw err;
          }
          return buf;
        }
        return actual.promises.readFile(p);
      },
      mkdir: async (p: string) => {
        if (typeof p === 'string' && p.startsWith(MOCK_ROOT)) return undefined;
        return actual.promises.mkdir(p);
      },
      unlink: async (p: string) => {
        if (typeof p === 'string' && p.startsWith(MOCK_ROOT)) {
          fsState.delete(p);
          return;
        }
        return actual.promises.unlink(p);
      },
    },
  };
  return { ...wrapped, default: wrapped };
});

import { FlatVectorStore, LanceVectorStore, cosine, UnsupportedBackendError, type VectorStore } from './vectorStore.js';

// ---------------------------------------------------------------------------
// Fake LanceDB — mimics the parts of @lancedb/lancedb that LanceVectorStore
// touches. State lives in a plain Map so tests start clean without real I/O.
// ---------------------------------------------------------------------------
class FakeLanceTable {
  readonly rows = new Map<string, { id: string; vector: number[]; metadata_json: string }>();

  mergeInsert(on: string) {
    const table = this;
    const builder = {
      whenMatchedUpdateAll() {
        return this;
      },
      whenNotMatchedInsertAll() {
        return this;
      },
      async execute(data: { id: string; vector: number[]; metadata_json: string }[]) {
        for (const row of data) table.rows.set(row[on as 'id'], row);
      },
    };
    return builder;
  }

  async delete(filter: string) {
    const eq = filter.match(/^id = '((?:[^']|'')*)'$/);
    if (eq) {
      table_delete(this.rows, eq[1].replace(/''/g, "'"));
      return;
    }
    const inMatch = filter.match(/^id IN \((.*)\)$/s);
    if (inMatch) {
      const ids = inMatch[1].split(', ').map((s) => s.slice(1, -1).replace(/''/g, "'"));
      for (const id of ids) table_delete(this.rows, id);
    }
  }

  vectorSearch(queryVec: number[]) {
    const table = this;
    const q = {
      _limit: 10,
      metric(_m: string) {
        return this;
      },
      limit(k: number) {
        this._limit = k;
        return this;
      },
      async toArray() {
        // Use a trivial dot-product for sorting so tests can control ranking.
        return [...table.rows.values()]
          .map((row) => {
            let dot = 0;
            for (let i = 0; i < Math.min(queryVec.length, row.vector.length); i++) dot += queryVec[i] * row.vector[i];
            return { ...row, _distance: 1 - dot };
          })
          .sort((a, b) => a._distance - b._distance)
          .slice(0, q._limit);
      },
    };
    return q;
  }

  query() {
    const table = this;
    const q = {
      _cols: null as string[] | null,
      select(cols: string[]) {
        this._cols = cols;
        return this;
      },
      async toArray() {
        const rows = [...table.rows.values()];
        if (!q._cols) return rows;
        return rows.map((r) => Object.fromEntries(q._cols!.map((c) => [c, (r as Record<string, unknown>)[c]])));
      },
    };
    return q;
  }
}

function table_delete(rows: Map<string, unknown>, id: string) {
  rows.delete(id);
}

class FakeLanceConnection {
  readonly tables = new Map<string, FakeLanceTable>();

  async tableNames(): Promise<string[]> {
    return [...this.tables.keys()];
  }

  async openTable(name: string): Promise<FakeLanceTable> {
    const t = this.tables.get(name);
    if (!t) throw new Error(`Table ${name} not found`);
    return t;
  }

  async createTable(name: string, seed: unknown[]): Promise<FakeLanceTable> {
    const t = new FakeLanceTable();
    for (const row of seed as { id: string; vector: number[]; metadata_json: string }[]) {
      t.rows.set(row.id, row);
    }
    this.tables.set(name, t);
    return t;
  }

  async dropTable(name: string): Promise<void> {
    this.tables.delete(name);
  }
}

let fakeConn = new FakeLanceConnection();

/** Fake lancedb module injected into LanceVectorStore tests. */
function makeFakeLancedb() {
  return { connect: async (_path: string) => fakeConn };
}

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

// ---------------------------------------------------------------------------
// LanceVectorStore
// ---------------------------------------------------------------------------
const LANCE_DIM = 4;

function makeLanceStore() {
  return new LanceVectorStore<TestMeta>('/fake/db', 'symbols', LANCE_DIM, makeFakeLancedb());
}

function lVec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

describe('LanceVectorStore', () => {
  beforeEach(() => {
    // Fresh connection + tables for every test.
    fakeConn = new FakeLanceConnection();
  });

  describe('upsert + size + getMetadata', () => {
    it('stores a new record and reflects it in size/getMetadata', async () => {
      const store = makeLanceStore();
      await store.upsert({ id: 'a', vector: lVec(1, 0, 0, 0), metadata: { path: 'a.ts', kind: 'fn', hash: 'h1' } });
      expect(store.size()).toBe(1);
      expect(store.getMetadata('a')).toEqual({ path: 'a.ts', kind: 'fn', hash: 'h1' });
    });

    it('overwrites metadata on a second upsert for the same id', async () => {
      const store = makeLanceStore();
      await store.upsert({ id: 'a', vector: lVec(1, 0, 0, 0), metadata: { path: 'old.ts', kind: 'fn', hash: 'h1' } });
      await store.upsert({ id: 'a', vector: lVec(0, 1, 0, 0), metadata: { path: 'new.ts', kind: 'fn', hash: 'h2' } });
      expect(store.size()).toBe(1);
      expect(store.getMetadata('a')?.path).toBe('new.ts');
    });

    it('rejects a vector whose length differs from the configured dimension', async () => {
      const store = makeLanceStore();
      await expect(
        store.upsert({ id: 'x', vector: new Float32Array(3), metadata: { path: 'p', kind: 'k', hash: 'h' } }),
      ).rejects.toThrow(/dimension/);
    });
  });

  describe('remove', () => {
    it('returns true when the id exists and false when already gone', async () => {
      const store = makeLanceStore();
      await store.upsert({ id: 'a', vector: lVec(1, 0, 0, 0), metadata: { path: 'p', kind: 'k', hash: 'h' } });

      expect(await store.remove('a')).toBe(true);
      expect(store.size()).toBe(0);
      expect(await store.remove('a')).toBe(false);
    });

    it('removes the row from the Lance table', async () => {
      const store = makeLanceStore();
      await store.upsert({ id: 'del', vector: lVec(1, 0, 0, 0), metadata: { path: 'p', kind: 'k', hash: 'h' } });
      await store.remove('del');

      // Table should have no rows after delete.
      const tbl = await fakeConn.openTable('symbols');
      expect(tbl.rows.size).toBe(0);
    });

    it('handles ids with single-quote characters without SQL injection', async () => {
      const store = makeLanceStore();
      const id = "it's";
      await store.upsert({ id, vector: lVec(1, 0, 0, 0), metadata: { path: 'p', kind: 'k', hash: 'h' } });
      expect(await store.remove(id)).toBe(true);
      expect(store.size()).toBe(0);
    });
  });

  describe('removeWhere', () => {
    it('removes every record matching the predicate', async () => {
      const store = makeLanceStore();
      await store.upsert({ id: 'a', vector: lVec(1, 0, 0, 0), metadata: { path: 'src/x.ts', kind: 'fn', hash: 'h' } });
      await store.upsert({ id: 'b', vector: lVec(0, 1, 0, 0), metadata: { path: 'src/x.ts', kind: 'fn', hash: 'h' } });
      await store.upsert({ id: 'c', vector: lVec(0, 0, 1, 0), metadata: { path: 'src/y.ts', kind: 'fn', hash: 'h' } });

      const count = await store.removeWhere((m) => m.path === 'src/x.ts');
      expect(count).toBe(2);
      expect(store.size()).toBe(1);
      expect(store.getMetadata('c')).not.toBeNull();
    });

    it('returns 0 when no records match', async () => {
      const store = makeLanceStore();
      await store.upsert({ id: 'a', vector: lVec(1, 0, 0, 0), metadata: { path: 'p', kind: 'fn', hash: 'h' } });
      expect(await store.removeWhere((m) => m.kind === 'unknown')).toBe(0);
      expect(store.size()).toBe(1);
    });
  });

  describe('search', () => {
    it('returns results ordered by descending similarity', async () => {
      const store = makeLanceStore();
      await store.upsert({ id: 'a', vector: lVec(1, 0, 0, 0), metadata: { path: 'a', kind: 'k', hash: 'h' } });
      await store.upsert({ id: 'b', vector: lVec(0, 1, 0, 0), metadata: { path: 'b', kind: 'k', hash: 'h' } });
      await store.upsert({ id: 'c', vector: lVec(0, 0, 1, 0), metadata: { path: 'c', kind: 'k', hash: 'h' } });

      const hits = await store.search(lVec(1, 0, 0, 0), 5);
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].id).toBe('a');
      expect(hits[0].similarity).toBeCloseTo(1);
    });

    it('applies the metadata filter after retrieving rows', async () => {
      const store = makeLanceStore();
      await store.upsert({ id: 'fn', vector: lVec(1, 0, 0, 0), metadata: { path: 'p', kind: 'fn', hash: 'h' } });
      await store.upsert({ id: 'cls', vector: lVec(1, 0, 0, 0), metadata: { path: 'p', kind: 'cls', hash: 'h' } });

      const hits = await store.search(lVec(1, 0, 0, 0), 10, (m) => m.kind === 'fn');
      expect(hits).toHaveLength(1);
      expect(hits[0].id).toBe('fn');
    });

    it('returns [] when the store is empty', async () => {
      const store = makeLanceStore();
      expect(await store.search(lVec(1, 0, 0, 0), 5)).toEqual([]);
    });
  });

  describe('getVector', () => {
    it('always returns null (vectors are stored on disk, not in-memory)', async () => {
      const store = makeLanceStore();
      await store.upsert({ id: 'a', vector: lVec(1, 0, 0, 0), metadata: { path: 'p', kind: 'k', hash: 'h' } });
      expect(store.getVector('a')).toBeNull();
    });
  });

  describe('entries', () => {
    it('iterates every id+metadata pair from the in-memory cache', async () => {
      const store = makeLanceStore();
      await store.upsert({ id: 'a', vector: lVec(1, 0, 0, 0), metadata: { path: 'a', kind: 'k', hash: 'h' } });
      await store.upsert({ id: 'b', vector: lVec(0, 1, 0, 0), metadata: { path: 'b', kind: 'k', hash: 'h' } });

      const seen = [...store.entries()].map((e) => e.id).sort();
      expect(seen).toEqual(['a', 'b']);
    });
  });

  describe('persist', () => {
    it('is a no-op (Lance is immediately durable)', async () => {
      const store = makeLanceStore();
      await store.upsert({ id: 'a', vector: lVec(1, 0, 0, 0), metadata: { path: 'p', kind: 'k', hash: 'h' } });
      await expect(store.persist()).resolves.toBeUndefined();
    });
  });

  describe('restore', () => {
    it('rebuilds the metadata cache from the Lance table', async () => {
      const store1 = makeLanceStore();
      await store1.upsert({ id: 'a', vector: lVec(1, 0, 0, 0), metadata: { path: 'a.ts', kind: 'fn', hash: 'h1' } });
      await store1.upsert({ id: 'b', vector: lVec(0, 1, 0, 0), metadata: { path: 'b.ts', kind: 'cls', hash: 'h2' } });

      // A second store instance pointing at the same fake connection gets
      // its metadata cache rebuilt via restore().
      const store2 = makeLanceStore();
      await store2.restore();

      expect(store2.size()).toBe(2);
      expect(store2.getMetadata('a')).toEqual({ path: 'a.ts', kind: 'fn', hash: 'h1' });
      expect(store2.getMetadata('b')).toEqual({ path: 'b.ts', kind: 'cls', hash: 'h2' });
    });
  });

  describe('clearPersisted', () => {
    it('drops the Lance table and clears the in-memory cache', async () => {
      const store = makeLanceStore();
      await store.upsert({ id: 'a', vector: lVec(1, 0, 0, 0), metadata: { path: 'p', kind: 'k', hash: 'h' } });
      await store.clearPersisted();

      expect(store.size()).toBe(0);
      expect(fakeConn.tables.has('symbols')).toBe(false);
    });
  });
});
