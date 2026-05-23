const DIFF_CONTEXT_LINES = 3;
const DIFF_MAX_OUTPUT_LINES = 150;

export function computeLineDiff(oldText: string, newText: string, relPath: string): string {
  if (oldText === newText) return '';
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  if (oldLines.length > 5000 || newLines.length > 5000) return '';

  let pre = 0;
  while (pre < oldLines.length && pre < newLines.length && oldLines[pre] === newLines[pre]) pre++;

  let suf = 0;
  while (
    suf < oldLines.length - pre &&
    suf < newLines.length - pre &&
    oldLines[oldLines.length - 1 - suf] === newLines[newLines.length - 1 - suf]
  )
    suf++;

  const oldDel = oldLines.slice(pre, oldLines.length - suf || undefined);
  const newAdd = newLines.slice(pre, newLines.length - suf || undefined);
  if (oldDel.length === 0 && newAdd.length === 0) return '';

  const ctxStart = Math.max(0, pre - DIFF_CONTEXT_LINES);
  const ctxEnd = suf > 0 ? oldLines.length - suf : oldLines.length;
  const before = oldLines.slice(ctxStart, pre);
  const after = oldLines.slice(ctxEnd, Math.min(oldLines.length, ctxEnd + DIFF_CONTEXT_LINES));

  const oldStart = ctxStart + 1;
  const newStart = ctxStart + 1;
  const oldCount = before.length + oldDel.length + after.length;
  const newCount = before.length + newAdd.length + after.length;

  const lines = [
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    ...before.map((l) => ` ${l}`),
    ...oldDel.map((l) => `-${l}`),
    ...newAdd.map((l) => `+${l}`),
    ...after.map((l) => ` ${l}`),
  ];

  if (lines.length > DIFF_MAX_OUTPUT_LINES) {
    return lines.slice(0, DIFF_MAX_OUTPUT_LINES).join('\n') + '\n... (diff truncated)';
  }
  return lines.join('\n');
}
