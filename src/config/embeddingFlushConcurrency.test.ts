import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setLoaderForTests, type EmbeddingPipeline } from './hfPipeline.js';
import { SymbolEmbeddingIndex } from './symbolEmbeddingIndex.js';
import { EmbeddingIndex } from './embeddingIndex.js';

// #399: onnxruntime-node runs each inference from its own setImmediate, and
// Node runs every queued immediate before timers or IPC get a turn. So the
// number of embeds in flight is how long the extension host blocks per turn:
// 4 in flight is ~40 ms, 900 is ~8 s. These tests hold the model load open
// while work is queued, as a cold start does, and count the peak in flight.

/** A model load that stays pending until `release()`, and a pipeline that counts concurrent calls. */
function controlledModel() {
  let inFlight = 0;
  let peak = 0;
  let calls = 0;
  const pipeline: EmbeddingPipeline = async () => {
    inFlight += 1;
    calls += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight -= 1;
    return { data: new Float32Array(384).fill(0.05) };
  };
  let release!: () => void;
  const loaded = new Promise<EmbeddingPipeline>((resolve) => {
    release = () => resolve(pipeline);
  });
  return { load: () => loaded, release: () => release(), stats: () => ({ peak, calls, inFlight }) };
}

describe('embedding flush concurrency during a cold start (#399)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    setLoaderForTests(null);
    vi.useRealTimers();
  });

  it('the symbol index keeps one flush in flight while the model loads', async () => {
    const model = controlledModel();
    setLoaderForTests(model.load);
    const index = new SymbolEmbeddingIndex(null);
    // A replay queues symbols across the seconds the model takes to load.
    for (let chunk = 0; chunk < 40; chunk++) {
      for (let i = 0; i < 25; i++) {
        index.queueSymbol({
          filePath: `src/f${chunk}.ts`,
          qualifiedName: `fn${i}`,
          name: `fn${i}`,
          kind: 'function',
          startLine: i,
          endLine: i + 1,
          body: `function fn${i}() { return ${chunk}; }`,
        });
      }
      await vi.advanceTimersByTimeAsync(250);
    }
    model.release();
    await vi.advanceTimersByTimeAsync(60_000);
    const { peak, calls } = model.stats();
    expect(calls).toBe(1000);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('the file index keeps one flush in flight while the model loads', async () => {
    const model = controlledModel();
    setLoaderForTests(model.load);
    const index = new EmbeddingIndex(null);
    for (let chunk = 0; chunk < 40; chunk++) {
      for (let i = 0; i < 10; i++) index.queueUpdate(`src/f${chunk}_${i}.ts`, `export const v = ${chunk * 10 + i};`);
      await vi.advanceTimersByTimeAsync(250);
    }
    model.release();
    await vi.advanceTimersByTimeAsync(60_000);
    const { peak, calls } = model.stats();
    expect(calls).toBe(400);
    expect(peak).toBeLessThanOrEqual(4);
  });
});
