/**
 * Audit Mode — in-memory write buffer that sits between the agent's
 * `write_file` / `edit_file` / `delete_file` tool calls and the real
 * filesystem. When `sidecar.agentMode === 'audit'`, every agent write
 * lands here instead of disk; the user then reviews the buffer as a
 * batch and accepts (atomic flush to disk) or rejects (discard).
 *
 * The buffer is read-through: an agent that writes foo.ts then later
 * reads foo.ts sees its own buffered content, not the unmodified disk
 * state. This keeps multi-step edits stacking correctly without the
 * agent needing any awareness of the buffer.
 *
 * v0.60 MVP scope: in-memory only (no persistence across extension
 * reloads), accept-all / reject-all (no per-file checkbox UI),
 * no conflict detection (if the user edits a file on disk between
 * the agent's write and the user's accept, the on-disk edit is
 * silently overwritten on flush — that's v0.61 work).
 */

export type BufferedOp = 'create' | 'modify' | 'delete';

export interface BufferedChange {
  /** Workspace-relative path. */
  path: string;
  /** What kind of change this entry represents, relative to the disk
   *  state captured when the entry was first created. */
  op: BufferedOp;
  /** New content the agent wants on disk. Undefined for `delete`. */
  content?: string;
  /** Original on-disk content at first-buffer time. Used to drive
   *  `op` correctness (create vs modify) and — when conflict
   *  detection ships in v0.61 — to flag mid-review disk edits. */
  originalContent?: string;
  /** ms since epoch when the entry was created. */
  timestamp: number;
}

export type ReadDiskFn = (path: string) => Promise<string | undefined>;
export type WriteDiskFn = (path: string, content: string) => Promise<void>;
export type DeleteDiskFn = (path: string) => Promise<void>;

/**
 * Optional persistence layer (v0.61 a.3). When set, the buffer
 * serializes its state to durable storage after every mutation and
 * restores from it on next activation. Persistence is best-effort
 * — a failing `save()` logs a warning but never fails the mutation
 * that triggered it, because losing a few minutes of buffered work
 * on save failure is strictly less bad than refusing the agent's
 * write and getting stuck mid-task.
 */
export interface AuditBufferPersistence {
  /** Persist the current set of entries. Called after every mutation. */
  save(entries: BufferedChange[]): Promise<void>;
  /** Load previously-persisted entries, or null when nothing is stored. */
  load(): Promise<BufferedChange[] | null>;
  /** Remove the persisted state entirely. Called after a clean flush. */
  clear(): Promise<void>;
}

/** Error thrown by `flush()` when a subset of writes failed after
 *  others had already committed. Carries the list of applied paths so
 *  the caller can inform the user about the partial state. */
export class AuditFlushError extends Error {
  constructor(
    message: string,
    public readonly applied: string[],
    public readonly failed: Array<{ path: string; error: string }>,
  ) {
    super(message);
    this.name = 'AuditFlushError';
  }
}

export class AuditBuffer {
  private readonly entries = new Map<string, BufferedChange>();
  private persistence: AuditBufferPersistence | null = null;

  /**
   * Wire a persistence layer (v0.61 a.3). Optional — a buffer without
   * persistence behaves exactly like v0.60. Setter (not constructor
   * arg) so the extension can initialize the buffer lazily on first
   * agent run without forcing activation-time `.sidecar/` setup for
   * users who never touch Audit Mode.
   */
  setPersistence(persistence: AuditBufferPersistence | null): void {
    this.persistence = persistence;
  }

  /**
   * Restore entries from a previously-persisted snapshot (v0.61 a.3).
   * Intended for one-time use at activation — subsequent writes go
   * through `write()` / `deleteFile()`. Replaces any in-memory state.
   */
  restore(entries: BufferedChange[]): void {
    this.entries.clear();
    for (const entry of entries) {
      this.entries.set(entry.path, entry);
    }
  }

  /**
   * Fire-and-forget persistence. Called from every mutation after the
   * in-memory state has been updated. Errors are swallowed with a
   * `console.warn` because dropping a persisted save is strictly
   * better than failing a mutation the agent needs to keep working.
   */
  private async persist(): Promise<void> {
    if (!this.persistence) return;
    try {
      if (this.entries.size === 0) {
        await this.persistence.clear();
      } else {
        await this.persistence.save(this.list());
      }
    } catch (err) {
      console.warn('[AuditBuffer] persist failed (in-memory state retained):', err);
    }
  }

  /**
   * Record a full write (`write_file`) into the buffer. Captures the
   * original disk content the first time the path is written so later
   * flushes know whether to create or modify, and so a reject returns
   * the file to its exact prior state (not just the content the agent
   * initially read).
   */
  async write(filePath: string, content: string, readDisk: ReadDiskFn): Promise<void> {
    const existing = this.entries.get(filePath);
    // originalContent is captured once on first buffer entry for this
    // path, then reused through subsequent edits. Without this, every
    // edit_file pass would overwrite the baseline we flush against.
    const originalContent = existing?.originalContent ?? (await readDisk(filePath));
    const op: BufferedOp = originalContent === undefined ? 'create' : 'modify';
    this.entries.set(filePath, {
      path: filePath,
      op,
      content,
      originalContent,
      timestamp: Date.now(),
    });
    await this.persist();
  }

