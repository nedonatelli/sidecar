/**
 * Worker-thread entry that owns the embedding model (#399). Bundled to
 * dist/embeddingWorker.js and started by `loadEmbeddingPipeline`.
 *
 * onnxruntime-node runs each inference synchronously on the thread that calls
 * it. On the extension host's thread a cold start spent ~85% of 80 s there,
 * which is the thread every other extension in the window shares. Here only
 * the input strings and the output vectors cross threads.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { loadInThreadPipeline, type EmbedRequest, type EmbedResponse, type WorkerInit } from './embeddingModel.js';

async function main(): Promise<void> {
  const port = parentPort;
  if (!port) return;
  const { modelId, envOpts } = workerData as WorkerInit;
  let pipeline;
  try {
    pipeline = await loadInThreadPipeline(modelId, envOpts);
  } catch (err) {
    port.postMessage({ type: 'load-failed', message: err instanceof Error ? err.message : String(err) });
    return;
  }
  const answer = async ({ id, texts, opts }: EmbedRequest): Promise<void> => {
    let response: EmbedResponse;
    try {
      const out = await pipeline(texts, opts);
      // A copy, so the transfer below doesn't detach a buffer onnxruntime still owns.
      response = { id, data: new Float32Array(out.data) };
    } catch (err) {
      response = { id, error: err instanceof Error ? err.message : String(err) };
    }
    port.postMessage(response, 'data' in response ? [response.data.buffer as ArrayBuffer] : []);
  };
  port.postMessage({ type: 'ready' });
  port.on('message', (req: EmbedRequest) => void answer(req));
}

void main();
