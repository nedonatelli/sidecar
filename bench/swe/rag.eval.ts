import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { buildRepoIndex, retrieveContext, goldFilesInTopK } from './rag.js';

const REPO = process.env.SIDECAR_RAG_REPO;
const TASK = process.env.SIDECAR_RAG_TASK;

describe.skipIf(!REPO || !TASK)('headless RAG localization', () => {
  it('surfaces the gold fix file in the top-k', async () => {
    const task = JSON.parse(
      fs
        .readFileSync(TASK as string, 'utf-8')
        .trim()
        .split('\n')[0],
    );
    const t0 = Date.now();
    const index = await buildRepoIndex(REPO as string);
    const { hits } = await retrieveContext(index, task.problem_statement, REPO as string, 8);
    const loc = goldFilesInTopK(hits, task.patch);
    console.info('[rag] built + searched in', Math.round((Date.now() - t0) / 1000), 's');
    console.info(
      '[rag] top-8:\n  ' + hits.map((h) => `${h.filePath} :: ${h.name} (${h.similarity.toFixed(3)})`).join('\n  '),
    );
    console.info('[rag] gold files:', loc.goldFiles, '| recalled@8:', loc.recalled);
    expect(loc.recalled).toBe(true);
  }, 900_000);
});
