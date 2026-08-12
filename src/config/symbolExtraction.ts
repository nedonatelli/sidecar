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

/** A parsed symbol reduced to what embedding needs: identity + line range. */
export interface RawSymbol {
  name: string;
  qualifiedName: string;
  kind: string;
  startLine: number;
  endLine: number;
}

/**
 * The shared core: turn a file's parsed symbols into embeddable inputs. Extracts
 * each symbol's body from the (capped) source line range and assigns ordinals.
 * Used by BOTH the workspace `SymbolIndexer` (which already parsed for its graph)
 * and the SWE-bench headless RAG — one body/ordinal convention, no divergence.
 */
export function symbolInputsFrom(relativePath: string, content: string, symbols: RawSymbol[]): SymbolEmbedInput[] {
  const lines = content.split('\n');
  const ordinals = assignOrdinals(symbols.map((s) => s.qualifiedName));
  const out: SymbolEmbedInput[] = [];
  symbols.forEach((s, i) => {
    const startIdx = Math.max(0, s.startLine - 1);
    const endIdx = Math.min(lines.length, s.endLine);
    if (endIdx <= startIdx) return;
    const body = lines.slice(startIdx, Math.min(endIdx, startIdx + MAX_BODY_LINES)).join('\n');
    if (!body.trim()) return;
    out.push({
      filePath: relativePath,
      qualifiedName: s.qualifiedName,
      name: s.name,
      kind: s.kind,
      startLine: s.startLine,
      endLine: s.endLine,
      body,
      ordinal: ordinals[i],
    });
  });
  return out;
}

/**
 * Parse a file's content into embeddable symbol inputs. Host-independent (no
 * `vscode`): parse → filter to symbol kinds → `symbolInputsFrom`. The headless
 * entry point (SWE-bench RAG); the product indexer parses for its graph already
 * and calls `symbolInputsFrom` directly with those symbols.
 */
export async function extractSymbolInputs(
  relativePath: string,
  content: string,
  maxSymbolsPerFile = 500,
): Promise<SymbolEmbedInput[]> {
  const ext = path.extname(relativePath).slice(1).toLowerCase();
  const analyzer = await getAnalyzer(ext);
  const parsed = analyzer.parseFileContent(relativePath, content);
  const syms: RawSymbol[] = parsed.elements
    .filter((el) => EMBEDDABLE_KINDS.has(el.type))
    .slice(0, maxSymbolsPerFile)
    .map((el) => ({
      name: el.name,
      qualifiedName: el.name,
      kind: el.type,
      startLine: el.startLine,
      endLine: el.endLine,
    }));
  return symbolInputsFrom(relativePath, content, syms);
}
