import { DocumentationIndexer, type DocumentationEntry } from '../../config/documentationIndexer.js';
import type { EmbeddingIndex } from '../../config/embeddingIndex.js';
import type { RetrievalHit } from './retriever.js';
import { EmbeddedEntryRetriever } from './embeddedEntryRetriever.js';

const MAX_CONTENT_CHARS = 500;
const MAX_EMBED_CHARS = 2048;

/**
 * Retriever for the documentation indexer.
 *
 * When an EmbeddingIndex is supplied and the model is ready, entries are
 * embedded lazily and searched by cosine similarity; new/edited entries are
 * picked up on the next retrieve (see EmbeddedEntryRetriever). Falls back to
 * the keyword scorer inside DocumentationIndexer when the model isn't ready.
 */
export class DocRetriever extends EmbeddedEntryRetriever<DocumentationEntry> {
  name = 'docs';

  constructor(
    private indexer: DocumentationIndexer,
    embeddingIndex?: EmbeddingIndex | null,
  ) {
    super(embeddingIndex);
  }

  isReady(): boolean {
    return this.indexer.isReady();
  }

  protected getAllEntries(): DocumentationEntry[] {
    return this.indexer.getAll();
  }
  protected entryId(entry: DocumentationEntry): string {
    return entry.id;
  }
  protected embedText(entry: DocumentationEntry): string {
    return `${entry.title}\n${entry.content}`.slice(0, MAX_EMBED_CHARS);
  }
  protected toHit(entry: DocumentationEntry, score: number): RetrievalHit {
    return entryToHit(entry, score, this.name);
  }
  protected fallbackSearch(query: string, k: number): RetrievalHit[] {
    return this.indexer.search(query, k).map((e) => entryToHit(e, e.relevanceScore ?? 0, this.name));
  }
}

function entryToHit(entry: DocumentationEntry, score: number, source: string): RetrievalHit {
  const content =
    `### ${entry.title}\n` +
    `_From: ${entry.filePath}:${entry.lineNumber}_\n\n` +
    '```\n' +
    entry.content.slice(0, MAX_CONTENT_CHARS) +
    '\n```';
  return {
    id: `docs:${entry.filePath}:${entry.lineNumber}`,
    score,
    content,
    source,
    title: entry.title,
    filePath: entry.filePath,
  };
}
