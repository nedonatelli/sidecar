import type { SideCarClient } from '../ollama/client.js';
import type { ConflictBlock, ConflictFile } from './conflictDetector.js';

export interface ResolveResult {
  readonly resolvedContent: string;
  readonly resolvedBlocks: number;
  readonly totalBlocks: number;
}

/**
 * Build the LLM prompt for a single conflict block.
 * Exported so tests can assert on the prompt shape without calling the LLM.
 */
export function buildConflictPrompt(block: ConflictBlock): string {
  const parts: string[] = [
    'You are a merge conflict resolver. Given the two (or three) sides of a git merge conflict, output ONLY the correctly merged code.',
    'Do not include conflict markers, explanations, or any prose — just the merged code.',
    '',
    `=== OURS (${block.oursLabel}) ===`,
    block.ours,
  ];

  if (block.base !== null) {
    parts.push('', '=== BASE (common ancestor) ===', block.base);
  }

  parts.push('', `=== THEIRS (${block.theirsLabel}) ===`, block.theirs, '', '=== MERGED OUTPUT ===');

  return parts.join('\n');
}

/**
 * The model's answer, as code to write. Replaces a plain `.trim()`, which
 * took the first line's indentation with it, so a resolved block inside a
 * function or class started at column 0 (ML-19, #165). Now:
 *   - a code fence around the whole answer (```lang ... ```) is unwrapped
 *     instead of written into the file, despite the prompt asking for code only;
 *   - only leading BLANK lines are dropped, so the first line keeps its indent;
 *   - trailing whitespace and newlines are dropped (applyResolutions puts the
 *     span's own line ending back).
 */
export function cleanResolution(raw: string): string {
  let text = raw;
  const fenced = text.trim().match(/^```[^\n]*\r?\n([\s\S]*?)\r?\n```$/);
  if (fenced) text = fenced[1];
  return text.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
}

/**
 * Reconstruct file text by replacing each block's span with the LLM's resolution.
 * Processes blocks in reverse order so earlier offsets remain stable.
 */
export function applyResolutions(
  originalContent: string,
  blocks: readonly ConflictBlock[],
  resolutions: ReadonlyMap<number, string>,
): string {
  // Work highest-offset-first so replacements don't shift earlier positions
  const sorted = [...blocks].sort((a, b) => b.startOffset - a.startOffset);
  let result = originalContent;

  for (const block of sorted) {
    const resolved = resolutions.get(block.index);
    if (resolved === undefined) continue;
    // The span ends with the `>>>>>>>` line's line break, and resolutions
    // arrive trimmed, so the resolved block's last line was glued to the line
    // after the conflict. Put the span's own line ending back. An empty
    // resolution (drop the block) still removes the whole span.
    const span = result.slice(block.startOffset, block.endOffset);
    const eol = span.endsWith('\r\n') ? '\r\n' : span.endsWith('\n') ? '\n' : '';
    // The model answers with LF; in a CRLF file that mixed line endings into
    // the resolved block (ML-19). Match the conflict span's own line ending.
    const body = eol === '\r\n' ? resolved.replace(/\r?\n/g, '\r\n') : resolved;
    const text = body !== '' && eol && !body.endsWith('\n') ? body + eol : body;
    result = result.slice(0, block.startOffset) + text + result.slice(block.endOffset);
  }

  return result;
}

/**
 * Ask the LLM to resolve every conflict block in `file`.
 * Each block is resolved with a separate `complete()` call so the context
 * window is bounded and a single failure doesn't abort the whole file.
 */
export async function resolveConflicts(
  file: ConflictFile,
  client: SideCarClient,
  signal?: AbortSignal,
): Promise<ResolveResult> {
  const resolutions = new Map<number, string>();
  let resolvedBlocks = 0;

  for (const block of file.blocks) {
    if (signal?.aborted) break;

    const prompt = buildConflictPrompt(block);
    const maxTokens = Math.min(4096, block.ours.length + block.theirs.length + 512);

    try {
      const resolved = await client.complete([{ role: 'user', content: prompt }], maxTokens, signal);
      resolutions.set(block.index, cleanResolution(resolved));
      resolvedBlocks++;
    } catch (err) {
      // AbortError: stop iterating
      if (err instanceof Error && err.name === 'AbortError') break;
      // Other errors: leave this block unresolved (original marker text stays)
    }
  }

  const resolvedContent = applyResolutions(file.originalContent, file.blocks, resolutions);
  return { resolvedContent, resolvedBlocks, totalBlocks: file.blocks.length };
}
