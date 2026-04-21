/**
 * Simple promise-chain based lock for coordinating access to shared resources.
 * Each key has its own chain — acquiring a lock on key "file1" doesn't block
 * acquisitions on key "file2", but multiple acquirers on the same key serialize.
 *
 * Usage:
 *   const lock = new FileLock();
 *   const release = await lock.acquire('critical-section');
 *   try {
 *     // critical section
 *   } finally {
 *     release();
 *   }
 */
export class FileLock {
  private locks = new Map<string, Promise<void>>();

  /**
   * Acquire a lock on the given key.
   * Resolves when the lock is acquired (i.e., all previous holders have released).
   * @returns A function to call when done — releases the lock for the next waiter.
   */
  async acquire(key: string): Promise<() => void> {
    // Get the current promise chain for this key (or an immediately-resolved promise if none)
    const prevPromise = this.locks.get(key) ?? Promise.resolve();

    // Create a promise that resolves when this holder releases
    let releaseFunc: () => void;
    const lockPromise = new Promise<void>((resolve) => {
      releaseFunc = resolve;
    });

    // Chain this new lock onto the existing chain
    this.locks.set(
      key,
      prevPromise.then(() => lockPromise),
    );

    // Wait for the previous lock to release before acquiring
    await prevPromise;

    // Return the release function
    return releaseFunc!;
  }
}
