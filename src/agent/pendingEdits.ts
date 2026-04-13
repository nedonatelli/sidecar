import { EventEmitter, type Event } from 'vscode';

/**
 * A pending file mutation captured by the agent in review mode. The store
 * records the file's pre-edit content so a reject can restore it, and the
 * post-edit content so an accept can apply it. Pending edits are kept
 * entirely in memory — nothing hits disk until the user accepts.
 *
 * The agent loop treats pending writes as if they succeeded so the model
 * can continue reasoning about its own changes. Subsequent read_file calls
 * on the same path return the pending content rather than the disk content,
 * giving the agent a consistent view of its own work.
 */
export interface PendingEdit {
  /** Absolute path of the file being edited. */
  filePath: string;
  /**
   * Contents of the file before the first pending edit in this session.
   * `null` if the agent is creating a file that didn't exist on disk —
   * accepting a create-type edit writes the new file; rejecting it is a
   * no-op since there was nothing to revert.
   */
  originalContent: string | null;
  /** Contents as they would be after applying every pending edit. */
  newContent: string;
  /** Epoch timestamp of the most recent update to this entry. */
  updatedAt: number;
  /** Which tool produced the most recent update (write_file / edit_file). */
  lastTool: 'write_file' | 'edit_file';
}

/**
 * In-memory shadow of every file mutation an agent has proposed during a
 * review-mode session. Multiple edits to the same file collapse into a
 * single entry — the user sees one consolidated "before → after" diff per
 * file regardless of how many tool calls the agent made to produce it.
 *
 * The store is a pure data structure. The TreeView panel subscribes to
 * `onChanged` to refresh when entries come and go; commands call `accept`
 * and `discard` to resolve pending edits; the executor calls `record` and
 * `get` to participate in review mode.
 */
export class PendingEditStore {
  private readonly edits = new Map<string, PendingEdit>();
  private readonly emitter = new EventEmitter<void>();

  /** Fires whenever the store's contents change (record, remove, clear). */
  readonly onChanged: Event<void> = this.emitter.event;

  /**
   * Record a new or updated pending edit for `filePath`. If this is the
   * first edit for the path, `originalContent` is captured as the revert
   * baseline. Subsequent edits to the same path overwrite `newContent`
   * but leave the baseline alone — one coherent pre/post pair per file.
   */
  record(
    filePath: string,
    originalContent: string | null,
    newContent: string,
    lastTool: 'write_file' | 'edit_file',
  ): void {
    const existing = this.edits.get(filePath);
    if (existing) {
      existing.newContent = newContent;
      existing.updatedAt = Date.now();
      existing.lastTool = lastTool;
    } else {
      this.edits.set(filePath, {
        filePath,
        originalContent,
        newContent,
        updatedAt: Date.now(),
        lastTool,
      });
    }
    this.emitter.fire();
  }

  /** Return a single pending edit by absolute path, or undefined. */
  get(filePath: string): PendingEdit | undefined {
    return this.edits.get(filePath);
  }

  /** True iff `filePath` has a pending edit (for quick existence checks). */
  has(filePath: string): boolean {
    return this.edits.has(filePath);
  }

  /**
   * Return every pending edit, sorted by file path for deterministic UI
   * ordering. The returned array is a snapshot — mutating it does not
   * affect the store.
   */
  getAll(): PendingEdit[] {
    return Array.from(this.edits.values()).sort((a, b) => a.filePath.localeCompare(b.filePath));
  }

  /**
   * Remove a single pending edit (e.g. after the user accepts or discards
   * it individually). Silently no-ops when the entry doesn't exist.
   */
  remove(filePath: string): boolean {
    const had = this.edits.delete(filePath);
    if (had) this.emitter.fire();
    return had;
  }

  /** Drop every pending edit at once. Used by accept-all / discard-all. */
  clear(): void {
    if (this.edits.size === 0) return;
    this.edits.clear();
    this.emitter.fire();
  }

  /** Number of files with pending edits. */
  get size(): number {
    return this.edits.size;
  }

  /** Test hook and disposal. */
  dispose(): void {
    this.edits.clear();
    this.emitter.dispose();
  }
}
