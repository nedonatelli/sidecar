/**
 * Line diff shared by every diff SideCar renders (change summaries, per-hunk
 * review, cautious-mode write previews). Bounded in memory and time.
 *
 * Both earlier implementations filled a full (m+1)×(n+1) LCS table: a
 * 15,000-line file took 2.1 GB and a 30,000-line one crashed the extension
 * host, and the Uint16Array variant silently overflowed past 65,535 lines.
 *
 * Here the common head and tail are matched first (most edits are local, so
 * what is left to diff is usually a few lines), and the LCS runs only on the
 * middle, in one flat Int32Array. When even the middle is too large
 * (MAX_LCS_CELLS), it is reported as one block replaced by another: still a
 * correct diff, only not the smallest one.
 */

export type LineOp = { type: 'equal' | 'add' | 'del'; line: string };

/** Upper bound on LCS table cells (Int32: 4 bytes each, so 16 MB). */
export const MAX_LCS_CELLS = 4_000_000;

export function diffLines(a: readonly string[], b: readonly string[], maxCells = MAX_LCS_CELLS): LineOp[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops: LineOp[] = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'equal', line: a[i] });

  const m = endA - start;
  const n = endB - start;
  if ((m + 1) * (n + 1) > maxCells) {
    for (let i = start; i < endA; i++) ops.push({ type: 'del', line: a[i] });
    for (let j = start; j < endB; j++) ops.push({ type: 'add', line: b[j] });
  } else {
    middleLcs(a, b, start, m, n, ops);
  }

  for (let i = endA; i < a.length; i++) ops.push({ type: 'equal', line: a[i] });
  return ops;
}

/** LCS over a[start, start+m) vs b[start, start+n), appended to `out` in order. */
function middleLcs(a: readonly string[], b: readonly string[], start: number, m: number, n: number, out: LineOp[]) {
  const w = n + 1;
  const dp = new Int32Array((m + 1) * w);
  for (let i = 1; i <= m; i++) {
    const ai = a[start + i - 1];
    for (let j = 1; j <= n; j++) {
      dp[i * w + j] =
        ai === b[start + j - 1] ? dp[(i - 1) * w + j - 1] + 1 : Math.max(dp[(i - 1) * w + j], dp[i * w + j - 1]);
    }
  }
  // Backtrack from the end; collected in reverse, then flipped once (unshift
  // per op made the old backtrack quadratic on its own).
  const rev: LineOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[start + i - 1] === b[start + j - 1]) {
      rev.push({ type: 'equal', line: a[start + i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i * w + j - 1] >= dp[(i - 1) * w + j])) {
      rev.push({ type: 'add', line: b[start + j - 1] });
      j--;
    } else {
      rev.push({ type: 'del', line: a[start + i - 1] });
      i--;
    }
  }
  for (let k = rev.length - 1; k >= 0; k--) out.push(rev[k]);
}
