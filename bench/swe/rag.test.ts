import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { retrieveContext, goldFilesInTopK } from './rag.js';
import type { SymbolEmbeddingIndex } from '../../src/config/symbolEmbeddingIndex.js';

// ---------------------------------------------------------------------------
// Characterisation tests for the retrieval layer.
//
// rag.ts was the only SWE-specific module with no tests, and it is the one whose
// behaviour is about to change: the SWE harness injects `retrieveContext`'s
// output into EVERY task (2,722-9,633 chars observed), while the agent harness
// leaves it opt-in. Measured 2026-08-19, that injection took a case from 10/10
// to 4/10 (p=0.011) — so unification will make it opt-in there too, and these
// tests pin what the function does before that move.
// ---------------------------------------------------------------------------

/** Stub index — the real one needs an embedding model; the rendering does not. */
const stubIndex = (
  results: { filePath: string; name: string; startLine: number; endLine: number; similarity: number }[],
): SymbolEmbeddingIndex => ({ search: async () => results }) as unknown as SymbolEmbeddingIndex;

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ragtest-'));
  fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'pkg', 'mod.py'),
    ['def alpha():', '    return 1', '', 'def beta():', '    return 2', ''].join('\n'),
  );
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('retrieveContext', () => {
  it('returns an EMPTY context when nothing is retrieved', async () => {
    // The distinction that matters when reading a sweep: "orientation was empty"
    // is a different fact from "orientation was unhelpful".
    const r = await retrieveContext(stubIndex([]), 'anything', dir);
    expect(r.hits).toEqual([]);
    expect(r.context).toBe('');
  });

  it('renders the real symbol body, not a file header', async () => {
    const r = await retrieveContext(
      stubIndex([{ filePath: 'pkg/mod.py', name: 'beta', startLine: 4, endLine: 5, similarity: 0.9 }]),
      'beta',
      dir,
    );
    expect(r.context).toContain('pkg/mod.py :: beta (lines 4-5)');
    expect(r.context).toContain('def beta():');
    expect(r.context).toContain('return 2');
    expect(r.context).not.toContain('def alpha'); // only the matched range
  });

  it('survives an unreadable file by skipping the snippet, not throwing', async () => {
    const r = await retrieveContext(
      stubIndex([{ filePath: 'gone/missing.py', name: 'x', startLine: 1, endLine: 2, similarity: 0.5 }]),
      'x',
      dir,
    );
    expect(r.context).toContain('gone/missing.py :: x');
    expect(r.hits).toHaveLength(1);
  });

  it('caps each snippet so one huge symbol cannot dominate the window', async () => {
    fs.writeFileSync(path.join(dir, 'big.py'), Array.from({ length: 400 }, (_, i) => `# line ${i}`).join('\n'));
    const r = await retrieveContext(
      stubIndex([{ filePath: 'big.py', name: 'big', startLine: 1, endLine: 400, similarity: 0.9 }]),
      'big',
      dir,
    );
    const fence = r.context.split('```python\n')[1].split('\n```')[0];
    expect(fence.length).toBeLessThanOrEqual(1500);
  });

  it('passes topK through to the index', async () => {
    let asked = -1;
    const idx = {
      search: async (_q: string, k: number) => {
        asked = k;
        return [];
      },
    } as unknown as SymbolEmbeddingIndex;
    await retrieveContext(idx, 'q', dir, 3);
    expect(asked).toBe(3);
  });
});

describe('goldFilesInTopK', () => {
  const patch = ['--- a/pkg/mod.py', '+++ b/pkg/mod.py', '@@ -1 +1 @@', '-x', '+y'].join('\n');

  it('reports recall when a gold file is among the hits', () => {
    const r = goldFilesInTopK(
      [{ filePath: 'pkg/mod.py', name: 'beta', startLine: 1, endLine: 2, similarity: 0.9 }],
      patch,
    );
    expect(r).toMatchObject({ goldFiles: ['pkg/mod.py'], recalled: true });
  });

  it('reports a miss when retrieval found other files', () => {
    // The measured case: recall missed the gold file 29% of the time, and the
    // harness injected the wrong context anyway.
    const r = goldFilesInTopK(
      [{ filePath: 'other/thing.py', name: 'z', startLine: 1, endLine: 2, similarity: 0.9 }],
      patch,
    );
    expect(r.recalled).toBe(false);
    expect(r.hitFiles).toEqual(['other/thing.py']);
  });

  it('deduplicates gold files across multiple hunks of one file', () => {
    const multi = [patch, '--- a/pkg/mod.py', '+++ b/pkg/mod.py', '@@ -9 +9 @@', '-a', '+b'].join('\n');
    expect(goldFilesInTopK([], multi).goldFiles).toEqual(['pkg/mod.py']);
  });

  it('treats a patch with no +++ headers as having no gold files', () => {
    expect(goldFilesInTopK([], 'not a diff').goldFiles).toEqual([]);
  });
});
