import { WorkspaceIndex } from '../../config/workspaceIndex';
import { Retriever, RetrievalHit } from './retriever';

/**
 * Retriever adapter for workspace files. Uses WorkspaceIndex's existing
 * heuristic + semantic blend to rank files, then reads the top-K file
 * contents and emits them as hits so reciprocal-rank fusion can compete
 * them against documentation and memory hits under a shared budget.
 *
 * Content is capped at a configurable number of characters per file so
 * a single large file can't dominate the fused output. The cap defaults
 * to 3000 chars — enough to preserve a small module or the top of a
 * larger one while staying comparable in size to a doc or memory snippet.
 *
 * v0.62 c.1 — PKI migration: when the workspace index has a symbol-level
 * embedding index wired (the new [`SymbolEmbeddingIndex`](../../config/symbolEmbeddingIndex.ts)
 * from v0.61 PKI), the retriever prefers symbol-level hits over file-
 * level hits because symbol-granularity results fill the agent's
 * context window more precisely — one function body is a tighter
 * "evidence unit" for RAG than a 3000-char file head. File-level
 * ranking stays as the fallback so pre-PKI behavior is preserved when
 * the symbol index is disabled, still warming, or has no entries yet.
 */
const DEFAULT_MAX_CHARS_PER_FILE = 3000;
const DEFAULT_MAX_CHARS_PER_SYMBOL = 1500;

export class SemanticRetriever implements Retriever {
  name = 'workspace';

  constructor(
    private index: WorkspaceIndex,
    private activeFilePath?: string,
    private maxCharsPerFile: number = DEFAULT_MAX_CHARS_PER_FILE,
    private maxCharsPerSymbol: number = DEFAULT_MAX_CHARS_PER_SYMBOL,
  ) {}

  isReady(): boolean {
    return this.index.isReady();
  }

  async retrieve(query: string, k: number): Promise<RetrievalHit[]> {
    if (!this.isReady()) return [];

    // Prefer symbol-level retrieval when PKI is wired + ready + has
    // at least one symbol indexed. Any of those falling false drops
    // us into the v0.61-and-earlier file-level path.
    const symbolHits = await this.retrieveViaSymbolIndex(query, k);
    if (symbolHits !== null) return symbolHits;

    return this.retrieveViaFileIndex(query, k);
  }

  /**
   * Symbol-level retrieval — returns null when PKI isn't available so
   * the caller knows to fall through. Non-null return means we used
   * symbols (even if it's an empty array, which means "searched but
   * no match" — still a PKI result, don't double-up with file-level).
   */
  private async retrieveViaSymbolIndex(query: string, k: number): Promise<RetrievalHit[] | null> {
    const symEmb = this.index.getSymbolEmbeddings();
    if (!symEmb || !symEmb.isReady() || symEmb.getCount() === 0) return null;

    const results = await symEmb.search(query, k);
    const hits: RetrievalHit[] = [];
    for (const r of results) {
      // Load the containing file's content so we can extract the
      // symbol body. Reading the file once per hit is fine — cache
      // lookups in WorkspaceIndex mean repeated reads of the same
      // file are cheap after the first.
      const fileContent = await this.index.loadFileContent(r.filePath);
      const body = sliceSymbolBody(fileContent, r.startLine, r.endLine);
      if (!body) continue;
      const truncated =
        body.length > this.maxCharsPerSymbol
          ? body.slice(0, this.maxCharsPerSymbol) + '\n... (symbol truncated)'
          : body;
      hits.push({
        // Distinct ID prefix so the RRF fusion layer dedupes across
        // symbol hits (one per symbol) without collapsing them against
        // legacy file-level hits that may still arrive from a parallel
        // non-PKI retriever in a hybrid test setup.
        id: `workspace-sym:${r.filePath}::${r.qualifiedName}`,
        score: r.similarity,
        content: `### ${r.filePath}:${r.startLine}-${r.endLine} (${r.kind} ${r.qualifiedName})\n\`\`\`\n${truncated}\n\`\`\``,
        source: this.name,
        filePath: r.filePath,
      });
    }
    return hits;
  }

  /** Legacy pre-PKI file-level retrieval, unchanged from v0.61. */
  private async retrieveViaFileIndex(query: string, k: number): Promise<RetrievalHit[]> {
    const ranked = await this.index.rankFiles(query, this.activeFilePath);
    const top = ranked.slice(0, k);
    const hits: RetrievalHit[] = [];
    for (const file of top) {
      const content = await this.index.loadFileContent(file.relativePath);
      if (!content) continue;
      const truncated =
        content.length > this.maxCharsPerFile
          ? content.slice(0, this.maxCharsPerFile) + '\n... (file truncated)'
          : content;
      hits.push({
        id: `workspace:${file.relativePath}`,
        score: file.score,
        content: `### ${file.relativePath}\n\`\`\`\n${truncated}\n\`\`\``,
        source: this.name,
        filePath: file.relativePath,
      });
    }
    return hits;
  }
}

/**
 * Extract a symbol's body from a file's full content by 1-based
 * inclusive line range. Returns empty string when the file is null
 * or the range is out of bounds — mirrors the caller-tolerant shape
 * the rest of the retrieval layer expects.
 */
function sliceSymbolBody(fileContent: string | null, startLine: number, endLine: number): string {
  if (!fileContent) return '';
  const lines = fileContent.split('\n');
  const startIdx = Math.max(0, startLine - 1);
  const endIdx = Math.min(lines.length, endLine);
  if (endIdx <= startIdx) return '';
  return lines.slice(startIdx, endIdx).join('\n');
}
