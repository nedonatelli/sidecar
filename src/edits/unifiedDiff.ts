// Pure line-based unified diff. No external dependencies.
// Capped at MAX_LINES per side to keep the chat card readable.

import { diffLines } from '../util/lineDiff.js';

const MAX_LINES = 300;
const CONTEXT = 3;

type Op = 'equal' | 'insert' | 'delete';
interface Hunk {
  op: Op;
  line: string;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** Compute added/removed line counts between two texts. Fast path. */
export function diffStats(original: string, proposed: string): DiffStats {
  if (original === proposed) return { added: 0, removed: 0 };
  const a = original.split('\n');
  const b = proposed.split('\n');
  const hunks = buildHunks(a, b);
  let added = 0,
    removed = 0;
  for (const h of hunks) {
    if (h.op === 'insert') added++;
    else if (h.op === 'delete') removed++;
  }
  return { added, removed };
}

/**
 * Produce a unified diff string (without the `---`/`+++` file header)
 * between `original` and `proposed`. Returns an empty string when identical.
 * Falls back to a stats summary when either file exceeds MAX_LINES.
 */
export function computeUnifiedDiff(original: string, proposed: string): string {
  if (original === proposed) return '';

  const a = original.split('\n');
  const b = proposed.split('\n');

  if (a.length > MAX_LINES || b.length > MAX_LINES) {
    const stats = diffStats(original, proposed);
    return `(file too large for inline diff — ${stats.added} lines added, ${stats.removed} lines removed)`;
  }

  const hunks = buildHunks(a, b);
  return formatHunks(hunks, CONTEXT);
}

// ---------------------------------------------------------------------------
// Internal: LCS-based edit script
// ---------------------------------------------------------------------------

function buildHunks(a: string[], b: string[]): Hunk[] {
  // Shared bounded diff: the full O(m*n) Uint16 table this used to build made
  // diffStats -- called on files over MAX_LINES, so with no size limit at all
  // -- exhaust memory on large files and overflow past 65,535 lines.
  const kind = { equal: 'equal', add: 'insert', del: 'delete' } as const;
  return diffLines(a, b).map((o) => ({ op: kind[o.type], line: o.line }));
}

function formatHunks(hunks: Hunk[], context: number): string {
  // Identify changed line indices in the ops array.
  const changed = new Set<number>();
  for (let idx = 0; idx < hunks.length; idx++) {
    if (hunks[idx].op !== 'equal') changed.add(idx);
  }

  // Build context windows around changes.
  const included = new Set<number>();
  for (const c of changed) {
    for (let k = Math.max(0, c - context); k <= Math.min(hunks.length - 1, c + context); k++) {
      included.add(k);
    }
  }

  if (included.size === 0) return '';

  const lines: string[] = [];
  let prev = -2;

  const sorted = [...included].sort((a, b) => a - b);
  for (const idx of sorted) {
    if (idx > prev + 1) {
      lines.push('@@');
    }
    const h = hunks[idx];
    lines.push((h.op === 'insert' ? '+' : h.op === 'delete' ? '-' : ' ') + h.line);
    prev = idx;
  }

  return lines.join('\n');
}
