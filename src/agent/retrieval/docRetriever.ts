import { DocumentationIndexer } from '../../config/documentationIndexer';
import { Retriever, RetrievalHit } from './retriever';

/**
 * Retriever adapter for the keyword-based documentation indexer.
 *
 * Rendered content mirrors the existing `formatForContext` shape so
 * fused output reads the same whether or not fusion selected this hit
 * alongside others.
 */
export class DocRetriever implements Retriever {
  name = 'docs';

  constructor(private indexer: DocumentationIndexer) {}

  isReady(): boolean {
    return this.indexer.isReady();
  }

  async retrieve(query: string, k: number): Promise<RetrievalHit[]> {
    if (!this.isReady()) return [];
    const entries = this.indexer.search(query, k);
    return entries.map((entry) => {
      const relevance = entry.relevanceScore ? ` (relevance: ${(entry.relevanceScore * 100).toFixed(0)}%)` : '';
      const content =
        `### ${entry.title}${relevance}\n` +
        `_From: ${entry.filePath}:${entry.lineNumber}_\n\n` +
        '```\n' +
        entry.content.slice(0, 500) +
        '\n```';
      return {
        id: `docs:${entry.filePath}:${entry.lineNumber}`,
        score: entry.relevanceScore ?? 0,
        content,
        source: this.name,
        title: entry.title,
        filePath: entry.filePath,
      };
    });
  }
}
