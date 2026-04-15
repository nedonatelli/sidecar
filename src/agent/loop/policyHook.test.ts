/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { HookBus, type HookContext } from './policyHook';
import type { LoopState } from './state';

function makeState(): LoopState {
  // Minimum viable LoopState for the bus — we only care about logger
  // since that's what the error-swallowing path uses.
  return {
    messages: [],
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      logToolCall: vi.fn(),
    },
  } as unknown as LoopState;
}

function makeCtx(overrides: Partial<HookContext> = {}): HookContext {
  return {
    client: {} as any,
    config: {} as any,
    options: {} as any,
    signal: new AbortController().signal,
    callbacks: { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onDone: () => {} },
    ...overrides,
  };
}

describe('HookBus', () => {
  it('runs registered hooks in registration order', async () => {
    const bus = new HookBus();
    const order: string[] = [];
    bus.register({
      name: 'first',
      async afterToolResults() {
        order.push('first');
        return { mutated: false };
      },
    });
    bus.register({
      name: 'second',
      async afterToolResults() {
        order.push('second');
        return { mutated: false };
      },
    });
    await bus.runAfter(makeState(), makeCtx());
    expect(order).toEqual(['first', 'second']);
  });

  it('aggregates HookResult.mutated across hooks', async () => {
    const bus = new HookBus();
    bus.register({
      name: 'noop',
      async afterToolResults() {
        return { mutated: false };
      },
    });
    bus.register({
      name: 'injector',
      async afterToolResults() {
        return { mutated: true, reason: 'injected a reprompt' };
      },
    });
    bus.register({
      name: 'noop2',
      async afterToolResults() {
        return { mutated: false };
      },
    });
    const anyMutated = await bus.runAfter(makeState(), makeCtx());
    expect(anyMutated).toBe(true);
  });

  it('returns false when no hook mutated', async () => {
    const bus = new HookBus();
    bus.register({
      name: 'a',
      async afterToolResults() {
        return { mutated: false };
      },
    });
    const anyMutated = await bus.runAfter(makeState(), makeCtx());
    expect(anyMutated).toBe(false);
  });

  it('treats void return as mutated=false', async () => {
    const bus = new HookBus();
    let called = false;
    bus.register({
      name: 'voidReturn',
      async afterToolResults() {
        called = true;
        // no return value
      },
    });
    const anyMutated = await bus.runAfter(makeState(), makeCtx());
    expect(called).toBe(true);
    expect(anyMutated).toBe(false);
  });

  it('skips hooks that do not implement the phase', async () => {
    const bus = new HookBus();
    const beforeCalled = vi.fn();
    const afterCalled = vi.fn();
    bus.register({ name: 'a', beforeIteration: beforeCalled });
    bus.register({ name: 'b', afterToolResults: afterCalled });
    await bus.runAfter(makeState(), makeCtx());
    expect(beforeCalled).not.toHaveBeenCalled();
    expect(afterCalled).toHaveBeenCalledTimes(1);
  });

  it('swallows errors thrown by a hook and lets later hooks run', async () => {
    const bus = new HookBus();
    const laterCalled = vi.fn();
    bus.register({
      name: 'crasher',
      async afterToolResults() {
        throw new Error('policy crash');
      },
    });
    bus.register({
      name: 'later',
      async afterToolResults() {
        laterCalled();
        return { mutated: true };
      },
    });
    const state = makeState();
    const anyMutated = await bus.runAfter(state, makeCtx());
    expect(laterCalled).toHaveBeenCalled();
    expect(anyMutated).toBe(true);
    expect(state.logger?.warn).toHaveBeenCalledWith(
      expect.stringContaining("Policy hook 'crasher' afterToolResults threw: policy crash"),
    );
  });

  it('runEmptyResponse only fires onEmptyResponse methods', async () => {
    const bus = new HookBus();
    const after = vi.fn();
    const empty = vi.fn(async () => ({ mutated: true }));
    bus.register({ name: 'a', afterToolResults: after });
    bus.register({ name: 'b', onEmptyResponse: empty });
    const anyMutated = await bus.runEmptyResponse(makeState(), makeCtx());
    expect(after).not.toHaveBeenCalled();
    expect(empty).toHaveBeenCalledTimes(1);
    expect(anyMutated).toBe(true);
  });

  it('runTermination fires onTermination methods and swallows errors', async () => {
    const bus = new HookBus();
    const clean = vi.fn();
    bus.register({
      name: 'crasher',
      async onTermination() {
        throw new Error('term crash');
      },
    });
    bus.register({
      name: 'clean',
      onTermination: async () => {
        clean();
      },
    });
    const state = makeState();
    await bus.runTermination(state, makeCtx());
    expect(clean).toHaveBeenCalled();
    expect(state.logger?.warn).toHaveBeenCalledWith(
      expect.stringContaining("Policy hook 'crasher' onTermination threw: term crash"),
    );
  });

  it('list() returns hooks in registration order', () => {
    const bus = new HookBus();
    bus.register({ name: 'a' });
    bus.register({ name: 'b' });
    bus.register({ name: 'c' });
    expect(bus.list().map((h) => h.name)).toEqual(['a', 'b', 'c']);
  });

  it('registerAll registers hooks in array order', () => {
    const bus = new HookBus();
    bus.registerAll([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    expect(bus.list().map((h) => h.name)).toEqual(['a', 'b', 'c']);
  });
});
