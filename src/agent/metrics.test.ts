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

  it('recordCost sets cost on current run', () => {
    collector.startRun();
    collector.recordCost(0.42);
    collector.endRun();
    expect(collector.getHistory()[0].costUsd).toBe(0.42);
  });

  it('recordCost is no-op without startRun', () => {
    collector.recordCost(1.0); // should not throw
  });

  it('getCurrentRunTokens returns 0 when no run is active', () => {
    expect(collector.getCurrentRunTokens()).toBe(0);
  });

  it('getCurrentRunTokens returns token count during an active run', () => {
    collector.startRun();
    collector.recordTokens(400); // 100 tokens
    expect(collector.getCurrentRunTokens()).toBe(100);
  });

  it('getSpendSince sums costs within the window', () => {
    // Seed history directly via startRun/endRun
    const now = Date.now();
    collector.startRun();
    collector.recordCost(1.0);
    collector.endRun();
    // Set timestamp to a recent time by calling the real store value
    const history = collector.getHistory();
    history[0].timestamp = now - 1000; // 1 second ago
    memento.update('sidecar.metrics', history);

    const spend = collector.getSpendSince(now - 60_000); // last minute
    expect(spend).toBeCloseTo(1.0);
  });

  it('getSpendSince excludes entries outside the window', () => {
    const history = [
      {
        timestamp: 1000,
        costUsd: 5.0,
        toolCalls: [],
        errors: [],
        iterations: 0,
        totalTokensEstimate: 0,
        durationMs: 1,
      },
    ];
    memento.update('sidecar.metrics', history);

    const spend = collector.getSpendSince(Date.now() - 1000); // only last second
    expect(spend).toBe(0); // the old entry is excluded
  });

  it('getDailySpend and getWeeklySpend return 0 when no history', () => {
    expect(collector.getDailySpend()).toBe(0);
    expect(collector.getWeeklySpend()).toBe(0);
  });

  it('getSpendBreakdown returns daily and weekly totals', () => {
    collector.startRun();
    collector.recordCost(2.5);
    collector.endRun();

    const breakdown = collector.getSpendBreakdown();
    // The entry was just added so it counts in both daily and weekly
    expect(breakdown.daily).toBeCloseTo(2.5);
    expect(breakdown.weekly).toBeCloseTo(2.5);
  });

  it('getMetricsSince falls back to workspaceState when sidecarDir is absent', async () => {
    collector.startRun();
    collector.recordCost(0.1);
    collector.recordToolEnd('read_file', false);
    collector.endRun();

    const result = await collector.getMetricsSince(1);
    expect(result).not.toBeNull();
    expect(result!.runs).toBe(1);
    expect(result!.byTool['read_file']).toBeDefined();
  });

  it('getMetricsSince counts errors in tool calls', async () => {
    collector.startRun();
    collector.recordToolEnd('write_file', true); // error
    collector.endRun();

    const result = await collector.getMetricsSince(30);
    expect(result!.byTool['write_file'].errors).toBe(1);
  });

  it('getToolDuration returns elapsed time since recordToolStart', () => {
    collector.recordToolStart();
    const duration = collector.getToolDuration();
    expect(duration).toBeGreaterThanOrEqual(0);
  });

  it('F2 — computes schema-validity, repair, executable rates + CPS + failure buckets', async () => {
    // Run 1: 4 tool calls, 1 errors; 2 were malformed, 1 repaired; failed (timeout).
    collector.startRun();
    collector.recordToolEnd('a', false);
    collector.recordToolEnd('b', false);
    collector.recordToolEnd('c', true);
    collector.recordToolEnd('d', false);
    collector.recordMalformedToolCalls(2, 1);
    collector.recordCost(0.5);
    collector.recordOutcome('timeout');
    collector.endRun();

    // Run 2: clean success, priced.
    collector.startRun();
    collector.recordToolEnd('a', false);
    collector.recordCost(0.2);
    collector.recordOutcome(null);
    collector.endRun();

    const m = (await collector.getMetricsSince(30))!;
    expect(m.toolCallCount).toBe(5);
    // 2 of 5 first-attempts were malformed → 3/5 valid.
    expect(m.schemaValidityRate).toBeCloseTo(3 / 5);
    expect(m.repairRate).toBeCloseTo(1 / 2);
    // 1 of 5 calls errored → 4/5 executable.
    expect(m.executableCallRate).toBeCloseTo(4 / 5);
    // Only run 2 succeeded with a price → CPS = its cost.
    expect(m.costPerSuccessfulRun).toBeCloseTo(0.2);
    expect(m.failureBuckets).toEqual({ timeout: 1 });
    expect(m.latencyP95Ms).toBeGreaterThanOrEqual(0);
  });
});
