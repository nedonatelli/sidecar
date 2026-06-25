import * as crypto from 'crypto';
import type { ToolUseContentBlock } from '../../ollama/types.js';
import type { AgentCallbacks } from '../loop.js';
import type { LoopState } from './state.js';

// ---------------------------------------------------------------------------
// Circular-rewrite handling for cycle detection.
//
// A model stuck on a fiddly bug oscillates: it regenerates the WHOLE file with
// write_file, content A, then B, then A again — going in a circle instead of
// converging. Dogfooding caught qwen3.5 doing exactly this (write 6.5KB → write
// 4.2KB → rewrite a prior version) until normalized cycle detection killed the
// run with an incomplete, broken GUI.
//
// The write_file executor already soft-blocks a byte-identical re-write (no-op
// on disk; see fs.ts writeFile + ToolExecutorContext.writeHistoryByFile). But
// cycle detection runs BEFORE dispatch and counts the tool signature, so a
// blocked circular write would still trip the bail and end the whole run. This
// helper removes under-budget blocked circular writes from the list cycle
// detection sees, so the run CONTINUES (the model gets the soft-block message
// and a chance to switch to edit_file or verify) rather than dying outright.
//
// Bounded per file by MAX_CIRCULAR_BLOCKS_PER_FILE: once a file's budget is
// spent, its circular writes are left in the list so the normalized cycle
// detector bails the genuinely-stuck loop. The executor still no-ops the write
// in that case, so the last good version on disk is preserved either way.
// ---------------------------------------------------------------------------

const MAX_CIRCULAR_BLOCKS_PER_FILE = 2;

function hashContent(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Return `pendingToolUses` with under-budget blocked circular writes removed,
 * so cycle detection doesn't count them. A write is circular when its content
 * hash is already in `state.writeHistoryByFile` for that path (a version this
 * run already wrote). Non-write tools and first-time content pass through
 * untouched. Increments `state.circularRewriteBlocksByFile` and emits a
 * breadcrumb for each one excluded.
 */
export function excludeBlockedCircularRewrites(
  pendingToolUses: ToolUseContentBlock[],
  state: LoopState,
  callbacks: AgentCallbacks,
): ToolUseContentBlock[] {
  if (state.writeHistoryByFile.size === 0) return pendingToolUses;

  const kept: ToolUseContentBlock[] = [];
  for (const tu of pendingToolUses) {
    if (tu.name !== 'write_file') {
      kept.push(tu);
      continue;
    }
    const input = tu.input as Record<string, unknown>;
    const filePath = (input.path ?? input.file_path) as string | undefined;
    const content = input.content;
    if (!filePath || typeof content !== 'string') {
      kept.push(tu);
      continue;
    }
    const isCircular = state.writeHistoryByFile.get(filePath)?.has(hashContent(content)) ?? false;
    if (!isCircular) {
      kept.push(tu);
      continue;
    }
    const blocks = state.circularRewriteBlocksByFile.get(filePath) ?? 0;
    if (blocks >= MAX_CIRCULAR_BLOCKS_PER_FILE) {
      // Budget spent — leave it in so cycle detection bails the stuck loop.
      kept.push(tu);
      continue;
    }
    state.circularRewriteBlocksByFile.set(filePath, blocks + 1);
    state.logger?.warn(
      `Circular rewrite blocked: ${filePath} is byte-identical to a prior write this run — ` +
        `excluded from cycle detection so the run continues (${blocks + 1}/${MAX_CIRCULAR_BLOCKS_PER_FILE})`,
    );
    callbacks.onText(
      `\n♻️ Identical rewrite of ${filePath.split('/').pop()} blocked — make a targeted edit or verify instead.\n`,
    );
    // excluded from `kept` → cycle detection never sees it
  }
  return kept;
}
