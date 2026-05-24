// Pure line-based unified diff. No external dependencies.
// Capped at MAX_LINES per side to keep the chat card readable.

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
  // DP LCS table — O(m*n) time and space, fine for ≤300 lines.
  const m = a.length;
  const n = b.length;
  const dp: Uint16Array[] = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce edit script.
  const ops: Hunk[] = [];
  let i = m,
    j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.unshift({ op: 'equal', line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({ op: 'insert', line: b[j - 1] });
      j--;
    } else {
      ops.unshift({ op: 'delete', line: a[i - 1] });
      i--;
    }
  }
  return ops;
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
