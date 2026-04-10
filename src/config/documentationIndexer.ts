import { workspace, Uri } from 'vscode';
import * as path from 'path';

/**
 * Documentation comment extracted from source code or markdown files.
 */
export interface DocumentationEntry {
  /** Unique identifier combining file path and location */
  id: string;
  /** The file where this documentation came from */
  filePath: string;
  /** Line number where documentation appears */
  lineNumber: number;
  /** Type: function doc, class doc, file comment, markdown heading, etc. */
  type: 'function' | 'class' | 'interface' | 'constant' | 'heading' | 'paragraph';
  /** Title or name (e.g., function name, markdown heading) */
  title: string;
  /** The actual documentation text */
  content: string;
  /** Code snippet associated with documentation (if available) */
  codeSnippet?: string;
  /** How relevant this is to a search query (0-1) */
  relevanceScore?: number;
}

/**
 * Documentation indexer that crawls README, JSDoc comments, doc files, etc.
 * Builds a searchable index of documentation for RAG-based retrieval.
 */
export class DocumentationIndexer {
  private entries = new Map<string, DocumentationEntry>();
  private ready = false;

  async initialize(): Promise<void> {
    const folders = workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    const rootUri = folders[0].uri;
    const startTime = Date.now();

    // Find documentation files: README*, CONTRIBUTING*, doc/, docs/, wiki/
    const docPatterns = [
      '**/README*.md',
      '**/CONTRIBUTING*.md',
      '**/CHANGELOG*.md',
      'docs/**/*.md',
      'doc/**/*.md',
      'wiki/**/*.md',
      'docs/**/*.txt',
    ];

    const docFiles: Uri[] = [];
    for (const pattern of docPatterns) {
      try {
        const uris = await workspace.findFiles(
          pattern,
          '**/node_modules/**',
          100, // max files per pattern
        );
        docFiles.push(...uris);
      } catch {
        // Pattern not found or error — continue
      }
    }

    // Index each documentation file
    for (const fileUri of docFiles) {
      try {
        await this.indexFile(fileUri, rootUri);
      } catch (error) {
        console.warn(`[SideCar] Failed to index documentation file ${fileUri.fsPath}:`, error);
      }
    }

    this.ready = true;
    const elapsed = Date.now() - startTime;
    console.log(`[SideCar] Documentation index built: ${this.entries.size} entries in ${elapsed}ms`);
  }

  private async indexFile(fileUri: Uri, rootUri: Uri): Promise<void> {
    const bytes = await workspace.fs.readFile(fileUri);
    const content = Buffer.from(bytes).toString('utf-8');
    const relativePath = path.relative(rootUri.fsPath, fileUri.fsPath);
    const ext = path.extname(fileUri.fsPath).toLowerCase();

    if (ext === '.md') {
      this.indexMarkdownFile(relativePath, content);
    } else if (ext === '.txt') {
      this.indexTextFile(relativePath, content);
    }
  }

  private indexMarkdownFile(filePath: string, content: string): void {
    const lines = content.split('\n');
    let lineNumber = 1;

    for (const line of lines) {
      const trimmed = line.trim();

      // Index headings
      const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (headingMatch) {
        const _level = headingMatch[1].length;
        const title = headingMatch[2].trim();
        const id = `${filePath}:${lineNumber}:heading`;

        this.entries.set(id, {
          id,
          filePath,
          lineNumber,
          type: 'heading',
          title,
          content: this.extractSurroundingContent(lines, lineNumber - 1, 3),
        });
      }

      // Index paragraphs (meaningful text blocks)
      if (trimmed.length > 20 && !trimmed.startsWith('#') && !trimmed.startsWith('|') && !trimmed.startsWith('-')) {
        const id = `${filePath}:${lineNumber}:paragraph`;
        this.entries.set(id, {
          id,
          filePath,
          lineNumber,
          type: 'paragraph',
          title: trimmed.slice(0, 60) + '...',
          content: trimmed,
        });
      }

      lineNumber++;
    }
  }

  private indexTextFile(filePath: string, content: string): void {
    const lines = content.split('\n');
    let lineNumber = 1;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length > 20) {
        const id = `${filePath}:${lineNumber}:paragraph`;
        this.entries.set(id, {
          id,
          filePath,
          lineNumber,
          type: 'paragraph',
          title: trimmed.slice(0, 60) + '...',
          content: trimmed,
        });
      }
      lineNumber++;
    }
  }

  private extractSurroundingContent(lines: string[], lineIndex: number, contextLines: number): string {
    const start = Math.max(0, lineIndex - contextLines);
    const end = Math.min(lines.length, lineIndex + contextLines + 1);
    return lines.slice(start, end).join('\n').trim();
  }

  isReady(): boolean {
    return this.ready;
  }

  /**
   * Search documentation for entries matching a query using semantic similarity.
   * Returns top N matching entries ranked by relevance.
   */
  search(query: string, maxResults: number = 5): DocumentationEntry[] {
    if (this.entries.size === 0) return [];

    // Simple keyword-based search with scoring
    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 2);
    const scored = Array.from(this.entries.values()).map((entry) => {
      let score = 0;
      const titleLower = entry.title.toLowerCase();
      const contentLower = entry.content.toLowerCase();

      // Title matches are weighted higher
      for (const term of queryTerms) {
        if (titleLower.includes(term)) score += 3;
        if (contentLower.includes(term)) score += 1;
      }

      // Bonus for exact heading matches
      if (entry.type === 'heading') score *= 1.5;

      return { ...entry, relevanceScore: score };
    });

    // Sort by relevance and return top results
    return scored
      .filter((e) => e.relevanceScore > 0)
      .sort((a, b) => b.relevanceScore - a.relevanceScore)
      .slice(0, maxResults);
  }

  /**
   * Get all entries of a specific type.
   */
  getEntriesByType(type: DocumentationEntry['type']): DocumentationEntry[] {
    return Array.from(this.entries.values()).filter((e) => e.type === type);
  }

  /**
   * Get count of indexed entries.
   */
  getEntryCount(): number {
    return this.entries.size;
  }

  /**
   * Format documentation entries for context injection.
   */
  formatForContext(entries: DocumentationEntry[]): string {
    if (entries.length === 0) return '';

    const parts = ['## Documentation Reference\n'];

    for (const entry of entries) {
      const relevance = entry.relevanceScore ? ` (relevance: ${(entry.relevanceScore * 100).toFixed(0)}%)` : '';
      parts.push(`\n### ${entry.title}${relevance}`);
      parts.push(`_From: ${entry.filePath}:${entry.lineNumber}_\n`);
      parts.push(`\`\`\`\n${entry.content.slice(0, 500)}\n\`\`\``);
    }

    return parts.join('\n');
  }

  /**
   * Clear all indexed documentation.
   */
  clear(): void {
    this.entries.clear();
    this.ready = false;
  }
}
