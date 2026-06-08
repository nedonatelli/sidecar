import { describe, it, expect, vi, afterEach } from 'vitest';
import { getSharedPipeline, setLoaderForTests } from './hfPipeline.js';
import type { EmbeddingPipeline } from './hfPipeline.js';

afterEach(() => {
  // Restore the real loader and clear the cache after every test so
  // no state bleeds into subsequent tests.
  setLoaderForTests(null);
});

function fakePipeline(): EmbeddingPipeline {
  return vi.fn();
}

describe('getSharedPipeline — cache eviction on rejection', () => {
  it('evicts a failed load so the next call retries (root cause of 0/3430 bug)', async () => {
    const fn1 = fakePipeline();
    let callCount = 0;
    setLoaderForTests(async () => {
      callCount++;
      if (callCount === 1) throw new Error('network error');
      return fn1;
    });

    // First call fails — the rejected promise must be evicted from cache.
    await expect(getSharedPipeline('model-a')).rejects.toThrow('network error');

    // By the time the await above returns, the .catch() eviction has already
    // fired (it's a microtask that precedes our rejection propagation).
    // Second call succeeds and must NOT return the cached rejection.
    const result = await getSharedPipeline('model-a');
    expect(result).toBe(fn1);
    expect(callCount).toBe(2);
  });

  it('does NOT retry after a successful load (caches the resolved promise)', async () => {
    const fn = fakePipeline();
    let callCount = 0;
    setLoaderForTests(async () => {
      callCount++;
      return fn;
    });

    // Both calls should return the same promise object.
    const p1 = getSharedPipeline('model-b');
    const p2 = getSharedPipeline('model-b');
    expect(p1).toBe(p2);

    const result = await p1;
    expect(result).toBe(fn);
    // Loader called only once — second getSharedPipeline reused the cache.
    expect(callCount).toBe(1);
  });

  it('isolates caches by model ID', async () => {
    const fnA = fakePipeline();
    const fnB = fakePipeline();
    const calls: string[] = [];
    setLoaderForTests(async (id) => {
      calls.push(id);
      return id === 'model-c' ? fnA : fnB;
    });

    const [rA, rB] = await Promise.all([getSharedPipeline('model-c'), getSharedPipeline('model-d')]);
    expect(rA).toBe(fnA);
    expect(rB).toBe(fnB);
    expect(calls.sort()).toEqual(['model-c', 'model-d']);
  });
});