  /**
   * Record a `delete_file` into the buffer. A file created-then-deleted
   * within the buffer is removed from the buffer entirely (neutral) so
   * a flush doesn't try to delete a path that never existed on disk.
   */
  async deleteFile(filePath: string, readDisk: ReadDiskFn): Promise<void> {
    const existing = this.entries.get(filePath);
    if (existing?.op === 'create') {
      // Net no-op: we were going to create this, now we're deleting it.
      this.entries.delete(filePath);
      await this.persist();
      return;
    }
    const originalContent = existing?.originalContent ?? (await readDisk(filePath));
    this.entries.set(filePath, {
      path: filePath,
      op: 'delete',
      originalContent,
      timestamp: Date.now(),
    });
    await this.persist();
  }

  /**
   * Read-through: agent reads see the buffered content when the path
   * has a pending write, disk content otherwise. Returns `undefined`
   * when the buffer has this path marked for delete (agent should see
   * the file as gone) or when no buffer entry exists (caller falls
   * back to disk).
   *
   * Distinguishes "not in buffer" from "buffered delete" via the
   * second element of the tuple. Callers that only care about content
   * can destructure and check; callers that need to know the agent
   * should see "file not found" check the `deleted` flag.
   */
  read(filePath: string): { content: string | undefined; deleted: boolean; buffered: boolean } {
    const entry = this.entries.get(filePath);
    if (!entry) return { content: undefined, deleted: false, buffered: false };
    if (entry.op === 'delete') return { content: undefined, deleted: true, buffered: true };
    return { content: entry.content, deleted: false, buffered: true };
  }

  /** True when this path has any pending write (create/modify/delete). */
  has(filePath: string): boolean {
    return this.entries.has(filePath);
  }

  /** List every buffered entry, newest first. Consumers render this. */
  list(): BufferedChange[] {
    return Array.from(this.entries.values()).sort((a, b) => b.timestamp - a.timestamp);
  }

  /** Number of buffered entries. `0` means nothing pending. */
  get size(): number {
    return this.entries.size;
  }

  get isEmpty(): boolean {
    return this.entries.size === 0;
  }

  /**
   * Flush buffered changes to disk. All entries apply in one pass; if
   * any single write / delete throws, the already-applied entries are
   * rolled back to their originalContent and the error is thrown as an
   * `AuditFlushError` carrying the applied + failed lists.
   *
   * On success, the buffer is cleared. On partial failure, successful
   * entries have been rolled back so the caller can safely leave the
   * buffer populated for a retry — nothing lands on disk unless
   * everything does.
   *
   * Accepts only a subset of paths when `paths` is provided — the
   * rest stay in the buffer untouched. Per-hunk UI will pass a path
   * list here when the user accepts some entries and defers others;
   * the v0.60 MVP command handlers pass `undefined` for accept-all.
   */
  async flush(writeDisk: WriteDiskFn, deleteDisk: DeleteDiskFn, paths?: string[]): Promise<{ applied: string[] }> {
    const targetEntries = paths
      ? (paths.map((p) => this.entries.get(p)).filter(Boolean) as BufferedChange[])
      : Array.from(this.entries.values());

    const applied: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    const rollback: Array<() => Promise<void>> = [];

    for (const entry of targetEntries) {
      try {
        if (entry.op === 'delete') {
          await deleteDisk(entry.path);
          rollback.push(async () => {
            if (entry.originalContent !== undefined) {
              await writeDisk(entry.path, entry.originalContent);
            }
          });
        } else {
          await writeDisk(entry.path, entry.content ?? '');
          rollback.push(async () => {
            if (entry.originalContent === undefined) {
              // Was a create — rollback by deleting
              await deleteDisk(entry.path).catch(() => {}); // best-effort
            } else {
              await writeDisk(entry.path, entry.originalContent);
            }
          });
        }
        applied.push(entry.path);
      } catch (err) {
        failed.push({ path: entry.path, error: err instanceof Error ? err.message : String(err) });
        // Trigger rollback for everything that succeeded before this
        // failure. We don't process further entries once any fails.
        for (const undo of rollback.reverse()) {
          try {
            await undo();
          } catch {
            // Best-effort rollback — if the rollback itself fails the
            // user is already in a partial-state bad spot; log via
            // AuditFlushError's `applied` list but don't throw here.
          }
        }
        throw new AuditFlushError(
          `Audit flush failed on ${entry.path}: ${failed[0].error}. ${applied.length} prior writes rolled back.`,
          applied,
          failed,
        );
      }
    }

    // All-or-nothing succeeded — clear buffer entries we flushed.
    for (const entry of targetEntries) {
      this.entries.delete(entry.path);
    }
    await this.persist();

    return { applied };
  }

  /** Drop entries from the buffer without touching disk. `paths`
   *  omitted clears everything. Used by Reject All / per-file Reject.
   *  Persists asynchronously in the background since the call site
   *  is synchronous (matches the pre-v0.61 API contract). */
  clear(paths?: string[]): void {
    if (!paths) {
      this.entries.clear();
    } else {
      for (const p of paths) this.entries.delete(p);
    }
    // Fire-and-forget — this stays non-async so callers don't need
    // to thread await through reject-flow code that already works.
    void this.persist();
  }
}

// ---------------------------------------------------------------------------
// Process-wide singleton. Extension activation creates it once;
// fs.ts tools read it on every dispatch when agent mode is 'audit'.
// Kept behind an accessor so tests can swap it out cleanly.
// ---------------------------------------------------------------------------

let _defaultBuffer: AuditBuffer | null = null;

export function getDefaultAuditBuffer(): AuditBuffer {
  if (!_defaultBuffer) _defaultBuffer = new AuditBuffer();
  return _defaultBuffer;
}

/** Test-only: replace the singleton so unit tests can supply a fresh
 *  buffer without polluting each other's state. */
export function __setDefaultAuditBufferForTests(buffer: AuditBuffer | null): void {
  _defaultBuffer = buffer;
}
