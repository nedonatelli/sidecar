/**
 * Simple line-based unified diff generator.
 * No external dependencies — uses a basic LCS algorithm.
 */

interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

/**
 * Compute the longest common subsequence table for two arrays of lines.
 */
function lcsTable(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

/**
 * Backtrack the LCS table to produce diff operations.
 */
function backtrack(
  dp: number[][],
  a: string[],
  b: string[],
  i: number,
  j: number,
): { type: 'equal' | 'add' | 'del'; line: string }[] {
  const result: { type: 'equal' | 'add' | 'del'; line: string }[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      result.push({ type: 'equal', line: a[i - 1] });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.push({ type: 'add', line: b[j - 1] });
      j--;
    } else {
      result.push({ type: 'del', line: a[i - 1] });
      i--;
    }
  }

  return result.reverse();
}

/**
 * Group diff operations into hunks with context lines.
 */
function buildHunks(ops: { type: 'equal' | 'add' | 'del'; line: string }[], contextLines = 3): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let trailingContext = 0;

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];

    if (op.type === 'equal') {
      oldLine++;
      newLine++;

      if (currentHunk) {
        currentHunk.lines.push(' ' + op.line);
        currentHunk.oldCount++;
        currentHunk.newCount++;
        trailingContext++;

        if (trailingContext >= contextLines) {
          // Check if next change is within context range
          let nextChange = -1;
          for (let j = i + 1; j < ops.length; j++) {
            if (ops[j].type !== 'equal') {
              nextChange = j;
              break;
            }
          }

          if (nextChange === -1 || nextChange - i > contextLines) {
            hunks.push(currentHunk);
            currentHunk = null;
            trailingContext = 0;
          }
        }
      }
    } else {
      trailingContext = 0;

      if (!currentHunk) {
        // Start a new hunk with leading context
        currentHunk = {
          oldStart: Math.max(1, oldLine - contextLines + 1),
          oldCount: 0,
          newStart: Math.max(1, newLine - contextLines + 1),
          newCount: 0,
          lines: [],
        };

        // Add leading context lines
        const leadStart = Math.max(0, i - contextLines);
        for (let j = leadStart; j < i; j++) {
          if (ops[j].type === 'equal') {
            currentHunk.lines.push(' ' + ops[j].line);
            currentHunk.oldCount++;
            currentHunk.newCount++;
          }
        }
      }

      if (op.type === 'del') {
        currentHunk.lines.push('-' + op.line);
        currentHunk.oldCount++;
        oldLine++;
      } else {
        currentHunk.lines.push('+' + op.line);
        currentHunk.newCount++;
        newLine++;
      }
    }
  }

  if (currentHunk) {
    hunks.push(currentHunk);
  }

  return hunks;
}

/**
 * Compute a unified diff string between original and current file content.
 *
 * @param filePath - File path for the diff header
 * @param original - Original content (null if file is new)
 * @param current - Current content (null if file was deleted)
 * @param maxLines - Truncate output after this many lines (default 500)
 */
export function computeUnifiedDiff(
  filePath: string,
  original: string | null,
  current: string | null,
  maxLines = 500,
): string {
  const lines: string[] = [];
  lines.push(`--- a/${filePath}`);
  lines.push(`+++ b/${filePath}`);

  if (original === null && current !== null) {
    // New file — all lines added
    const newLines = current.split('\n');
    lines.push(`@@ -0,0 +1,${newLines.length} @@`);
    for (const line of newLines) {
      lines.push('+' + line);
      if (lines.length >= maxLines) {
        lines.push('\\ ... (truncated)');
        return lines.join('\n');
      }
    }
    return lines.join('\n');
  }

  if (current === null && original !== null) {
    // Deleted file — all lines removed
    const oldLines = original.split('\n');
    lines.push(`@@ -1,${oldLines.length} +0,0 @@`);
    for (const line of oldLines) {
      lines.push('-' + line);
      if (lines.length >= maxLines) {
        lines.push('\\ ... (truncated)');
        return lines.join('\n');
      }
    }
    return lines.join('\n');
  }

  if (original === current) {
    return ''; // No changes
  }

  const oldLines = (original || '').split('\n');
  const newLines = (current || '').split('\n');

  const dp = lcsTable(oldLines, newLines);
  const ops = backtrack(dp, oldLines, newLines, oldLines.length, newLines.length);
  const hunks = buildHunks(ops);

  for (const hunk of hunks) {
    lines.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    for (const line of hunk.lines) {
      lines.push(line);
      if (lines.length >= maxLines) {
        lines.push('\\ ... (truncated)');
        return lines.join('\n');
      }
    }
  }

  return lines.join('\n');
}
