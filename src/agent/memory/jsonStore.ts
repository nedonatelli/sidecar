// Durable JSON store primitives — the read/write half of every memory store.
//
// Both memory stores independently got the same two things wrong, and together
// they form a loop that destroys user data from one transient error:
//
//   1. LOAD SWALLOWED EVERYTHING. `catch { this.entries = [] }` treats "the file
//      isn't there yet" and "I could not read the file" as the same outcome —
//      an empty store, reported as ready. Nothing distinguishes a first run
//      from an EACCES, an EMFILE under load, or a truncated JSON.
//   2. THE NEXT WRITE OVERWROTE THE FILE IT COULD NOT READ. The store persists
//      the whole in-memory collection, so the first add() after a failed load
//      writes `[]` over the only copy. Every remembered instruction is gone,
//      and the log line saying so scrolled past minutes earlier.
//
// Non-atomic writes closed the loop: `writeFile` straight over the live path
// leaves a truncated file if the process dies mid-write, which is exactly the
// unreadable input that triggers (1) on the next start.
//
// So: a store that cannot be READ is never overwritten. Its bytes are moved
// aside, intact, and the failure is reported to the caller instead of being
// logged into the void. Writes go to a temp file and rename into place, which
// is atomic within a directory on POSIX — a crash leaves either the old file or
// the new one, never half of one.

import * as fs from 'fs/promises';
import * as path from 'path';

export interface StoreFailure {
  /** What actually went wrong — an fs error, or a JSON syntax error. */
  error: Error;
  /** Where the unreadable bytes were moved, or null if they could not be moved. */
  quarantinedTo: string | null;
  /**
   * True when the bytes could neither be read NOR moved aside. Writing would
   * destroy them, so the store must refuse to persist until a human intervenes.
   */
  persistBlocked: boolean;
}

export interface StoreLoad<T> {
  /** Parsed contents, or null when the file does not exist yet or could not be read. */
  value: T | null;
  /** Null on a clean load (including a legitimately absent file). */
  failure: StoreFailure | null;
}

/**
 * Read and parse a JSON store. An absent file is a clean, empty result — that is
 * a first run, not an error. Anything else (unreadable, unparseable) moves the
 * existing bytes aside and reports the failure so the caller can refuse to
 * overwrite them.
 *
 * `now` is injectable so the quarantine filename is deterministic in tests.
 */
export async function readJsonStore<T>(file: string, now: () => number = Date.now): Promise<StoreLoad<T>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { value: null, failure: null };
    return { value: null, failure: await quarantine(file, asError(err), now) };
  }
  try {
    return { value: JSON.parse(raw) as T, failure: null };
  } catch (err: unknown) {
    return { value: null, failure: await quarantine(file, asError(err), now) };
  }
}

/**
 * Write a JSON store atomically: serialize to a sibling temp file, then rename
 * over the target. A crash mid-write leaves the previous file intact rather
 * than a truncated one that the next load cannot parse.
 *
 * Errors propagate. A caller that cannot await (a fire-and-forget auto-save)
 * must record the failure as observable state — never swallow it, because the
 * whole point is that silent non-persistence is indistinguishable from success.
 */
export async function writeJsonStoreAtomic(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  // The temp path must be unique per write. A shared `${file}.tmp` races when
  // two saves overlap — an auto-save chain plus a direct save() is enough:
  // both write the same temp, the first renames it away, the second's rename
  // fails with ENOENT and the save is lost.
  const tmp = `${file}.${process.pid}.${++writeCounter}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  try {
    await fs.rename(tmp, file);
  } catch (err: unknown) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Move unreadable bytes out of the way so a later write cannot destroy them. */
async function quarantine(file: string, error: Error, now: () => number): Promise<StoreFailure> {
  const target = `${file}.unreadable-${now()}`;
  try {
    await fs.rename(file, target);
    return { error, quarantinedTo: target, persistBlocked: false };
  } catch {
    // Could not read it and cannot move it — the only safe move left is to
    // refuse to write over it.
    return { error, quarantinedTo: null, persistBlocked: true };
  }
}

const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));

/** Distinguishes overlapping writes to the same store within one process. */
let writeCounter = 0;
