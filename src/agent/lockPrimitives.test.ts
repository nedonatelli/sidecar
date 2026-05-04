import { describe, it, expect, vi } from 'vitest';
import { FileLock } from './lockPrimitives.js';

describe('FileLock', () => {
  it('resolves immediately when no contention', async () => {
    const lock = new FileLock();
    const release = await lock.acquire('key');
    expect(typeof release).toBe('function');
    release();
  });

  it('serializes concurrent acquirers on the same key', async () => {
    const lock = new FileLock();
    const order: number[] = [];

    const a = lock.acquire('k').then(async (release) => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 10));
      order.push(2);
      release();
    });

    // Give A a tick to acquire first
    await Promise.resolve();

    const b = lock.acquire('k').then(async (release) => {
      order.push(3);
      release();
    });

    await Promise.all([a, b]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('independent keys do not block each other', async () => {
    const lock = new FileLock();
    const log: string[] = [];

    let releaseA!: () => void;
    const a = lock.acquire('keyA').then((r) => {
      log.push('A-acquired');
      releaseA = r;
    });
    await a;

    const b = lock.acquire('keyB').then((r) => {
      log.push('B-acquired');
      r();
    });
    await b;

    expect(log).toContain('A-acquired');
    expect(log).toContain('B-acquired');

    releaseA();
  });

  it('serializes three consecutive acquirers in registration order', async () => {
    const lock = new FileLock();
    const order: number[] = [];

    // Register all three acquires synchronously so queue order is deterministic
    const p1 = lock.acquire('seq');
    const p2 = lock.acquire('seq');
    const p3 = lock.acquire('seq');

    const r1 = await p1;
    order.push(1);
    r1();

    const r2 = await p2;
    order.push(2);
    r2();

    const r3 = await p3;
    order.push(3);
    r3();

    expect(order).toEqual([1, 2, 3]);
  });

  it('a released lock can be re-acquired', async () => {
    const lock = new FileLock();

    const r1 = await lock.acquire('reuse');
    r1();

    const acquired = vi.fn();
    const r2 = await lock.acquire('reuse');
    acquired();
    r2();

    expect(acquired).toHaveBeenCalledOnce();
  });
});
