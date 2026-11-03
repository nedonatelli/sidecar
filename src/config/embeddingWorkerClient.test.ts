import { describe, it, expect, vi, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadWorkerPipeline } from './hfPipeline.js';
import type { EmbeddingPipeline } from './embeddingModel.js';

// The worker protocol (#399) against stub workers, so no real model loads.
// Each stub is plain CommonJS written to a temp dir: it plays the part of
// dist/embeddingWorker.js.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-embed-worker-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function stub(name: string, body: string): string {
  const file = path.join(dir, `${name}.cjs`);
  fs.writeFileSync(file, `const { parentPort, workerData } = require('node:worker_threads');\n${body}\n`);
  return file;
}

// Answers each request with [length of first text, id], after a delay that
// makes later requests finish first.
const ECHO = stub(
  'echo',
  `parentPort.postMessage({ type: 'ready' });
   parentPort.on('message', ({ id, texts }) => {
     if (texts[0] === 'boom') return parentPort.postMessage({ id, error: 'bad input' });
     if (texts[0] === 'die') return process.exit(3);
     setTimeout(() => {
       const data = new Float32Array([texts[0].length, id]);
       parentPort.postMessage({ id, data }, [data.buffer]);
     }, 30 - id * 10);
   });`,
);

const FAILS_TO_LOAD = stub('fails', `parentPort.postMessage({ type: 'load-failed', message: 'no model in cache' });`);
const EXITS_EARLY = stub('exits', `process.exit(7);`);

const noInThread = vi.fn(async (): Promise<EmbeddingPipeline> => {
  throw new Error('in-thread loader should not be used');
});

describe('loadWorkerPipeline', () => {
  it('matches each response to its request when they finish out of order', async () => {
    const embed = await loadWorkerPipeline(ECHO, 'm', {}, noInThread);
    const [a, b, c] = await Promise.all([embed(['a']), embed(['bb']), embed(['ccc'])]);
    expect(Array.from(a.data)).toEqual([1, 0]);
    expect(Array.from(b.data)).toEqual([2, 1]);
    expect(Array.from(c.data)).toEqual([3, 2]);
    expect(noInThread).not.toHaveBeenCalled();
  });

  it("rejects one embed with the worker's error and keeps serving others", async () => {
    const embed = await loadWorkerPipeline(ECHO, 'm', {}, noInThread);
    await expect(embed(['boom'])).rejects.toThrow('bad input');
    expect(Array.from((await embed(['ok'])).data)).toEqual([2, 1]);
  });

  it('rejects the load when the worker reports the model failed to load', async () => {
    await expect(loadWorkerPipeline(FAILS_TO_LOAD, 'm', {}, noInThread)).rejects.toThrow('no model in cache');
  });

  it('rejects the load when the worker exits before it is ready', async () => {
    await expect(loadWorkerPipeline(EXITS_EARLY, 'm', {}, noInThread)).rejects.toThrow(/exited \(code 7\)/);
  });

  it('falls back to the calling thread once the worker dies mid-session', async () => {
    const inThread = vi.fn(async (): Promise<EmbeddingPipeline> => async () => ({ data: new Float32Array([42]) }));
    const embed = await loadWorkerPipeline(ECHO, 'm', {}, inThread);
    await expect(embed(['die'])).rejects.toThrow(/embedding worker stopped/);
    expect(Array.from((await embed(['after'])).data)).toEqual([42]);
    expect(inThread).toHaveBeenCalledOnce();
  });
});
