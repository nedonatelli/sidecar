import { describe, it, expect, beforeEach } from 'vitest';
import * as path from 'path';
import { withFileLock, getActiveLockCount, __resetFileLocksForTests, lockKey } from './fileLock.js';

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

// #122: lock keys were the raw path, so two spellings of one file got two
// locks and their writes could still race.
describe('lockKey', () => {
  it('gives every Windows spelling of one file the same key', () => {
    const spellings = [
      String.raw`C:\repo\a.ts`,
      'c:/repo/a.ts',
      String.raw`C:\repo\x\..\a.ts`,
      String.raw`C:\REPO\A.TS`,
    ];
    const keys = spellings.map((p) => lockKey(p, 'win32'));
    expect(new Set(keys).size).toBe(1);
  });

  it('keeps POSIX paths case-sensitive but resolves dot segments', () => {
    expect(lockKey('/repo/x/../a.ts', 'linux')).toBe(lockKey('/repo/a.ts', 'linux'));
    expect(lockKey('/repo/A.ts', 'linux')).not.toBe(lockKey('/repo/a.ts', 'linux'));
  });

  it('serializes two spellings of the same file', async () => {
    const order: string[] = [];
    const base = path.resolve('lock-test-dir', 'f.ts');
    // Built by hand so it stays un-normalized: same file, different spelling.
    const other = [path.dirname(base), 'sub', '..', 'f.ts'].join(path.sep);
    let releaseFirst: () => void = () => {};
    const first = withFileLock(base, async () => {
      order.push('first:start');
      await new Promise<void>((r) => (releaseFirst = r));
      order.push('first:end');
    });
    const second = withFileLock(other, async () => {
      order.push('second');
    });
    await new Promise((r) => setTimeout(r, 10));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });
});
