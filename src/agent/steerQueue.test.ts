import { describe, it, expect, vi } from 'vitest';
import {
  SteerQueue,
  SteerQueueFullError,
  STEER_COALESCED_PREFIX,
  DEFAULT_MAX_PENDING,
  type QueuedSteer,
} from './steerQueue.js';

// ---------------------------------------------------------------------------
// Tests for steerQueue.ts (v0.65 chunk 3.1).
//
// SteerQueue is a pure service — no async, no vscode, no loop wiring.
// These tests cover:
//   - enqueue + validation (empty text rejected)
//   - FIFO order preservation on drain
//   - maxPending: drop-oldest-nudge eviction
//   - all-interrupts-full → SteerQueueFullError
//   - cancel/edit semantics (found + not-found paths)
//   - hasInterrupt + clear + size
//   - drain coalescing (single turn, prefix, bullet format)
//   - change-listener firing + error isolation
//   - serialize/restore round-trip preserves createdAt
// ---------------------------------------------------------------------------

function fixedIds(): { genId: () => string; reset: () => void } {
  let n = 0;
  const genId = () => {
    n += 1;
    return `q${n}`;
  };
  return { genId, reset: () => (n = 0) };
}

describe('SteerQueue — enqueue', () => {
  it('rejects empty and whitespace-only text', () => {
    const q = new SteerQueue();
    expect(() => q.enqueue('', 'nudge')).toThrow(/non-empty/);
    expect(() => q.enqueue('   ', 'nudge')).toThrow(/non-empty/);
    expect(q.size()).toBe(0);
  });

  it('trims whitespace and preserves urgency + createdAt from injected clock', () => {
    const { genId } = fixedIds();
    const q = new SteerQueue({ now: () => 1000, genId });
    const entry = q.enqueue('  focus on part A  ', 'nudge');
    expect(entry).toEqual({ id: 'q1', text: 'focus on part A', urgency: 'nudge', createdAt: 1000 });
  });

  it('appends in FIFO order', () => {
    const { genId } = fixedIds();
    const q = new SteerQueue({ genId });
    q.enqueue('first', 'nudge');
    q.enqueue('second', 'nudge');
    q.enqueue('third', 'interrupt');
    expect(q.peek().map((s) => s.text)).toEqual(['first', 'second', 'third']);
  });
});

describe('SteerQueue — maxPending eviction', () => {
  it('drops the oldest nudge when full', () => {
    const { genId } = fixedIds();
    const q = new SteerQueue({ maxPending: 3, genId });
    q.enqueue('a', 'nudge');
    q.enqueue('b', 'nudge');
    q.enqueue('c', 'nudge');
    // Full — next enqueue evicts 'a' (oldest nudge).
    q.enqueue('d', 'nudge');
    expect(q.peek().map((s) => s.text)).toEqual(['b', 'c', 'd']);
  });

  it('preserves interrupts when evicting — drops the oldest nudge even if it is not at index 0', () => {
    const { genId } = fixedIds();
    const q = new SteerQueue({ maxPending: 3, genId });
    q.enqueue('int1', 'interrupt');
    q.enqueue('nudge1', 'nudge');
    q.enqueue('nudge2', 'nudge');
    q.enqueue('overflow', 'nudge');
    const kept = q.peek().map((s) => `${s.urgency}:${s.text}`);
    expect(kept).toEqual(['interrupt:int1', 'nudge:nudge2', 'nudge:overflow']);
  });

  it('throws SteerQueueFullError when every slot is an interrupt', () => {
    const { genId } = fixedIds();
    const q = new SteerQueue({ maxPending: 2, genId });
    q.enqueue('int1', 'interrupt');
    q.enqueue('int2', 'interrupt');
    expect(() => q.enqueue('int3', 'interrupt')).toThrow(SteerQueueFullError);
    // Queue untouched by the failed enqueue.
    expect(q.peek().map((s) => s.text)).toEqual(['int1', 'int2']);
  });

  it('clamps maxPending to at least 1', () => {
    const { genId } = fixedIds();
    const q = new SteerQueue({ maxPending: 0, genId });
    q.enqueue('solo', 'nudge');
    expect(q.size()).toBe(1);
    q.enqueue('evicts-solo', 'nudge');
    expect(q.peek().map((s) => s.text)).toEqual(['evicts-solo']);
  });

  it('defaults maxPending to DEFAULT_MAX_PENDING when no option supplied', () => {
    const q = new SteerQueue();
    for (let i = 0; i < DEFAULT_MAX_PENDING; i++) q.enqueue(`n${i}`, 'nudge');
    expect(q.size()).toBe(DEFAULT_MAX_PENDING);
    q.enqueue('overflow', 'nudge');
    expect(q.size()).toBe(DEFAULT_MAX_PENDING); // eviction held it at cap
  });
});

