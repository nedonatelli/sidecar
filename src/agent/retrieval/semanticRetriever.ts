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
 */
const DEFAULT_MAX_CHARS_PER_FILE = 3000;

export class SemanticRetriever implements Retriever {
  name = 'workspace';

  constructor(
    private index: WorkspaceIndex,
    private activeFilePath?: string,
    private maxCharsPerFile: number = DEFAULT_MAX_CHARS_PER_FILE,
  ) {}

  isReady(): boolean {
    return this.index.isReady();
  }

  async retrieve(query: string, k: number): Promise<RetrievalHit[]> {
    if (!this.isReady()) return [];
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
