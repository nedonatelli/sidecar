import { describe, it, expect, vi } from 'vitest';
import { runWithCap, runForEachWithCap, AbortedBeforeStartError } from './parallelDispatch.js';

// ---------------------------------------------------------------------------
// Tests for parallelDispatch.ts (v0.67 chunk 2).
//
// The primitive is used by multi-file edit, facet dispatch, and the
// upcoming Fork & Parallel Solve — so the test matrix covers every
// call site's contract: ordered results, bounded concurrency, signal
// cancellation before + during a run, error isolation, empty inputs.
// ---------------------------------------------------------------------------

function makeTasks(values: readonly number[]): (() => Promise<number>)[] {
  return values.map((v) => async () => v);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('runWithCap — basic behavior', () => {
  it('returns an empty array when given no tasks', async () => {
    const out = await runWithCap([]);
    expect(out).toEqual([]);
  });

  it('fulfills every task and preserves input order', async () => {
    const out = await runWithCap(makeTasks([1, 2, 3, 4]));
    expect(out.map((o) => (o.status === 'fulfilled' ? o.value : null))).toEqual([1, 2, 3, 4]);
  });

  it('captures rejection reasons without throwing', async () => {
    const tasks = [
      async () => 1,
      async () => {
        throw new Error('kaboom');
      },
      async () => 3,
    ];
    const out = await runWithCap(tasks);
    expect(out[0]).toEqual({ status: 'fulfilled', value: 1 });
    expect(out[1].status).toBe('rejected');
    if (out[1].status === 'rejected') {
      expect((out[1].reason as Error).message).toBe('kaboom');
    }
    expect(out[2]).toEqual({ status: 'fulfilled', value: 3 });
  });
});

describe('runWithCap — concurrency cap', () => {
  it('caps in-flight tasks at the configured value', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const tasks: (() => Promise<number>)[] = Array.from({ length: 10 }, (_, i) => async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5);
      inFlight--;
      return i;
    });
    await runWithCap(tasks, { cap: 3 });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('runs tasks serially when cap = 1', async () => {
    const order: number[] = [];
    const tasks: (() => Promise<void>)[] = Array.from({ length: 4 }, (_, i) => async () => {
      order.push(i);
      await delay(2);
    });
    await runWithCap(tasks, { cap: 1 });
    expect(order).toEqual([0, 1, 2, 3]);
  });

  it('clamps cap > tasks.length to tasks.length (no idle workers)', async () => {
    const out = await runWithCap(makeTasks([1, 2]), { cap: 100 });
    expect(out).toHaveLength(2);
    expect(out[0].status).toBe('fulfilled');
  });

  it('clamps cap < 1 to 1 (never zero workers)', async () => {
    const out = await runWithCap(makeTasks([1, 2]), { cap: 0 });
    expect(out).toHaveLength(2);
    expect(out.every((o) => o.status === 'fulfilled')).toBe(true);
  });
});

describe('runWithCap — abort signal', () => {
  it('returns all slots as AbortedBeforeStart when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const out = await runWithCap(makeTasks([1, 2, 3]), { signal: ac.signal });
    expect(out).toHaveLength(3);
    for (const o of out) {
      expect(o.status).toBe('rejected');
      if (o.status === 'rejected') {
        expect(o.reason).toBeInstanceOf(AbortedBeforeStartError);
        expect((o.reason as Error).name).toBe('AbortedBeforeStart');
      }
    }
  });

  it('stops claiming new tasks when signal fires mid-run', async () => {
    const ac = new AbortController();
    const started: number[] = [];
    const tasks: (() => Promise<number>)[] = Array.from({ length: 20 }, (_, i) => async () => {
      started.push(i);
      if (i === 2) ac.abort(); // fire after third task claimed
      await delay(5);
      return i;
    });
    const out = await runWithCap(tasks, { cap: 1, signal: ac.signal });
    // At least the first few ran; later tasks are AbortedBeforeStart.
    expect(started.length).toBeLessThan(20);
    const abortedCount = out.filter(
      (o) => o.status === 'rejected' && (o.reason as Error).name === 'AbortedBeforeStart',
    ).length;
    expect(abortedCount).toBeGreaterThan(0);
  });

  it('in-flight tasks complete normally even after abort', async () => {
    const ac = new AbortController();
    let completedLongTask = false;
    const tasks: (() => Promise<string>)[] = [
      async () => {
        await delay(20);
        completedLongTask = true;
        return 'long-done';
      },
      async () => {
        await delay(1);
        ac.abort();
        return 'trigger';
      },
    ];
    const out = await runWithCap(tasks, { cap: 2, signal: ac.signal });
    expect(completedLongTask).toBe(true);
    expect(out[0]).toEqual({ status: 'fulfilled', value: 'long-done' });
    expect(out[1]).toEqual({ status: 'fulfilled', value: 'trigger' });
  });
});

describe('runForEachWithCap — worker pattern', () => {
  it('calls the worker for every item in bounded parallelism', async () => {
    const seen: number[] = [];
    await runForEachWithCap([1, 2, 3, 4, 5], async (n) => {
      seen.push(n);
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5]);
  });

  it('swallows errors thrown by the worker', async () => {
    const seen: number[] = [];
    await runForEachWithCap(
      [1, 2, 3],
      async (n) => {
        seen.push(n);
        if (n === 2) throw new Error('middle task threw');
      },
      { cap: 1 },
    );
    // Worker for n=3 still runs despite n=2 throwing.
    expect(seen).toContain(3);
  });

  it('honors cap', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await runForEachWithCap(
      Array.from({ length: 10 }, (_, i) => i),
      async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(3);
        inFlight--;
      },
      { cap: 2 },
    );
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it('short-circuits on an already-aborted signal', async () => {
    const ac = new AbortController();
    ac.abort();
    const worker = vi.fn(async () => undefined);
    await runForEachWithCap([1, 2, 3], worker, { signal: ac.signal });
    expect(worker).not.toHaveBeenCalled();
  });

  it('is a no-op on empty input', async () => {
    const worker = vi.fn(async () => undefined);
    await runForEachWithCap([], worker);
    expect(worker).not.toHaveBeenCalled();
  });
});