describe('SteerQueue — cancel + edit', () => {
  it('cancel removes the matching id and returns true', () => {
    const { genId } = fixedIds();
    const q = new SteerQueue({ genId });
    const a = q.enqueue('a', 'nudge');
    q.enqueue('b', 'nudge');
    expect(q.cancel(a.id)).toBe(true);
    expect(q.peek().map((s) => s.text)).toEqual(['b']);
  });

  it('cancel returns false for an unknown id (already drained, typo)', () => {
    const q = new SteerQueue();
    q.enqueue('a', 'nudge');
    expect(q.cancel('nope')).toBe(false);
    expect(q.size()).toBe(1);
  });

  it('edit replaces text in place and returns true', () => {
    const { genId } = fixedIds();
    const q = new SteerQueue({ genId });
    const a = q.enqueue('original', 'nudge');
    expect(q.edit(a.id, '  refined  ')).toBe(true);
    expect(q.peek()[0].text).toBe('refined');
  });

  it('edit returns false for an unknown id', () => {
    const q = new SteerQueue();
    expect(q.edit('missing', 'new')).toBe(false);
  });

  it('edit rejects empty text and does not mutate the entry', () => {
    const { genId } = fixedIds();
    const q = new SteerQueue({ genId });
    const a = q.enqueue('keep me', 'nudge');
    expect(() => q.edit(a.id, '   ')).toThrow(/non-empty/);
    expect(q.peek()[0].text).toBe('keep me');
  });
});

