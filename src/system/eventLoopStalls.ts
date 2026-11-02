// ---------------------------------------------------------------------------
// Event-loop stalls during activation (#396).
//
// Everything SideCar does at startup shares the extension host's one thread:
// indexing, the chat view's messages, the model list. When synchronous work
// holds that thread, the rest waits silently. A user saw "Indexing
// workspace…" and a "Loading…" model picker for 8 minutes, and the log showed
// only a gap: the documentation index, a ~100-file read loop, reported 513 s.
// This samples the loop and says so in the log, so a blocked start explains
// itself, and the installed-VSIX smoke test can assert on it.
// ---------------------------------------------------------------------------

import { logger } from './logger.js';

export interface StallSummary {
  /** Stalls at or over the threshold. */
  count: number;
  longestMs: number;
  /** Time lost to those stalls, in total. */
  totalMs: number;
}

/** Accumulates timer lateness; a pure counter, so it is testable without a clock. */
export class StallTracker {
  private summary: StallSummary = { count: 0, longestMs: 0, totalMs: 0 };

  constructor(readonly thresholdMs: number) {}

  /** Record one sample's lateness; true when it counts as a stall. */
  observe(lateMs: number): boolean {
    if (lateMs < this.thresholdMs) return false;
    this.summary.count++;
    this.summary.totalMs += lateMs;
    this.summary.longestMs = Math.max(this.summary.longestMs, lateMs);
    return true;
  }

  get(): StallSummary {
    return { ...this.summary };
  }
}

export function formatStallSummary(label: string, s: StallSummary, thresholdMs: number): string {
  if (s.count === 0) return `[SideCar] ${label}: no event-loop stalls over ${thresholdMs} ms`;
  return (
    `[SideCar] ${label}: ${s.count} event-loop stall(s) over ${thresholdMs} ms, ` +
    `longest ${Math.round(s.longestMs)} ms, ${Math.round(s.totalMs)} ms blocked in total`
  );
}

export interface StallWatch {
  /** Stop sampling and log the summary (once; later calls do nothing). */
  stop(reason: string): StallSummary;
}

/**
 * Sample the event loop every `intervalMs`; log each stall of `thresholdMs` or
 * more as it ends, and a summary on `stop` or after `maxMs`.
 */
export function watchEventLoopStalls(
  label: string,
  { intervalMs = 100, thresholdMs = 1_000, maxMs = 15 * 60_000 } = {},
): StallWatch {
  const tracker = new StallTracker(thresholdMs);
  const started = Date.now();
  let last = started;
  let stopped = false;

  const timer = setInterval(() => {
    const now = Date.now();
    const late = now - last - intervalMs;
    last = now;
    if (tracker.observe(late)) {
      logger.warn(`[SideCar] ${label}: event loop blocked ${Math.round(late)} ms`);
    }
    if (now - started >= maxMs) watch.stop(`${Math.round(maxMs / 60_000)} min elapsed`);
  }, intervalMs);
  timer.unref?.();

  const watch: StallWatch = {
    stop(reason) {
      const s = tracker.get();
      if (stopped) return s;
      stopped = true;
      clearInterval(timer);
      logger.info(`${formatStallSummary(label, s, thresholdMs)} (${reason})`);
      return s;
    },
  };
  return watch;
}
