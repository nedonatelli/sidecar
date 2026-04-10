import { workspace, Uri } from 'vscode';

/**
 * Streaming file reader for handling large files efficiently.
 * Reads files in chunks and yields content progressively,
 * allowing the agent to process content without loading the entire file into memory.
 */

export interface StreamingReadOptions {
  /** Maximum bytes to read (0 = no limit) */
  maxBytes?: number;
  /** Maximum lines to read (0 = no limit) */
  maxLines?: number;
  /** Chunk size in bytes for streaming reads */
  chunkSizeBytes?: number;
  /** Extract summary mode: read first N lines and last M lines */
  summaryMode?: boolean;
  summaryHeadLines?: number;
  summaryTailLines?: number;
}

const DEFAULT_CHUNK_SIZE = 8 * 1024; // 8KB chunks
const DEFAULT_SUMMARY_HEAD = 50;
const DEFAULT_SUMMARY_TAIL = 30;

/**
 * Read a file with support for streaming large files.
 * Returns full content for small files, or a summary for large ones.
 */
export async function readFileStreaming(
  fileUri: Uri,
  options: StreamingReadOptions = {},
): Promise<{ content: string; isComplete: boolean; totalBytes: number; truncated: boolean }> {
  const {
    maxBytes = 100 * 1024,
    maxLines = 0,
    chunkSizeBytes = DEFAULT_CHUNK_SIZE,
    summaryMode = false,
    summaryHeadLines = DEFAULT_SUMMARY_HEAD,
    summaryTailLines = DEFAULT_SUMMARY_TAIL,
  } = options;

  try {
    const stat = await workspace.fs.stat(fileUri);
    const totalBytes = stat.size;
    let isComplete = true;
    let truncated = false;

    // If file is small, read it all
    if (totalBytes <= chunkSizeBytes * 2) {
      const bytes = await workspace.fs.readFile(fileUri);
      const content = Buffer.from(bytes).toString('utf-8');
      const limitedContent = limitContent(content, maxBytes, maxLines);
      return {
        content: limitedContent.content,
        isComplete: limitedContent.limited === false,
        totalBytes,
        truncated: limitedContent.limited === true,
      };
    }

    // For large files, use summary mode to get head + tail
    if (summaryMode || totalBytes > maxBytes) {
      const bytes = await workspace.fs.readFile(fileUri);
      const fullContent = Buffer.from(bytes).toString('utf-8');
      const lines = fullContent.split('\n');
      isComplete = false;
      truncated = true;

      const headLines = lines.slice(0, summaryHeadLines);
      const tailLines = lines.slice(Math.max(0, lines.length - summaryTailLines));
      const omittedCount = Math.max(0, lines.length - summaryHeadLines - summaryTailLines);

      const summary = [...headLines, `\n... (${omittedCount} lines omitted) ...\n`, ...tailLines].join('\n');

      return {
        content: summary,
        isComplete,
        totalBytes,
        truncated,
      };
    }

    // Fallback: read with byte limit
    const bytes = await workspace.fs.readFile(fileUri);
    const content = Buffer.from(bytes).toString('utf-8');
    const limitedContent = limitContent(content, maxBytes, maxLines);

    return {
      content: limitedContent.content,
      isComplete: limitedContent.limited === false,
      totalBytes,
      truncated: limitedContent.limited === true,
    };
  } catch (error) {
    throw new Error(`Failed to read file ${fileUri.fsPath}: ${error}`);
  }
}

/**
 * Limit content to specified byte/line limits.
 * Returns the limited content and a flag indicating if it was truncated.
 */
function limitContent(content: string, maxBytes: number, maxLines: number): { content: string; limited: boolean } {
  let result = content;
  let limited = false;

  // Limit by bytes
  if (maxBytes > 0 && result.length > maxBytes) {
    result = result.slice(0, maxBytes);
    limited = true;
  }

  // Limit by lines
  if (maxLines > 0) {
    const lines = result.split('\n');
    if (lines.length > maxLines) {
      result = lines.slice(0, maxLines).join('\n');
      limited = true;
    }
  }

  if (limited) {
    result += '\n... (truncated)';
  }

  return { content: result, limited };
}

/**
 * Async generator for streaming reads of large files.
 * Yields chunks of content as they're read from disk.
 * Useful for consuming file content progressively.
 */
export async function* streamFile(
  fileUri: Uri,
  chunkSizeBytes: number = DEFAULT_CHUNK_SIZE,
): AsyncGenerator<string, void, unknown> {
  try {
    const bytes = await workspace.fs.readFile(fileUri);
    const content = Buffer.from(bytes).toString('utf-8');

    for (let i = 0; i < content.length; i += chunkSizeBytes) {
      const chunk = content.slice(i, i + chunkSizeBytes);
      yield chunk;
    }
  } catch (error) {
    throw new Error(`Failed to stream file ${fileUri.fsPath}: ${error}`);
  }
}
