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
    await fs.rename(tmp, file);
  } catch (err: unknown) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Distinguishes overlapping writes to the same file within one process. */
let writeCounter = 0;
