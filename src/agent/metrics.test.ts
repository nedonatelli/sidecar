import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MetricsCollector } from './metrics.js';

function createMockMemento() {
  const store = new Map<string, unknown>();
  return {
    get: vi.fn(<T>(key: string, defaultValue?: T) => (store.has(key) ? store.get(key) : defaultValue)),
    update: vi.fn((key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    }),
    keys: vi.fn(() => [...store.keys()]),
  };
}

describe('MetricsCollector', () => {
  let memento: ReturnType<typeof createMockMemento>;
  let collector: MetricsCollector;

  beforeEach(() => {
    memento = createMockMemento();
    collector = new MetricsCollector(memento as never);
  });

  it('getHistory returns empty array by default', () => {
    expect(collector.getHistory()).toEqual([]);
  });

  it('startRun and endRun persists a run', () => {
    collector.startRun();
    collector.endRun();
    const history = collector.getHistory();
    expect(history).toHaveLength(1);
    expect(history[0]).toHaveProperty('timestamp');
    expect(history[0]).toHaveProperty('durationMs');
    expect(history[0].iterations).toBe(0);
    expect(history[0].toolCalls).toEqual([]);
    expect(history[0].errors).toEqual([]);
  });

  it('recordIteration increments iteration count', () => {
    collector.startRun();
    collector.recordIteration();
    collector.recordIteration();
    collector.endRun();
    expect(collector.getHistory()[0].iterations).toBe(2);
  });

  it('recordToolStart and recordToolEnd logs tool calls', () => {
    collector.startRun();
    collector.recordToolStart();
    collector.recordToolEnd('read_file', false);
    collector.recordToolStart();
    collector.recordToolEnd('write_file', true);
    collector.endRun();
    const calls = collector.getHistory()[0].toolCalls;
    expect(calls).toHaveLength(2);
    expect(calls[0].name).toBe('read_file');
    expect(calls[0].isError).toBe(false);
    expect(calls[1].name).toBe('write_file');
    expect(calls[1].isError).toBe(true);
  });

  it('recordTokens accumulates token estimate', () => {
    collector.startRun();
    collector.recordTokens(400); // 100 tokens
    collector.recordTokens(200); // 50 more tokens
    collector.endRun();
    expect(collector.getHistory()[0].totalTokensEstimate).toBe(150);
  });

  it('recordError logs errors', () => {
    collector.startRun();
    collector.recordError('something broke');
    collector.endRun();
    expect(collector.getHistory()[0].errors).toEqual(['something broke']);
  });

  it('endRun is no-op without startRun', () => {
    collector.endRun();
    expect(collector.getHistory()).toEqual([]);
  });

  it('recordIteration is no-op without startRun', () => {
    collector.recordIteration(); // should not throw
    expect(collector.getHistory()).toEqual([]);
  });

  it('recordTokens is no-op without startRun', () => {
    collector.recordTokens(100); // should not throw
  });

  it('limits history to 100 entries', () => {
    for (let i = 0; i < 105; i++) {
      collector.startRun();
      collector.endRun();
    }
    expect(collector.getHistory()).toHaveLength(100);
  });
});
