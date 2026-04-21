/**
 * Backlog parser for Auto Mode (v0.73).
 *
 * Reads and writes `.sidecar/backlog.md` — a plain markdown checklist
 * where each task is an unchecked `- [ ]` item. Completed tasks are
 * marked `- [x]`. Lines that are not checklist items (headings, prose,
 * blank lines) are preserved verbatim when the file is written back.
 *
 * Pure module: no VS Code imports, no file I/O — callers supply the
 * raw string content and receive new content back. Keeps this testable
 * in isolation from the file system.
 */

export interface BacklogItem {
  /** 0-based index of the line in the source file */
  lineIndex: number;
  /** The task text, stripped of the `- [ ] ` prefix */
  text: string;
  /** true = `- [x]` (done), false = `- [ ]` (pending) */
  done: boolean;
}

/** Pattern that matches `- [ ] text` or `- [x] text` (case-insensitive x) */
const ITEM_RE = /^(\s*)-\s+\[( |x)\]\s+(.*)/i;

/**
 * Parse the raw content of a backlog.md file into a list of `BacklogItem`s.
 * Non-item lines are ignored — only checklist lines are returned.
 */
export function parseBacklog(content: string): BacklogItem[] {
  const items: BacklogItem[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = ITEM_RE.exec(lines[i]);
    if (!m) continue;
    items.push({
      lineIndex: i,
      text: m[3].trim(),
      done: m[2].toLowerCase() === 'x',
    });
  }
  return items;
}

/**
 * Returns the first unchecked `BacklogItem`, or `undefined` if every
 * item is already done (or there are no items).
 */
export function nextPendingItem(items: BacklogItem[]): BacklogItem | undefined {
  return items.find((item) => !item.done);
}

/**
 * Mark the item at `lineIndex` as done (`- [x]`) and return the updated
 * file content. Preserves all other lines verbatim.
 */
export function markItemDone(content: string, lineIndex: number): string {
  const lines = content.split('\n');
  const line = lines[lineIndex];
  if (!line) return content;
  lines[lineIndex] = line.replace(/\[\s\]/, '[x]');
  return lines.join('\n');
}

/**
 * Mark the item at `lineIndex` as pending (`- [ ]`) — e.g. to reset a
 * failed task so it can be retried.
 */
export function markItemPending(content: string, lineIndex: number): string {
  const lines = content.split('\n');
  const line = lines[lineIndex];
  if (!line) return content;
  lines[lineIndex] = line.replace(/\[[xX]\]/, '[ ]');
  return lines.join('\n');
}

/**
 * Count pending and done items.
 */
export function backlogStats(items: BacklogItem[]): { total: number; done: number; pending: number } {
  const done = items.filter((i) => i.done).length;
  return { total: items.length, done, pending: items.length - done };
}

/**
 * Append a new `- [ ] text` item at the end of the backlog content.
 * Adds a trailing newline if the content doesn't already have one.
 */
export function appendItem(content: string, text: string): string {
  const trimmed = content.endsWith('\n') ? content : content + '\n';
  return trimmed + `- [ ] ${text}\n`;
}
