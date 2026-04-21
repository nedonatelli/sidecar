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

/**
 * Per-item sentinel overrides (v0.73.2).
 * Sentinels are `@key:value` tokens embedded in the task text.
 * Example: `- [ ] Refactor auth @model:claude-opus-4-7 @shadowMode:always`
 */
export interface ItemSentinels {
  /** Override the active model for this task only. */
  model?: string;
  /** Force or suppress Shadow Workspace for this task. */
  shadowMode?: 'off' | 'opt-in' | 'always';
  /** Run specific named facets for this task instead of the default agent loop. */
  facets?: string[];
}

export interface BacklogItem {
  /** 0-based index of the line in the source file */
  lineIndex: number;
  /** The task text, stripped of the `- [ ] ` prefix AND sentinel annotations */
  text: string;
  /** true = `- [x]` (done), false = `- [ ]` (pending) */
  done: boolean;
  /** Parsed sentinel overrides found on this item (empty object if none) */
  sentinels: ItemSentinels;
}

/** Pattern that matches `- [ ] text` or `- [x] text` (case-insensitive x) */
const ITEM_RE = /^(\s*)-\s+\[( |x)\]\s+(.*)/i;

/** Pattern for `@key:value` sentinel tokens */
const SENTINEL_RE = /@(model|shadowMode|facets):([^\s@]+)/g;

/**
 * Parse sentinel annotations from raw item text.
 * Returns an empty object when no sentinels are present.
 */
export function parseItemSentinels(rawText: string): ItemSentinels {
  const sentinels: ItemSentinels = {};
  SENTINEL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SENTINEL_RE.exec(rawText)) !== null) {
    const [, key, value] = m;
    if (key === 'model') {
      sentinels.model = value;
    } else if (key === 'shadowMode' && (value === 'off' || value === 'opt-in' || value === 'always')) {
      sentinels.shadowMode = value as ItemSentinels['shadowMode'];
    } else if (key === 'facets') {
      sentinels.facets = value.split(',').filter(Boolean);
    }
  }
  return sentinels;
}

/**
 * Remove all `@key:value` sentinel tokens from text, returning the clean
 * prompt text that is sent to the agent.
 */
export function stripSentinels(rawText: string): string {
  return rawText
    .replace(/@(model|shadowMode|facets):[^\s@]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

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
    const rawText = m[3].trim();
    items.push({
      lineIndex: i,
      text: stripSentinels(rawText),
      done: m[2].toLowerCase() === 'x',
      sentinels: parseItemSentinels(rawText),
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
