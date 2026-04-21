/**
 * Source abstraction layer (v0.75).
 *
 * Shared plumbing for all external content ingestion: PDF, web, YouTube,
 * audio. Each concrete source implements `Source` and emits `SourceDocument`
 * chunks. The registry dispatches by URI so callers don't need to know which
 * source handles which protocol or file type.
 *
 * Designed to double as the foundation for the v0.82 NotebookLM mode — keep
 * the interface stable and additive.
 */

/**
 * A discrete chunk of content extracted from an external source.
 * One source (e.g. a PDF) typically emits many documents (one per page chunk).
 */
export interface SourceDocument {
  /** Stable, globally unique id. Convention: `<sourceType>:<uri>:<chunkIndex>` */
  id: string;
  /** Human-readable title — document title, page heading, or filename. */
  title: string;
  /** Extracted plain-text content for this chunk. */
  content: string;
  /** Source-specific metadata (author, year, page number, URL, etc.). */
  metadata: Record<string, unknown>;
  /** Which source type produced this document. */
  sourceType: SourceType;
  /** The original URI (file path, URL, Zotero key, etc.). */
  uri: string;
  /** Zero-based chunk index within the parent document. */
  chunkIndex: number;
}

export type SourceType = 'pdf' | 'web' | 'youtube' | 'audio' | 'zotero';

/**
 * A content source that can extract `SourceDocument` chunks from a URI.
 * Implementations live in `src/sources/<type>Source.ts`.
 */
export interface Source {
  /** Matches `SourceDocument.sourceType` for all documents this source emits. */
  readonly sourceType: SourceType;

  /** Return true if this source can handle the given URI. */
  canHandle(uri: string): boolean;

  /**
   * Extract content from `uri` as an async stream of chunks.
   * Implementations should respect `signal` and stop early on abort.
   */
  extract(uri: string, signal?: AbortSignal): AsyncGenerator<SourceDocument>;
}
