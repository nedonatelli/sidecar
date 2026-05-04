import { workspace, Uri } from 'vscode';
import * as fs from 'fs';

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
// Generous per-line byte estimate for ranged head/tail reads.
// Over-reading is harmless; under-reading would truncate lines.
const AVG_LINE_BYTES = 200;

/** Read [startByte, endByte) from a local file path using a file descriptor. */
async function readFileRange(filePath: string, startByte: number, endByte: number): Promise<string> {
  const length = endByte - startByte;
  if (length <= 0) return '';
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buf, 0, length, startByte);
    return buf.slice(0, bytesRead).toString('utf-8');
  } finally {
    await fd.close();
  }
}

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

    // For large files, use summary mode to get head + tail.
    // For local file:// URIs, use byte-offset reads so we never pull the
    // full file into memory. For other URI schemes (vscode-vfs://, etc.)
    // fall back to a full read since the fs module can't seek them.
    if (summaryMode || totalBytes > maxBytes) {
      isComplete = false;
      truncated = true;

      let headLines: string[];
      let tailLines: string[];
      let omittedCount: number;

      if (fileUri.scheme === 'file') {
        const headBudget = summaryHeadLines * AVG_LINE_BYTES;
        const tailBudget = summaryTailLines * AVG_LINE_BYTES;

        const [headChunk, tailChunk] = await Promise.all([
          readFileRange(fileUri.fsPath, 0, Math.min(headBudget, totalBytes)),
          readFileRange(fileUri.fsPath, Math.max(0, totalBytes - tailBudget), totalBytes),
        ]);

        const allHead = headChunk.split('\n');
        headLines = allHead.length > summaryHeadLines ? allHead.slice(0, summaryHeadLines) : allHead;

        const allTail = tailChunk.split('\n');
        // First element may be a partial line — drop it only when the read
        // didn't start at byte 0 (i.e. the tail window didn't cover the whole file).
        const tailStart = totalBytes > tailBudget && allTail.length > summaryTailLines ? 1 : 0;
        const rawTail = allTail.slice(tailStart);
        tailLines = rawTail.length > summaryTailLines ? rawTail.slice(rawTail.length - summaryTailLines) : rawTail;

        // Exact omitted count is unknown without a full read; use byte ratio as estimate.
        const headEndByte = headLines.join('\n').length;
        const tailStartByte = totalBytes - tailLines.join('\n').length;
        const omittedBytes = Math.max(0, tailStartByte - headEndByte);
        omittedCount = Math.round((omittedBytes / totalBytes) * (headLines.length + tailLines.length + 20));
      } else {
        const bytes = await workspace.fs.readFile(fileUri);
        const fullContent = Buffer.from(bytes).toString('utf-8');
        const lines = fullContent.split('\n');
        headLines = lines.slice(0, summaryHeadLines);
        tailLines = lines.slice(Math.max(0, lines.length - summaryTailLines));
        omittedCount = Math.max(0, lines.length - summaryHeadLines - summaryTailLines);
      }

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
