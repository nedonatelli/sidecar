import { workspace, Uri } from 'vscode';
import * as path from 'path';
import { getRootUri } from './tools/shared.js';

export interface TimelineEntry {
  /** Workspace-relative path (forward slashes). */
  relPath: string;
  /** Content before the agent first touched this file. `undefined` = file was created by the agent. */
  originalContent: string | undefined;
  /** Latest content written by the agent. */
  newContent: string;
  /** How many agent writes have landed on this file. */
  editCount: number;
  firstEditAt: number;
  lastEditAt: number;
}

type Listener = () => void;

/**
 * Session-scoped record of every file the agent wrote during the current chat.
 *
 * One entry per workspace-relative path — subsequent writes update
 * `newContent`/`editCount`/`lastEditAt` in place.  `originalContent`
 * is captured *once* on first touch so "revert" always undoes every
 * agent edit to that file, not just the last one.
 *
 * Shadow-workspace and audit-mode writes are excluded by the callers
 * (fs.ts checks `context.cwd` and `isAuditModeActive`) so the
 * timeline only shows changes that actually landed on disk.
 */
export class EditTimelineStore {
  private entries = new Map<string, TimelineEntry>();
  private listeners: Listener[] = [];

  /** Record one agent write. Called by fs.ts before every real disk write. */
  record(relPath: string, originalContent: string | undefined, newContent: string): void {
    const norm = relPath.replace(/\\/g, '/');
    const existing = this.entries.get(norm);
    if (existing) {
      existing.newContent = newContent;
      existing.editCount++;
      existing.lastEditAt = Date.now();
    } else {
      this.entries.set(norm, {
        relPath: norm,
        originalContent,
        newContent,
        editCount: 1,
        firstEditAt: Date.now(),
        lastEditAt: Date.now(),
      });
    }
    this.notify();
  }

  list(): TimelineEntry[] {
    return [...this.entries.values()].sort((a, b) => b.lastEditAt - a.lastEditAt);
  }

  get size(): number {
    return this.entries.size;
  }

  /**
   * Revert a file to the content it had before the agent touched it.
   * Deletes the file if the agent created it (`originalContent === undefined`).
   * Returns true on success, false if the entry wasn't found.
   */
  async revert(relPath: string): Promise<boolean> {
    const norm = relPath.replace(/\\/g, '/');
    const entry = this.entries.get(norm);
    if (!entry) return false;

    const rootUri = getRootUri();
    const fileUri = Uri.joinPath(rootUri, norm);

    if (entry.originalContent === undefined) {
      await workspace.fs.delete(fileUri, { useTrash: true });
    } else {
      await workspace.fs.writeFile(fileUri, Buffer.from(entry.originalContent, 'utf-8'));
    }
    this.entries.delete(norm);
    this.notify();
    return true;
  }

  /** Revert all files to their pre-agent state. */
  async revertAll(): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      await this.revert(entry.relPath);
    }
  }

  /** Remove all entries without touching disk (e.g. when clearing chat). */
  clear(): void {
    this.entries.clear();
    this.notify();
  }

  onChange(cb: Listener): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }

  private notify(): void {
    for (const cb of this.listeners) cb();
  }
}

// ---------------------------------------------------------------------------
// Diff statistics helper (used by the tree view for "+N -M" labels)
// ---------------------------------------------------------------------------

export interface DiffStats {
  added: number;
  removed: number;
}

export function computeDiffStats(original: string | undefined, current: string): DiffStats {
  if (original === undefined) {
    return { added: current.split('\n').length, removed: 0 };
  }
  const origLines = original.split('\n').length;
  const currLines = current.split('\n').length;
  const delta = currLines - origLines;
  return delta >= 0 ? { added: delta, removed: 0 } : { added: 0, removed: -delta };
}

export function formatDiffStats(stats: DiffStats): string {
  const parts: string[] = [];
  if (stats.added > 0) parts.push(`+${stats.added}`);
  if (stats.removed > 0) parts.push(`-${stats.removed}`);
  return parts.join(' ') || '~';
}

/** Extract the base filename from a workspace-relative path. */
export function fileLabel(relPath: string): string {
  return path.basename(relPath);
}
