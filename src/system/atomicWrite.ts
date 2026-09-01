import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Write a file atomically: serialize to a sibling temp file, then rename over
 * the target. A crash mid-write leaves either the old file or the new one,
 * never half of one.
 *
 * This exists because "write straight over the live path" produced real damage
 * more than once: a truncated memory store on the next start looked exactly
 * like a corrupt one and got overwritten, and a half-written PID manifest means
 * the next session cannot clean up the processes the last one leaked.
 *
 * The temp path is unique per write. A shared `<file>.tmp` races whenever two
 * writes overlap — the first rename moves it away and the second fails with
 * ENOENT, silently losing that write. That was a real bug in the first cut of
 * this, caught by its own tests.
 *
 * Errors propagate. A caller that cannot await must record the failure as
 * observable state; swallowing it makes silent data loss indistinguishable
 * from success, which is the defect this whole module exists to prevent.
 */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${++writeCounter}.tmp`;
  await fs.writeFile(tmp, data, 'utf8');
  try {
    await renameWithRetry(tmp, file);
  } catch (err: unknown) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Windows rename failures that are contention, not a real error. */
const TRANSIENT_RENAME_ERRORS = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_BACKOFF_MS = [5, 10, 25, 50, 100];

/**
 * Rename, retrying the errors Windows raises for a target someone else holds
 * open. POSIX replaces the target atomically no matter who has it open, so this
 * loop is a no-op there. Windows instead fails with EPERM/EACCES/EBUSY when the
 * destination has a live handle — a concurrent write of the same file, a virus
 * scanner, or the search indexer — and the caller saw a hard write failure for
 * something that resolves in milliseconds.
 *
 * Retrying does not weaken the guarantee this module exists for: the rename
 * either replaces the target or it does not, so no reader ever sees a partial
 * file. Only the last error propagates, so a genuine permission problem still
 * surfaces rather than looping.
 */
async function renameWithRetry(tmp: string, file: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(tmp, file);
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      if (!TRANSIENT_RENAME_ERRORS.has(code) || attempt >= RENAME_BACKOFF_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, RENAME_BACKOFF_MS[attempt]));
    }
  }
}

/** Distinguishes overlapping writes to the same file within one process. */
let writeCounter = 0;
