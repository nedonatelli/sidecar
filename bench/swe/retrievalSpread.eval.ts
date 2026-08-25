import { describe, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildRepoIndex, retrieveContext } from './rag.js';
import {
  LARGE_FILE_EDIT_CASES,
  UNDERSPECIFIED_CASES,
  DISTINCT_SYMBOL_CASES,
} from '../../tests/llm-eval/largeFileEditCases.js';

// ---------------------------------------------------------------------------
// What the similarity distribution actually looks like when retrieval helps
// versus when it harms.
//
// Injecting top-6 costs 90% -> 55% on `large-file-no-path` (p=0.031) and costs
// nothing on `distinct-no-path` (15/20 both arms). Same retriever, same k, same
// prompt — so the difference is in what came back, and a gate has to key on
// something observable in the hits themselves.
//
// This prints the distributions rather than asserting a threshold: the numbers
// come from a MiniLM embedding and will move if the embedder does, so the
// threshold has to be re-measured, not remembered.
// ---------------------------------------------------------------------------

const CASES = [...UNDERSPECIFIED_CASES, ...DISTINCT_SYMBOL_CASES, ...LARGE_FILE_EDIT_CASES];

describe('retrieval similarity spread', () => {
  for (const id of ['large-file-no-path', 'distinct-no-path']) {
    it(`reports the top-6 distribution for ${id}`, async () => {
      const c = CASES.find((x) => x.id === id)!;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spread-'));
      try {
        for (const [rel, content] of Object.entries(c.workspace as Record<string, string>)) {
          fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
          fs.writeFileSync(path.join(dir, rel), content);
        }
        const index = await buildRepoIndex(dir);
        const { hits } = await retrieveContext(index, c.userMessage, dir, 6);

        console.error(`\n=== ${id} ===`);
        hits.forEach((h, i) => {
          const gap = i > 0 ? `  (gap from #1: ${(hits[0].similarity - h.similarity).toFixed(4)})` : '';
          console.error(`  ${i + 1}. ${h.similarity.toFixed(4)}  ${h.filePath} :: ${h.name}${gap}`);
        });
        if (hits.length > 1) {
          console.error(`  gap #1->#2 : ${(hits[0].similarity - hits[1].similarity).toFixed(4)}`);
          console.error(
            `  band #1->#${hits.length} : ${(hits[0].similarity - hits[hits.length - 1].similarity).toFixed(4)}`,
          );
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }, 600_000);
  }
});
