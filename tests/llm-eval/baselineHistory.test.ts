import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendHistory,
  readHistory,
  timelineFor,
  deltaAgainstPrevious,
  HISTORY_FILE,
  type BaselineHistoryEntry,
} from './baselineHistory.js';
import type { BaselineProvenance } from './baselineProvenance.js';

// A baseline file is a snapshot each run overwrites, which answers "where is
// this model now" and nothing else. Whether a -2 is a regression or noise needs
// the runs before it, and those only existed in git and in copies taken by hand.
//
// Twice in one sweep a truncated run replaced a complete baseline — ministral's
// 61/70 became 50/53, llama3.2's 27/69 became 6/16. History would not have
// prevented either overwrite, but it makes both visible instead of silent.

const prov = (): BaselineProvenance => ({
  model: 'm',
  extensionVersion: '0.122.4',
  thinkingEnabled: true,
  maxIterations: 50,
  scaffold: { version: '4.0.0', features: { completionGate: true } },
});

const entry = (over: Partial<BaselineHistoryEntry> = {}): BaselineHistoryEntry => ({
  at: '2026-08-05T12:00:00.000Z',
  model: 'gemma4:e4b',
  version: '0.122.4',
  provenance: prov(),
  casesRun: 70,
  casesAvailable: 70,
  passed: 67,
  failed: 3,
  unavailable: 0,
  complete: true,
  filtered: false,
  failedCases: ['a', 'b', 'c'],
  durationSec: 3600,
  ...over,
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bh-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('appendHistory', () => {
  it('appends rather than replacing, so the timeline accumulates', () => {
    appendHistory(dir, entry({ at: '2026-08-02T00:00:00.000Z', passed: 66 }));
    appendHistory(dir, entry({ at: '2026-08-05T00:00:00.000Z', passed: 67 }));
    expect(readHistory(dir).map((e) => e.passed)).toEqual([66, 67]);
  });

  it('never throws when the log cannot be written', () => {
    // History is telemetry. Losing it must not fail a run that produced real
    // measurements — the opposite trade from the baseline file itself.
    const ro = mkdtempSync(join(tmpdir(), 'bh-ro-'));
    writeFileSync(join(ro, HISTORY_FILE), '');
    chmodSync(join(ro, HISTORY_FILE), 0o444);
    expect(() => appendHistory(ro, entry())).not.toThrow();
    rmSync(ro, { recursive: true, force: true });
  });
});

describe('readHistory', () => {
  it('returns empty when no log exists yet', () => {
    expect(readHistory(dir)).toEqual([]);
  });

  it('skips a corrupt line instead of losing the rest of the timeline', () => {
    appendHistory(dir, entry({ passed: 1 }));
    writeFileSync(join(dir, HISTORY_FILE), readFileSync(join(dir, HISTORY_FILE), 'utf-8') + '{not json\n');
    appendHistory(dir, entry({ passed: 2 }));
    expect(readHistory(dir).map((e) => e.passed)).toEqual([1, 2]);
  });
});

describe('timelineFor', () => {
  it('excludes incomplete runs from the trend', () => {
    // llama3.2's aborted 6/16 next to its 27/69 reads as a collapse and is
    // nothing of the sort. The entry stays in the file; it just is not a
    // datapoint.
    appendHistory(dir, entry({ model: 'llama3.2', at: '2026-08-02T00:00:00.000Z', passed: 27, casesRun: 69 }));
    appendHistory(
      dir,
      entry({ model: 'llama3.2', at: '2026-08-05T00:00:00.000Z', passed: 6, casesRun: 16, complete: false }),
    );
    expect(timelineFor(dir, 'llama3.2').map((e) => e.passed)).toEqual([27]);
    expect(readHistory(dir)).toHaveLength(2); // still recorded
  });

  it('separates models', () => {
    appendHistory(dir, entry({ model: 'a', passed: 1 }));
    appendHistory(dir, entry({ model: 'b', passed: 2 }));
    expect(timelineFor(dir, 'a').map((e) => e.passed)).toEqual([1]);
  });

  it('orders oldest first regardless of append order', () => {
    appendHistory(dir, entry({ at: '2026-08-05T00:00:00.000Z', passed: 67 }));
    appendHistory(dir, entry({ at: '2026-08-02T00:00:00.000Z', passed: 66 }));
    expect(timelineFor(dir, 'gemma4:e4b').map((e) => e.passed)).toEqual([66, 67]);
  });
});

describe('deltaAgainstPrevious', () => {
  it('is null with only one run — nothing to compare against', () => {
    appendHistory(dir, entry());
    expect(deltaAgainstPrevious(dir, 'gemma4:e4b')).toBeNull();
  });

  it('reports the change against the previous complete run', () => {
    appendHistory(dir, entry({ at: '2026-08-02T00:00:00.000Z', passed: 53 }));
    appendHistory(dir, entry({ at: '2026-08-05T00:00:00.000Z', passed: 51 }));
    expect(deltaAgainstPrevious(dir, 'gemma4:e4b')?.delta).toBe(-2);
  });

  it('skips over an aborted run to compare the last two real ones', () => {
    // An abort between two good runs must not become the thing a regression is
    // measured against — that would report -45 and then +45.
    appendHistory(dir, entry({ at: '2026-08-01T00:00:00.000Z', passed: 66 }));
    appendHistory(dir, entry({ at: '2026-08-03T00:00:00.000Z', passed: 6, complete: false }));
    appendHistory(dir, entry({ at: '2026-08-05T00:00:00.000Z', passed: 67 }));
    const d = deltaAgainstPrevious(dir, 'gemma4:e4b');
    expect(d?.delta).toBe(1);
    expect(d?.previous.passed).toBe(66);
  });
});

describe('filtered runs', () => {
  it('are kept in the file but excluded from the trend', () => {
    // The flaw this flag exists for, found in real data. The llama3.2 window
    // redo recorded `1/4, complete: true` — it ran everything it was asked to
    // and finished, so `complete` does not catch it. A naive trend would read
    // 27/69 -> 26/70 -> 1/4 and call it a collapse.
    appendHistory(dir, entry({ model: 'llama3.2', at: '2026-08-05T00:00:00.000Z', passed: 26, casesRun: 70 }));
    appendHistory(
      dir,
      entry({
        model: 'llama3.2',
        at: '2026-08-05T01:00:00.000Z',
        passed: 1,
        casesRun: 4,
        casesAvailable: 4,
        filtered: true,
      }),
    );
    expect(timelineFor(dir, 'llama3.2').map((e) => e.passed)).toEqual([26]);
    expect(readHistory(dir)).toHaveLength(2);
  });

  it('does not let a filtered run become the thing a delta measures against', () => {
    appendHistory(dir, entry({ at: '2026-08-01T00:00:00.000Z', passed: 66 }));
    appendHistory(dir, entry({ at: '2026-08-03T00:00:00.000Z', passed: 1, casesRun: 4, filtered: true }));
    appendHistory(dir, entry({ at: '2026-08-05T00:00:00.000Z', passed: 67 }));
    const d = deltaAgainstPrevious(dir, 'gemma4:e4b');
    expect(d?.delta).toBe(1);
    expect(d?.previous.passed).toBe(66);
  });
});
