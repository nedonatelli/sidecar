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
    result = result.slice(0, block.startOffset) + resolved + result.slice(block.endOffset);
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
      resolutions.set(block.index, resolved.trim());
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
