import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { EmbeddingIndex } from './embeddingIndex.js';
import { setLoaderForTests, MINILM_MODEL_ID, type EmbeddingPipeline } from './hfPipeline.js';

// Exercises the model-backed path (queue -> debounced flush -> embed -> store ->
// search) and the persist/restore round-trip, which the base test skips because
// it runs without a model. A fake pipeline + fake timers keep it deterministic.

const DIMENSION = 384;
function unitVec(): Float32Array {
  return new Float32Array(DIMENSION).fill(1 / Math.sqrt(DIMENSION));
}
const fakePipeline: EmbeddingPipeline = vi.fn(async () => ({ data: unitVec() }));

// In-memory sidecarDir backed by a real temp dir for the binary vectors file.
let tmpDir: string;
let jsonStore: Record<string, unknown>;
function makeSidecarDir() {
  return {
    isReady: () => true,
    writeJson: vi.fn(async (sub: string, data: unknown) => {
      jsonStore[sub] = JSON.parse(JSON.stringify(data));
    }),
    readJson: vi.fn(async (sub: string) => jsonStore[sub] ?? null),
    getPath: (sub: string) => path.join(tmpDir, sub),
  } as never;
}

async function indexFiles(idx: EmbeddingIndex, files: Record<string, string>) {
  for (const [p, c] of Object.entries(files)) idx.queueUpdate(p, c);
  await vi.advanceTimersByTimeAsync(600); // past UPDATE_DEBOUNCE_MS
}

beforeEach(() => {
  setLoaderForTests(async () => fakePipeline);
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-emb-'));
  jsonStore = {};
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setLoaderForTests(null);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('EmbeddingIndex — model-backed queue/flush/search', () => {
  it('embeds queued files on flush and makes them searchable', async () => {
    const idx = new EmbeddingIndex(null);
    await idx.initialize();
    await indexFiles(idx, { 'a.ts': 'alpha content', 'b.ts': 'beta content' });

    expect(idx.getCount()).toBe(2);
    const results = await idx.search('anything', 10);
    expect(results.map((r) => r.relativePath).sort()).toEqual(['a.ts', 'b.ts']);
    // fixed unit vectors → cosine ~1 for every pair
    expect(results[0].similarity).toBeCloseTo(1, 5);
    idx.dispose();
  });

  it('skips re-embedding unchanged content and re-embeds on change (overwrite in place)', async () => {
    const idx = new EmbeddingIndex(null);
    await idx.initialize();
    await indexFiles(idx, { 'a.ts': 'v1' });
    expect(idx.getCount()).toBe(1);

    // Re-index identical content: the stored hash matches, so no embed happens.
    (fakePipeline as unknown as ReturnType<typeof vi.fn>).mockClear();
    await indexFiles(idx, { 'a.ts': 'v1' });
    expect(fakePipeline).not.toHaveBeenCalled();
    expect(idx.getCount()).toBe(1);

    // Changed content: re-embeds and overwrites in place (count stays 1).
    (fakePipeline as unknown as ReturnType<typeof vi.fn>).mockClear();
    await indexFiles(idx, { 'a.ts': 'v2-changed' });
    expect(fakePipeline).toHaveBeenCalled();
    expect(idx.getCount()).toBe(1);
    idx.dispose();
  });

  it('removeFile drops the entry from the index', async () => {
    const idx = new EmbeddingIndex(null);
    await idx.initialize();
    await indexFiles(idx, { 'a.ts': 'x', 'b.ts': 'y' });
    idx.removeFile('a.ts');
    expect(idx.getCount()).toBe(1);
    idx.removeFile('nonexistent.ts'); // no-op
    expect(idx.getCount()).toBe(1);
    idx.dispose();
  });
});

describe('EmbeddingIndex — persistence', () => {
  it('persists then restores vectors across instances', async () => {
    const sidecarDir = makeSidecarDir();
    const idx = new EmbeddingIndex(sidecarDir);
    await idx.initialize();
    await indexFiles(idx, { 'a.ts': 'alpha', 'b.ts': 'beta' });
    await idx.persist();

    // meta persisted + binary written to the temp dir
    expect(jsonStore['cache/embeddings-meta.json']).toMatchObject({ count: 2, modelId: MINILM_MODEL_ID });
    expect(fs.existsSync(path.join(tmpDir, 'cache/embeddings.bin'))).toBe(true);

    const restored = new EmbeddingIndex(sidecarDir);
    await restored.initialize();
    expect(restored.getCount()).toBe(2);
    expect((await restored.search('q', 10)).length).toBe(2);
    idx.dispose();
    restored.dispose();
  });

  it('discards a cache whose model id no longer matches', async () => {
    const sidecarDir = makeSidecarDir();
    // Seed a stale meta (wrong model) + a bin file that should be deleted.
    jsonStore['cache/embeddings-meta.json'] = {
      version: 1,
      modelId: 'old-model',
      dimension: DIMENSION,
      count: 1,
      entries: { 'a.ts': { offset: 0, hash: 'h' } },
    };
    fs.mkdirSync(path.join(tmpDir, 'cache'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'cache/embeddings.bin'), Buffer.alloc(DIMENSION * 4));

    const idx = new EmbeddingIndex(sidecarDir);
    await idx.initialize();
    expect(idx.getCount()).toBe(0); // stale cache rejected
    expect(fs.existsSync(path.join(tmpDir, 'cache/embeddings.bin'))).toBe(false); // and cleaned up
    idx.dispose();
  });
});
