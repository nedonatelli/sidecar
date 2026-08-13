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
import { SymbolEmbeddingIndex, type SymbolMetadata } from '../../src/config/symbolEmbeddingIndex.js';
import { FlatVectorStore } from '../../src/config/vectorStore.js';
import { extractSymbolInputs } from '../../src/config/symbolExtraction.js';
import { setGrammarsPath } from '../../src/parsing/registry.js';

/** MiniLM all-MiniLM-L6-v2 embedding dimension — the model the index uses. */
const RAG_DIM = 384;
/** Bump when the build (walk/extract/embed) changes in a way that invalidates cached vectors. */
const RAG_CACHE_VERSION = 1;

/** A fresh in-memory vector store (null SidecarDir → its own persist/restore is a
 *  no-op; this module does its own plain-file caching so the eval doesn't depend
 *  on the vscode-coupled SidecarDir path machinery). */
function makeStore(): FlatVectorStore<SymbolMetadata> {
  return new FlatVectorStore<SymbolMetadata>(null, {
    dimension: RAG_DIM,
    version: RAG_CACHE_VERSION,
    binFile: 'unused',
    metaFile: 'unused',
  });
}

const BASE_SKIP_DIRS = ['.git', 'node_modules', 'build', 'dist', '.tox', '.eggs', '__pycache__', 'docs', 'venvs'];
// Every language getAnalyzer can parse — so this indexer serves both the Python
// SWE-bench repos and the llm-eval TS/JS fixtures (one builder, no divergence).
const CODE_EXT = /\.(py|pyi|ts|tsx|js|jsx|mjs|cjs|java|go|rs|rb|c|h|cc|cpp|hpp|cs|php|swift|kt|scala|dart|vue)$/;
const MAX_FILE_BYTES = 400_000;

export interface BuildIndexOptions {
  maxFiles?: number;
  /** Skip test directories. True for SWE-bench (don't point the agent at the
   *  hidden acceptance tests; test functions otherwise drown the source). False
   *  for small llm-eval fixtures, where excluding a `test/` dir loses signal. */
  skipTestDirs?: boolean;
}

export interface RetrievalHit {
  filePath: string;
  name: string;
  startLine: number;
  endLine: number;
  similarity: number;
}

/** Walk → parse → embed every symbol into `index`, then drain the embed queue. */
async function indexRepoInto(index: SymbolEmbeddingIndex, dir: string, opts: BuildIndexOptions): Promise<void> {
  const maxFiles = opts.maxFiles ?? 4000;
  const skipDirs = new Set(opts.skipTestDirs === false ? BASE_SKIP_DIRS : [...BASE_SKIP_DIRS, 'tests', 'test']);
  // Load the real tree-sitter grammars (the product does this at activation; the
  // eval must too, or getAnalyzer silently falls back to the regex analyzer,
  // which can't see Python module-level constants like a settings default).
  setGrammarsPath(process.env.SIDECAR_GRAMMARS_PATH || path.resolve('grammars'));
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (files.length >= maxFiles) return;
      if (e.isDirectory()) {
        if (!skipDirs.has(e.name)) walk(path.join(rel, e.name));
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
}

/** Build the product's symbol-embedding index over `dir`, in-memory. */
export async function buildRepoIndex(dir: string, opts: BuildIndexOptions = {}): Promise<SymbolEmbeddingIndex> {
  const index = new SymbolEmbeddingIndex(null, makeStore());
  await indexRepoInto(index, dir, opts);
  return index;
}

interface RagCacheEntry {
  id: string;
  metadata: SymbolMetadata;
  offset: number;
}
interface RagCacheMeta {
  version: number;
  dim: number;
  entries: RagCacheEntry[];
}

/** Reload a persisted index (vectors + metadata) into `store` without re-embedding.
 *  Returns the entry count, or -1 when no valid cache exists. */
async function loadCache(store: FlatVectorStore<SymbolMetadata>, prefix: string): Promise<number> {
  const metaPath = `${prefix}.meta.json`;
  const binPath = `${prefix}.vec.bin`;
  if (!fs.existsSync(metaPath) || !fs.existsSync(binPath)) return -1;
  let meta: RagCacheMeta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as RagCacheMeta;
  } catch {
    return -1;
  }
  if (meta.version !== RAG_CACHE_VERSION || meta.dim !== RAG_DIM) return -1;
  const buf = fs.readFileSync(binPath);
  if (buf.byteLength < meta.entries.length * RAG_DIM * 4) return -1;
  // Copy into a fresh, 4-byte-aligned ArrayBuffer — a Node Buffer's byteOffset
  // isn't guaranteed aligned, and Float32Array views require it.
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const vecs = new Float32Array(ab);
  for (const e of meta.entries) {
    const start = e.offset * RAG_DIM;
    // upsert copies the vector, so the subarray view is safe to reuse.
    await store.upsert({ id: e.id, vector: vecs.subarray(start, start + RAG_DIM), metadata: e.metadata });
  }
  return meta.entries.length;
}

/** Persist the built store's vectors + metadata as a plain .meta.json + .vec.bin pair. */
function saveCache(store: FlatVectorStore<SymbolMetadata>, prefix: string): void {
  const ids = [...store.entries()];
  const vecArr = new Float32Array(ids.length * RAG_DIM);
  const entries: RagCacheEntry[] = [];
  ids.forEach((e, i) => {
    const v = store.getVector(e.id);
    if (v) vecArr.set(v, i * RAG_DIM);
    entries.push({ id: e.id, metadata: e.metadata, offset: i });
  });
  fs.mkdirSync(path.dirname(prefix), { recursive: true });
  fs.writeFileSync(`${prefix}.vec.bin`, Buffer.from(vecArr.buffer, vecArr.byteOffset, vecArr.byteLength));
  const meta: RagCacheMeta = { version: RAG_CACHE_VERSION, dim: RAG_DIM, entries };
  fs.writeFileSync(`${prefix}.meta.json`, JSON.stringify(meta));
}

/**
 * Build the repo index, OR reload it from a disk cache keyed by `cacheFilePrefix`.
 * The in-memory build (walk → tree-sitter parse → MiniLM embed of every symbol)
 * is ~5–8 min for django; a reload is a few seconds (just the query-embedder
 * model load + upsert of precomputed vectors). Caller owns the key — include repo
 * + commit + maxFiles so a stale checkout or a narrower build never reuses a
 * mismatched cache. On any cache miss/corruption it rebuilds and rewrites.
 */
export async function loadOrBuildRepoIndex(
  dir: string,
  cacheFilePrefix: string,
  opts: BuildIndexOptions = {},
): Promise<SymbolEmbeddingIndex> {
  const store = makeStore();
  const loaded = await loadCache(store, cacheFilePrefix);
  if (loaded > 0) {
    const index = new SymbolEmbeddingIndex(null, store);
    // The build path warms the query embedder via flushQueueForTests; a pure
    // cache-load skips it, so search() would short-circuit on !isReady(). A warmup
    // embed loads the MiniLM model (via LazyEmbedder.ensureReady) so isReady() is
    // true and the upserted vectors are searchable.
    await index.embed('warmup');
    return index;
  }
  const index = new SymbolEmbeddingIndex(null, store);
  await indexRepoInto(index, dir, opts);
  try {
    saveCache(store, cacheFilePrefix);
  } catch {
    /* best-effort — a cache write failure must not fail the run */
  }
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
