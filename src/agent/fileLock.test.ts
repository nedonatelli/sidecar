import { describe, it, expect, beforeEach } from 'vitest';
import { withFileLock, getActiveLockCount, __resetFileLocksForTests } from './fileLock.js';

describe('withFileLock', () => {
  beforeEach(() => {
    __resetFileLocksForTests();
  });

  it('runs a single task normally', async () => {
    const result = await withFileLock('/a', async () => 42);
    expect(result).toBe(42);
  });

  it('serializes tasks on the same path in FIFO order', async () => {
    const order: number[] = [];
    const start = (n: number, delay: number) =>
      withFileLock('/a', async () => {
        order.push(n);
        await new Promise((r) => setTimeout(r, delay));
        order.push(-n);
      });

    // Kick off three tasks simultaneously. Even though the first one
    // takes longest, the second and third must wait for it to finish
    // before they start — otherwise the -n entries would interleave.
    await Promise.all([start(1, 20), start(2, 1), start(3, 1)]);

    expect(order).toEqual([1, -1, 2, -2, 3, -3]);
  });

  it('lets tasks on different paths run in parallel', async () => {
    const order: string[] = [];
    const make = (path: string, delay: number) =>
      withFileLock(path, async () => {
        order.push(`${path}-start`);
        await new Promise((r) => setTimeout(r, delay));
        order.push(`${path}-end`);
      });

    // /a takes longer than /b but runs concurrently, so /b should finish
    // before /a does. That means the final order is: /a-start, /b-start,
    // /b-end, /a-end — overlapping, not strictly serial.
    await Promise.all([make('/a', 30), make('/b', 5)]);

    expect(order[0]).toBe('/a-start');
    expect(order[1]).toBe('/b-start');
    expect(order[2]).toBe('/b-end');
    expect(order[3]).toBe('/a-end');
  });

  it('releases the lock after a task throws', async () => {
    let firstRan = false;
    await expect(
      withFileLock('/a', async () => {
        firstRan = true;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(firstRan).toBe(true);

    // The second task should still be able to run — the lock is released
    // even on failure.
    const result = await withFileLock('/a', async () => 'ok');
    expect(result).toBe('ok');
  });

  it('cleans up the lock entry when the last waiter finishes', async () => {
    await withFileLock('/a', async () => {
      /* no-op */
    });
    expect(getActiveLockCount()).toBe(0);
  });

  it('does not leak entries across many sequential uses', async () => {
    for (let i = 0; i < 50; i++) {
      await withFileLock(`/file-${i}`, async () => i);
    }
    expect(getActiveLockCount()).toBe(0);
  });

  it('returns the task value on success', async () => {
    const result = await withFileLock('/a', async () => ({ ok: true }));
    expect(result).toEqual({ ok: true });
  });
});
