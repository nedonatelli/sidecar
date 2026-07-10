import { describe, it, expect, vi, afterEach } from 'vitest';
import { getSharedPipeline, setLoaderForTests, LazyEmbedder } from './hfPipeline.js';
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

describe('LazyEmbedder', () => {
  function outputPipeline(values: number[]): EmbeddingPipeline {
    return vi.fn(async () => ({ data: new Float32Array(values) }));
  }

  it('re-attempts loading after a transient failure (the EmbeddingIndex bug)', async () => {
    let calls = 0;
    setLoaderForTests(async () => {
      calls++;
      if (calls === 1) throw new Error('cold-start failure');
      return outputPipeline([1, 2, 3, 4]);
    });
    const emb = new LazyEmbedder({ label: 'Test', modelId: 'm', dimension: 4 });

    // First attempt fails and must NOT latch the index off permanently.
    expect(await emb.ensureReady()).toBe(false);
    expect(emb.ready).toBe(false);

    // A later call re-attempts and succeeds — the divergent semantics that
    // left the rejected promise cached would have returned false forever here.
    const vec = await emb.embed('hello');
    expect(vec).toEqual(new Float32Array([1, 2, 3, 4]));
    expect(emb.ready).toBe(true);
    expect(calls).toBe(2);
  });

  it('truncates input to maxChars and slices output to dimension', async () => {
    const pipe = outputPipeline([0.1, 0.2, 0.3, 0.4, 0.5]);
    setLoaderForTests(async () => pipe);
    const emb = new LazyEmbedder({ label: 'Test', modelId: 'm', dimension: 3, maxChars: 4 });

    const vec = await emb.embed('abcdefgh');
    expect((pipe as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toEqual(['abcd']);
    expect(vec).toEqual(new Float32Array([0.1, 0.2, 0.3]));
  });

  it('setPipelineForTests(null) simulates an unavailable model', async () => {
    const emb = new LazyEmbedder({ label: 'Test' });
    emb.setPipelineForTests(null);
    expect(emb.ready).toBe(false);
    expect(await emb.embed('x')).toBeNull();
  });
});

describe('LazyEmbedder — priority lane (query embeds jump the batch backlog)', () => {
  it('a batch embed started while a priority embed is pending waits for it', async () => {
    const order: string[] = [];
    let releaseSlow: (() => void) | null = null;
    const pipe = vi.fn(async (inputs: string[]) => {
      order.push(`start:${inputs[0]}`);
      if (inputs[0] === 'QUERY') {
        await new Promise<void>((r) => {
          releaseSlow = r;
        });
      }
      order.push(`end:${inputs[0]}`);
      return { data: new Float32Array([1, 2, 3, 4]) };
    }) as unknown as EmbeddingPipeline;
    setLoaderForTests(async () => pipe);
    const emb = new LazyEmbedder({ label: 'Test', modelId: 'm', dimension: 4 });
    await emb.ensureReady();

    const query = emb.embed('QUERY', { priority: true });
    // Give the priority embed a tick to start.
    await new Promise((r) => setTimeout(r, 0));
    const batch = emb.embed('BATCH');
    await new Promise((r) => setTimeout(r, 0));

    // Batch must not have started while the priority embed is in flight.
    expect(order).toEqual(['start:QUERY']);
    releaseSlow!();
    await query;
    await batch;
    expect(order).toEqual(['start:QUERY', 'end:QUERY', 'start:BATCH', 'end:BATCH']);
  });

  it('waiters are released even when the priority embed throws', async () => {
    let first = true;
    const pipe = vi.fn(async (inputs: string[]) => {
      if (first && inputs[0] === 'QUERY') {
        first = false;
        throw new Error('embed exploded');
      }
      return { data: new Float32Array([1, 2, 3, 4]) };
    }) as unknown as EmbeddingPipeline;
    setLoaderForTests(async () => pipe);
    const emb = new LazyEmbedder({ label: 'Test', modelId: 'm', dimension: 4 });
    await emb.ensureReady();

    const query = emb.embed('QUERY', { priority: true });
    await new Promise((r) => setTimeout(r, 0));
    const batch = emb.embed('BATCH');

    expect(await query).toBeNull(); // failed embed → null, never throws
    expect(await batch).toEqual(new Float32Array([1, 2, 3, 4])); // lane released
  });
});
