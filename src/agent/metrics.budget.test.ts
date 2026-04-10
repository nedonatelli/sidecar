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

describe('MetricsCollector budget tracking', () => {
  let memento: ReturnType<typeof createMockMemento>;
  let collector: MetricsCollector;

  beforeEach(() => {
    memento = createMockMemento();
    collector = new MetricsCollector(memento as never);
  });

  it('recordCost stores cost on current run', () => {
    collector.startRun();
    collector.recordCost(0.05);
    collector.endRun();
    const history = collector.getHistory();
    expect(history[0].costUsd).toBe(0.05);
  });

  it('recordCost with null for local models', () => {
    collector.startRun();
    collector.recordCost(null);
    collector.endRun();
    expect(collector.getHistory()[0].costUsd).toBeNull();
  });

  it('getSpendSince sums costs within time window', () => {
    const now = Date.now();
    // Manually inject history with known timestamps
    memento.update('sidecar.metrics', [
      {
        timestamp: now - 1000,
        costUsd: 0.1,
        iterations: 0,
        toolCalls: [],
        totalTokensEstimate: 0,
        durationMs: 0,
        errors: [],
      },
      {
        timestamp: now - 500,
        costUsd: 0.2,
        iterations: 0,
        toolCalls: [],
        totalTokensEstimate: 0,
        durationMs: 0,
        errors: [],
      },
      {
        timestamp: now - 100000,
        costUsd: 0.5,
        iterations: 0,
        toolCalls: [],
        totalTokensEstimate: 0,
        durationMs: 0,
        errors: [],
      },
    ]);
    // Only the first two are within the last 5 seconds
    expect(collector.getSpendSince(now - 5000)).toBeCloseTo(0.3);
  });

  it('getSpendSince excludes null costs (local models)', () => {
    const now = Date.now();
    memento.update('sidecar.metrics', [
      {
        timestamp: now - 100,
        costUsd: 0.1,
        iterations: 0,
        toolCalls: [],
        totalTokensEstimate: 0,
        durationMs: 0,
        errors: [],
      },
      {
        timestamp: now - 50,
        costUsd: null,
        iterations: 0,
        toolCalls: [],
        totalTokensEstimate: 0,
        durationMs: 0,
        errors: [],
      },
    ]);
    expect(collector.getSpendSince(now - 5000)).toBeCloseTo(0.1);
  });

  it('getDailySpend returns spend since midnight', () => {
    const d = new Date();
    const startOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    memento.update('sidecar.metrics', [
      {
        timestamp: startOfDay + 1000,
        costUsd: 0.25,
        iterations: 0,
        toolCalls: [],
        totalTokensEstimate: 0,
        durationMs: 0,
        errors: [],
      },
    ]);
    expect(collector.getDailySpend()).toBeCloseTo(0.25);
  });

  it('getWeeklySpend returns spend since Monday', () => {
    memento.update('sidecar.metrics', [
      {
        timestamp: Date.now() - 1000,
        costUsd: 0.15,
        iterations: 0,
        toolCalls: [],
        totalTokensEstimate: 0,
        durationMs: 0,
        errors: [],
      },
    ]);
    // This run is definitely within the current week
    expect(collector.getWeeklySpend()).toBeGreaterThanOrEqual(0.15);
  });
});
