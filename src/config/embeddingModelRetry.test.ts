import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { logger } from '../system/logger.js';
import { LazyEmbedder, MODEL_LOAD_RETRY_DELAYS_MS, setLoaderForTests, type EmbeddingPipeline } from './hfPipeline.js';
import { SymbolEmbeddingIndex } from './symbolEmbeddingIndex.js';
import { EmbeddingIndex } from './embeddingIndex.js';

// #401: a model that cannot load (offline first run, corrupt cache) used to be
// re-attempted every 250 ms, with a warning each time, for as long as the
// window stayed open.

const pipeline: EmbeddingPipeline = async () => ({ data: new Float32Array(384).fill(0.05) });

/** A loader that fails its first `failures` calls (all of them by default), then loads. */
function flakyLoader(failures = Infinity) {
  let calls = 0;
  const load = vi.fn(async () => {
    calls += 1;
    if (calls <= failures) throw new Error('fetch failed');
    return pipeline;
  });
  return load;
}

const loadWarnings = (warn: ReturnType<typeof vi.spyOn>) =>
  warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('Embedding model failed to load')).length;

function symbol(i: number) {
  return {
    filePath: `src/f${i}.ts`,
    qualifiedName: `fn${i}`,
    name: `fn${i}`,
    kind: 'function',
    startLine: 1,
    endLine: 2,
    body: `function fn${i}() {}`,
  };
}

describe('embedding model load retries (#401)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.useFakeTimers();
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    setLoaderForTests(null);
    warn.mockRestore();
    vi.useRealTimers();
  });

  it('LazyEmbedder waits out each delay, then stops trying', async () => {
    const load = flakyLoader();
    setLoaderForTests(load);
    const embedder = new LazyEmbedder({ label: 'T' });

    expect(await embedder.ensureReady()).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
    // Inside the first delay: no new attempt, and an immediate false.
    expect(await embedder.ensureReady()).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);

    for (const delay of MODEL_LOAD_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
      expect(await embedder.ensureReady()).toBe(false);
    }
    expect(load).toHaveBeenCalledTimes(1 + MODEL_LOAD_RETRY_DELAYS_MS.length);
    expect(embedder.gaveUp).toBe(true);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(await embedder.ensureReady()).toBe(false);
    expect(load).toHaveBeenCalledTimes(1 + MODEL_LOAD_RETRY_DELAYS_MS.length);
    expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(/failed to load 4 times \(fetch failed\); not retrying/);
  });

  it('retryModelLoad lets a given-up embedder try again', async () => {
    setLoaderForTests(flakyLoader(MODEL_LOAD_RETRY_DELAYS_MS.length + 1));
    const embedder = new LazyEmbedder({ label: 'T' });
    await embedder.ensureReady();
    for (const delay of MODEL_LOAD_RETRY_DELAYS_MS) {
      await vi.advanceTimersByTimeAsync(delay);
      await embedder.ensureReady();
    }
    expect(embedder.gaveUp).toBe(true);
    embedder.retryModelLoad();
    expect(await embedder.ensureReady()).toBe(true);
  });

  it('the symbol index makes a bounded number of attempts in 60 s, not one every 250 ms', async () => {
    const load = flakyLoader();
    setLoaderForTests(load);
    const index = new SymbolEmbeddingIndex(null);
    for (let i = 0; i < 100; i++) index.queueSymbol(symbol(i));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(load).toHaveBeenCalledTimes(1 + MODEL_LOAD_RETRY_DELAYS_MS.length);
    expect(loadWarnings(warn)).toBe(1 + MODEL_LOAD_RETRY_DELAYS_MS.length);
    // Nothing left polling once it gave up.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('both indexes embed what they queued once a retry succeeds', async () => {
    setLoaderForTests(flakyLoader(2));
    const symbols = new SymbolEmbeddingIndex(null);
    for (let i = 0; i < 60; i++) symbols.queueSymbol(symbol(i));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(symbols.getCount()).toBe(60);

    setLoaderForTests(flakyLoader(2));
    const files = new EmbeddingIndex(null);
    for (let i = 0; i < 30; i++) files.queueUpdate(`src/f${i}.ts`, `export const v = ${i};`);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(files.getCount()).toBe(30);
  });
});
