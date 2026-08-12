import * as path from 'path';
import { getAnalyzer } from '../parsing/registry.js';
import type { CodeElement } from '../astContext.js';
import { assignOrdinals, type SymbolEmbedInput } from './symbolEmbeddingIndex.js';

// Element kinds worth embedding as retrievable symbols (imports/exports are edges,
// not searchable bodies). Module-level `variable`s matter — e.g. a settings default
// like `FILE_UPLOAD_PERMISSIONS = None` is exactly the kind of one-line symbol a
// keyword-over-file-heads retriever misses.
const EMBEDDABLE_KINDS: ReadonlySet<CodeElement['type']> = new Set([
  'function',
  'class',
  'method',
  'interface',
  'type',
  'enum',
  'variable',
]);
const MAX_BODY_LINES = 400;

/**
 * Parse a file's content into embeddable symbol inputs. The host-independent core
 * shared by the workspace `SymbolIndexer` and the SWE-bench headless RAG so both
 * index symbols identically — the body is the (capped) source line range, matching
 * the product indexer. No `vscode` dependency: pure parse + slice.
 */
export async function extractSymbolInputs(
  relativePath: string,
  content: string,
  maxSymbolsPerFile = 500,
): Promise<SymbolEmbedInput[]> {
  const ext = path.extname(relativePath).slice(1).toLowerCase();
  const analyzer = await getAnalyzer(ext);
  const parsed = analyzer.parseFileContent(relativePath, content);
  const lines = content.split('\n');
  const syms = parsed.elements.filter((el) => EMBEDDABLE_KINDS.has(el.type)).slice(0, maxSymbolsPerFile);
  const ordinals = assignOrdinals(syms.map((s) => s.name));
  const out: SymbolEmbedInput[] = [];
  syms.forEach((el, i) => {
    const startIdx = Math.max(0, el.startLine - 1);
    const endIdx = Math.min(lines.length, el.endLine);
    if (endIdx <= startIdx) return;
    const body = lines.slice(startIdx, Math.min(endIdx, startIdx + MAX_BODY_LINES)).join('\n');
    if (!body.trim()) return;
    out.push({
      filePath: relativePath,
      qualifiedName: el.name,
      name: el.name,
      kind: el.type,
      startLine: el.startLine,
      endLine: el.endLine,
      body,
      ordinal: ordinals[i],
    });
  });
  return out;
}