describe('SteerQueue — hasInterrupt / clear / size', () => {
  it('hasInterrupt reflects queue state', () => {
    const q = new SteerQueue();
    expect(q.hasInterrupt()).toBe(false);
    q.enqueue('n', 'nudge');
    expect(q.hasInterrupt()).toBe(false);
    q.enqueue('i', 'interrupt');
    expect(q.hasInterrupt()).toBe(true);
  });

  it('clear empties the queue and notifies listeners once', () => {
    const q = new SteerQueue();
    const listener = vi.fn();
    q.onChange(listener);
    q.enqueue('a', 'nudge');
    q.enqueue('b', 'nudge');
    listener.mockClear();
    q.clear();
    expect(q.size()).toBe(0);
    expect(listener).toHaveBeenCalledOnce();
  });

  it('clear on empty queue does not notify', () => {
    const q = new SteerQueue();
    const listener = vi.fn();
    q.onChange(listener);
    q.clear();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('SteerQueue — drain', () => {
  it('returns null when empty', () => {
    const q = new SteerQueue();
    expect(q.drain()).toBeNull();
  });

  it('coalesces every pending steer into one user message with the spec prefix', () => {
    const { genId } = fixedIds();
    const q = new SteerQueue({ genId });
    q.enqueue('focus on the formula', 'nudge');
    q.enqueue('ignore the other part', 'nudge');
    q.enqueue('actually, use the kernel instead', 'interrupt');
    const drained = q.drain()!;
    expect(drained.items).toHaveLength(3);
    expect(drained.message.role).toBe('user');
    const text = drained.message.content as string;
    expect(text).toContain(STEER_COALESCED_PREFIX);
    // Arrival order preserved in the body.
    const bodyStart = text.indexOf('- focus on the formula');
    const bodyMid = text.indexOf('- ignore the other part');
    const bodyEnd = text.indexOf('- actually, use the kernel instead');
    expect(bodyStart).toBeGreaterThan(0);
    expect(bodyMid).toBeGreaterThan(bodyStart);
    expect(bodyEnd).toBeGreaterThan(bodyMid);
  });

  it('empties the queue after a successful drain', () => {
    const q = new SteerQueue();
    q.enqueue('a', 'nudge');
    q.drain();
    expect(q.size()).toBe(0);
    expect(q.drain()).toBeNull();
  });

  it('notifies listeners on drain (so UI strip clears)', () => {
    const q = new SteerQueue();
    const listener = vi.fn();
    q.onChange(listener);
    q.enqueue('a', 'nudge');
    listener.mockClear();
    q.drain();
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0][0]).toEqual([]); // snapshot is empty after drain
  });
});

describe('SteerQueue — listeners', () => {
  it('onChange fires on enqueue / cancel / edit with a fresh snapshot', () => {
    const { genId } = fixedIds();
    const q = new SteerQueue({ genId });
    const listener = vi.fn();
    q.onChange(listener);
    const a = q.enqueue('a', 'nudge');
    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as QueuedSteer[])[0].text).toBe('a');
    q.edit(a.id, 'a2');
    expect(listener).toHaveBeenCalledTimes(2);
    expect((listener.mock.calls[1][0] as QueuedSteer[])[0].text).toBe('a2');
    q.cancel(a.id);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(listener.mock.calls[2][0]).toEqual([]);
  });

  it('disposer removes the listener', () => {
    const q = new SteerQueue();
    const listener = vi.fn();
    const dispose = q.onChange(listener);
    dispose();
    q.enqueue('a', 'nudge');
    expect(listener).not.toHaveBeenCalled();
  });

  it('a throwing listener does not break queue mutations or other listeners', () => {
    const q = new SteerQueue();
    const bad = vi.fn(() => {
      throw new Error('boom');
    });
    const good = vi.fn();
    q.onChange(bad);
    q.onChange(good);
    expect(() => q.enqueue('a', 'nudge')).not.toThrow();
    expect(bad).toHaveBeenCalledOnce();
    expect(good).toHaveBeenCalledOnce();
  });
});

describe('SteerQueue — serialize / restore', () => {
  it('round-trips queue contents including createdAt', () => {
    let clock = 100;
    const { genId } = fixedIds();
    const q = new SteerQueue({ now: () => clock, genId });
    q.enqueue('a', 'nudge');
    clock = 250;
    q.enqueue('b', 'interrupt');
    const snapshot = q.serialize();

    const q2 = new SteerQueue({ now: () => 99999, genId: fixedIds().genId });
    q2.restore(snapshot);
    const restored = q2.peek();
    expect(restored).toHaveLength(2);
    expect(restored[0]).toEqual({ id: 'q1', text: 'a', urgency: 'nudge', createdAt: 100 });
    expect(restored[1]).toEqual({ id: 'q2', text: 'b', urgency: 'interrupt', createdAt: 250 });
  });

  it('restore replaces any existing contents', () => {
    const q = new SteerQueue();
    q.enqueue('will-be-replaced', 'nudge');
    q.restore([{ id: 'x', text: 'fresh', urgency: 'interrupt', createdAt: 1 }]);
    expect(q.peek().map((s) => s.text)).toEqual(['fresh']);
  });

  it('restore fires a single notify', () => {
    const q = new SteerQueue();
    const listener = vi.fn();
    q.onChange(listener);
    q.restore([
      { id: 'x', text: 'one', urgency: 'nudge', createdAt: 1 },
      { id: 'y', text: 'two', urgency: 'nudge', createdAt: 2 },
    ]);
    expect(listener).toHaveBeenCalledOnce();
  });
});

describe('SteerQueue — peek isolation', () => {
  it('returns a copy that callers cannot mutate into the live queue', () => {
    const q = new SteerQueue();
    q.enqueue('a', 'nudge');
    const snapshot = q.peek() as QueuedSteer[];
    snapshot.length = 0;
    expect(q.size()).toBe(1);
  });
});
