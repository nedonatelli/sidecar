// ---------------------------------------------------------------------------
// Headless RAG for SWE-bench — the REAL product retrieval, not a keyword toy.
//
// Builds SideCar's symbol-embedding index (local MiniLM, tree-sitter symbols)
// over a repo and retrieves the top-k relevant symbols for the issue. Replaces
// the old bag-of-words-over-file-heads retriever, which ranked files by keyword
// density and showed only the first 40 lines — so a fix site whose relevant line
// is deep in the file (e.g. global_settings.py:307) was surfaced with a snippet
// that hid why it mattered. Here the retrieved unit IS the symbol body.
//
// Runs under the eval's vitest config (which mocks `vscode`); the index itself
// uses no vscode APIs. See bench/swe/ENVIRONMENT-SCOPING.md / the RAG audit.
// ---------------------------------------------------------------------------
import * as fs from 'fs';
import * as path from 'path';
import { SymbolEmbeddingIndex } from '../../src/config/symbolEmbeddingIndex.js';
import { extractSymbolInputs } from '../../src/config/symbolExtraction.js';
import { setGrammarsPath } from '../../src/parsing/registry.js';

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'build',
  'dist',
  '.tox',
  '.eggs',
  '__pycache__',
  'docs',
  'venvs',
  // Don't index the repo's tests: the agent shouldn't be pointed at test files
  // (the hidden acceptance tests live there), and test functions named after a
  // feature otherwise drown the actual source in retrieval.
  'tests',
  'test',
]);
// SWE-bench_Lite is Python; index .py sources.
const CODE_EXT = /\.pyi?$/;
const MAX_FILE_BYTES = 400_000;

export interface RetrievalHit {
  filePath: string;
  name: string;
  startLine: number;
  endLine: number;
  similarity: number;
}

/** Build the product's symbol-embedding index over `dir`, in-memory (no cache
 *  dir). Walk → parse → embed every symbol, then drain the embed queue. */
export async function buildRepoIndex(dir: string, maxFiles = 4000): Promise<SymbolEmbeddingIndex> {
  // Load the real tree-sitter grammars (the product does this at activation; the
  // eval must too, or getAnalyzer silently falls back to the regex analyzer,
  // which can't see Python module-level constants like a settings default).
  setGrammarsPath(process.env.SIDECAR_GRAMMARS_PATH || path.resolve('grammars'));
  const index = new SymbolEmbeddingIndex(null);
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (files.length >= maxFiles) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(rel, e.name));
      } else if (CODE_EXT.test(e.name)) {
        files.push(path.join(rel, e.name).split(path.sep).join('/'));
      }
    }
  };
  walk('');
  for (const rel of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(dir, rel), 'utf-8');
    } catch {
      continue;
    }
    if (content.length > MAX_FILE_BYTES) continue;
    for (const sym of await extractSymbolInputs(rel, content)) index.queueSymbol(sym);
  }
  await index.flushQueueForTests();
  return index;
}

/**
 * Retrieve the top-k relevant symbols for the issue and render an orientation
 * block containing each symbol's REAL body (the line range that matched), not a
 * file header. Returns the hits too, for the localization metric.
 */
export async function retrieveContext(
  index: SymbolEmbeddingIndex,
  query: string,
  dir: string,
  topK = 6,
): Promise<{ hits: RetrievalHit[]; context: string }> {
  const results = await index.search(query, topK);
  const hits: RetrievalHit[] = results.map((r) => ({
    filePath: r.filePath,
    name: r.name,
    startLine: r.startLine,
    endLine: r.endLine,
    similarity: r.similarity,
  }));
  if (hits.length === 0) return { hits, context: '' };
  const lines = ['Symbols in this repository most relevant to the issue (semantic retrieval — start here):'];
  for (const h of hits) {
    lines.push(`\n### ${h.filePath} :: ${h.name} (lines ${h.startLine}-${h.endLine})`);
    try {
      const src = fs
        .readFileSync(path.join(dir, h.filePath), 'utf-8')
        .split('\n')
        .slice(Math.max(0, h.startLine - 1), h.endLine)
        .join('\n');
      lines.push('```python\n' + src.slice(0, 1500) + '\n```');
    } catch {
      /* unreadable — skip snippet */
    }
  }
  return { hits, context: lines.join('\n') };
}

/** Localization metric: was any file touched by the gold patch retrieved in the
 *  top-k? Turns SWE-bench into a RAG benchmark (fix-file recall@k). */
export function goldFilesInTopK(
  hits: RetrievalHit[],
  goldPatch: string,
): { goldFiles: string[]; hitFiles: string[]; recalled: boolean } {
  const goldFiles = Array.from(
    new Set((goldPatch.match(/^\+\+\+ b\/(.+)$/gm) ?? []).map((l) => l.replace(/^\+\+\+ b\//, '').trim())),
  );
  const hitFiles = new Set(hits.map((h) => h.filePath));
  const recalled = goldFiles.some((f) => hitFiles.has(f));
  return { goldFiles, hitFiles: hits.map((h) => h.filePath), recalled };
}
