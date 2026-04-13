/**
 * Per-path mutex for file writes.
 *
 * The agent loop executes tools in parallel via `Promise.allSettled`, which
 * means two concurrent `write_file` / `edit_file` calls targeting the same
 * path can race: both read the pre-edit content, both write modified
 * content, and the second silently clobbers the first. This module provides
 * a `withFileLock(absPath, task)` helper that serializes tasks on a given
 * path while still letting unrelated paths run in parallel.
 *
 * The implementation is a FIFO queue: each `withFileLock` call grabs the
 * current tail of the queue for its path, installs its own promise as the
 * new tail, waits for the previous tail to settle, runs its task, then
 * releases. The queue entry is cleaned up when nobody else is waiting
 * behind it, so long-lived sessions don't leak map entries.
 *
 * Module-level `Map` is deliberate: every concurrent `executeTool` call
 * in the same process needs to share the same lock registry for the
 * mutex to work. This is one of the few legitimate uses of global state.
 */

const locks = new Map<string, Promise<void>>();

/**
 * Run `task` while holding an exclusive lock on `absPath`. Callers with
 * different paths proceed concurrently; callers with the same path run
 * one at a time in the order they entered.
 *
 * The lock is released whether `task` resolves or rejects, so a failed
 * write never deadlocks subsequent writes to the same path.
 */
export async function withFileLock<T>(absPath: string, task: () => Promise<T>): Promise<T> {
  const previous = locks.get(absPath) ?? Promise.resolve();
  let releaseLock: () => void = () => {
    /* assigned synchronously below */
  };
  const gate = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  locks.set(absPath, gate);

  try {
    await previous;
    return await task();
  } finally {
    releaseLock();
    // Clean up the map entry only if nobody else queued behind us while we
    // were running. If another caller installed a newer tail, leave their
    // entry in place so they can finish their turn.
    if (locks.get(absPath) === gate) {
      locks.delete(absPath);
    }
  }
}

/** Test hook: number of paths currently holding a lock. */
export function getActiveLockCount(): number {
  return locks.size;
}

/** Test hook: reset all locks. Do not call from production code. */
export function __resetFileLocksForTests(): void {
  locks.clear();
}
