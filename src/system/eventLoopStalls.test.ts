import { describe, it, expect, vi } from 'vitest';
import { StallTracker, formatStallSummary, watchEventLoopStalls } from './eventLoopStalls.js';
import { logger } from './logger.js';

describe('StallTracker', () => {
  it('counts only lateness at or over the threshold', () => {
    const t = new StallTracker(1000);
    expect(t.observe(5)).toBe(false);
    expect(t.observe(999)).toBe(false);
    expect(t.observe(1000)).toBe(true);
    expect(t.observe(4800)).toBe(true);
    expect(t.get()).toEqual({ count: 2, longestMs: 4800, totalMs: 5800 });
  });
});

describe('formatStallSummary', () => {
  it('says so when there were none', () => {
    expect(formatStallSummary('activation', { count: 0, longestMs: 0, totalMs: 0 }, 1000)).toBe(
      '[SideCar] activation: no event-loop stalls over 1000 ms',
    );
  });

  it('gives the count, the longest and the total', () => {
    expect(formatStallSummary('activation', { count: 2, longestMs: 4800.4, totalMs: 5800.6 }, 1000)).toBe(
      '[SideCar] activation: 2 event-loop stall(s) over 1000 ms, longest 4800 ms, 5801 ms blocked in total',
    );
  });
});

describe('watchEventLoopStalls', () => {
  it('logs a real stall as it ends, and the summary once on stop', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      const watch = watchEventLoopStalls('test', { intervalMs: 20, thresholdMs: 300 });
      await new Promise((r) => setTimeout(r, 50));
      const until = Date.now() + 450;
      while (Date.now() < until) {
        // hold the thread
      }
      await new Promise((r) => setTimeout(r, 60));
      const s = watch.stop('done');
      expect(s.count).toBe(1);
      expect(s.longestMs).toBeGreaterThanOrEqual(300);
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/^\[SideCar\] test: event loop blocked \d+ ms$/));
      expect(info).toHaveBeenCalledTimes(1);
      expect(info.mock.calls[0][0]).toMatch(/test: 1 event-loop stall\(s\) over 300 ms.*\(done\)$/);
      watch.stop('again');
      expect(info).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
      info.mockRestore();
    }
  });
});
