/**
 * Paragraph-aware text chunker for prose documents (markdown, plain text, RST).
 *
 * Splits on blank-line paragraph boundaries — never mid-paragraph — and
 * produces overlapping windows so a retrieval query that spans a paragraph
 * boundary still has a high-scoring chunk on both sides. For markdown files,
 * the nearest heading above each chunk is prepended so the embedding captures
 * section context even after splitting.
 *
 * Deliberately has zero imports so it can run in any environment and be
 * tested without mocks.
 */

export interface TextChunk {
  /** Stable id: `${filePath}:${startLine}` (deduplicated with index suffix when needed). */
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /**
   * Text sent to the embedding model. For markdown sections the nearest
   * heading is prepended so the chunk carries section context.
   */
  content: string;
  /** Nearest markdown heading above this chunk, if any. */
  heading?: string;
}

export interface ChunkOptions {
  /** Target character count per chunk. Default 1000. */
  chunkSize?: number;
  /** Character overlap between adjacent chunks. Default 200. Clamped to ≤ chunkSize/2. */
  overlap?: number;
}

const CHUNK_SIZE_DEFAULT = 1000;
const OVERLAP_DEFAULT = 200;

/**
 * Split `content` into overlapping chunks at paragraph boundaries.
 * Returns an empty array for blank / whitespace-only content.
 */
export function chunkText(content: string, filePath: string, opts: ChunkOptions = {}): TextChunk[] {
  if (!content.trim()) return [];

  const chunkSize = Math.max(100, opts.chunkSize ?? CHUNK_SIZE_DEFAULT);
  const overlap = Math.min(opts.overlap ?? OVERLAP_DEFAULT, Math.floor(chunkSize / 2));

  // ── Parse paragraphs with line-number tracking ───────────────────────────
  const paragraphs = parseParagraphs(content);
  if (paragraphs.length === 0) return [];

  // ── Chunk assembly ───────────────────────────────────────────────────────
  const chunks: TextChunk[] = [];
  let currentHeading: string | undefined;
  let buffer: typeof paragraphs = [];
  let bufferLen = 0;

  function bufferText(): string {
    return buffer.map((p) => p.text).join('\n\n');
  }

  // Paragraphs to carry into the next chunk as overlap (whole paragraphs only,
  // working backwards from the end of the current buffer until `overlap` chars
  // are covered).
  function overlapSlice(): typeof paragraphs {
    let carried = 0;
    const result: typeof paragraphs = [];
    for (let i = buffer.length - 1; i >= 0; i--) {
      const pLen = buffer[i].text.length;
      if (carried + pLen > overlap && result.length > 0) break;
      carried += pLen + 2; // +2 for \n\n separator
      result.unshift(buffer[i]);
    }
    return result;
  }

  function flush(): void {
    if (buffer.length === 0) return;
    const body = bufferText();
    const startLine = buffer[0].startLine;
    const endLine = buffer[buffer.length - 1].endLine;
    const text = currentHeading ? `${currentHeading}\n\n${body}` : body;
    const baseId = `${filePath}:${startLine}`;
    const id = chunks.some((c) => c.id === baseId) ? `${baseId}:${chunks.length}` : baseId;
    chunks.push({ id, filePath, startLine, endLine, content: text, heading: currentHeading });
  }

  for (const para of paragraphs) {
    // Headings reset section context and force a chunk boundary.
    if (para.isHeading) {
      flush();
      buffer = [];
      bufferLen = 0;
      currentHeading = para.text.split('\n')[0].trim();
      // The heading itself is NOT placed in the buffer — it becomes the prefix
      // at flush time, so every chunk body already carries the section label.
      continue;
    }

    const addLen = bufferLen === 0 ? para.text.length : 2 + para.text.length;

    if (bufferLen > 0 && bufferLen + addLen > chunkSize) {
      flush();
      const carry = overlapSlice();
      buffer = [...carry, para];
      bufferLen = buffer.reduce((s, p, i) => s + p.text.length + (i > 0 ? 2 : 0), 0);
    } else {
      buffer.push(para);
      bufferLen += addLen;
    }
  }

  flush();
  return chunks;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

interface Paragraph {
  text: string;
  startLine: number;
  endLine: number;
  isHeading: boolean;
}

/**
 * Split raw content into non-empty paragraphs, each annotated with its
 * 1-based start/end line numbers and whether it opens with a markdown heading.
 */
function parseParagraphs(content: string): Paragraph[] {
  const result: Paragraph[] = [];
  // Split on one or more blank lines.
  const rawParas = content.split(/\n{2,}/);
  let lineNum = 1;

  for (const raw of rawParas) {
    const paraLineCount = raw.split('\n').length;
    const text = raw.trim();
    if (text) {
      result.push({
        text,
        startLine: lineNum,
        endLine: lineNum + paraLineCount - 1,
        isHeading: /^#{1,6}\s/.test(text),
      });
    }
    // Advance past the paragraph lines plus the blank-line separator.
    lineNum += paraLineCount + 1;
  }

  return result;
}
