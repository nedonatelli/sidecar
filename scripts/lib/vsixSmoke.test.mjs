import { describe, it, expect } from 'vitest';
import { parseSidecarLog, checkRun, topSelfTime, shortUrl, DEFAULT_BUDGETS } from './vsixSmoke.mjs';

// Shaped like the 2026-11-02 report: an 8-minute gap before the symbol graph.
const SLOW = `2026-11-02 10:27:58.000 [info] SideCar extension activating...
2026-11-02 10:28:02.000 [info] [SideCar] Workspace indexed: 1463 files
2026-11-02 10:28:06.620 [info] [SideCar] Tree-sitter loaded with 17 languages: javascript
2026-11-02 10:30:00.000 [warning] [SideCar] activation: event loop blocked 6200 ms
2026-11-02 10:36:19.705 [info] [SideCar] Symbol graph built: 7780 symbols
2026-11-02 10:36:20.258 [info] [PKI] replay complete queued=7780 filesRead=1244 filesSkipped=0 graphSymbols=7780
2026-11-02 10:36:33.424 [info] [SideCar] Documentation index built: 8124 entries in 513731ms
2026-11-02 10:36:40.000 [info] [SideCar] Indexing status: ready
2026-11-02 10:36:40.001 [info] [SideCar] activation: 3 event-loop stall(s) over 1000 ms, longest 6200 ms, 9100 ms blocked in total (indexing ready)
2026-11-02 10:36:41.000 [warning] [SideCar] Failed to load tree-sitter grammar 'dart': Incompatible language version`;

const FAST = `2026-10-29 14:36:19.000 [info] SideCar extension activating...
2026-10-29 14:36:20.912 [info] [SideCar] Workspace indexed: 1554 files
2026-10-29 14:36:22.376 [info] [SideCar] Tree-sitter loaded with 17 languages
2026-10-29 14:36:22.576 [info] [SideCar] Symbol graph built: 7416 symbols
2026-10-29 14:36:24.474 [info] [PKI] replay complete queued=7416
2026-10-29 14:36:30.000 [info] [SideCar] Documentation index built: 7419 entries in 8025ms
2026-10-29 14:36:30.100 [info] [SideCar] Indexing status: indexing (Indexing 7416 changed symbols…)
2026-10-29 14:36:31.000 [info] [SideCar] Models listed: 12 in 900ms
2026-10-29 14:36:50.000 [info] [SideCar] Indexing status: ready
2026-10-29 14:36:50.001 [info] [SideCar] activation: no event-loop stalls over 1000 ms (indexing ready)`;

describe('parseSidecarLog + checkRun', () => {
  it('reads the slow start and fails it on every budget it broke', () => {
    const r = checkRun(parseSidecarLog(SLOW));
    expect(r.facts).toMatchObject({ files: 1463, symbols: 7780, docEntries: 8124, docIndexMs: 513731 });
    expect(r.timings).toMatchObject({ symbolGraphMs: 493085, docIndexMs: 513731, longestStallMs: 6200, stallCount: 3 });
    expect(r.failures).toEqual([
      'readyMs: 522000 ms > budget 120000 ms',
      'symbolGraphMs: 493085 ms > budget 60000 ms',
      'docIndexMs: 513731 ms > budget 60000 ms',
      'longestStallMs: 6200 ms > budget 5000 ms',
      "load failure: [SideCar] Failed to load tree-sitter grammar 'dart': Incompatible language version",
    ]);
  });

  it('passes a normal start, and takes the first ready', () => {
    const r = checkRun(parseSidecarLog(FAST));
    expect(r.failures).toEqual([]);
    expect(r.timings).toMatchObject({ readyMs: 31000, symbolGraphMs: 200, modelsMs: 900, longestStallMs: 0 });
  });

  it('fails a run that never reports ready instead of passing it quietly', () => {
    const cut = FAST.split('\n').slice(0, 4).join('\n');
    expect(checkRun(parseSidecarLog(cut)).failures).toEqual(['readyMs: not reached', 'docIndexMs: not reached']);
  });

  it('counts a stall logged after the last summary', () => {
    const r = checkRun(
      parseSidecarLog(`${FAST}\n2026-10-29 14:37:00.000 [warning] [SideCar] activation: event loop blocked 7000 ms`),
      DEFAULT_BUDGETS,
    );
    expect(r.timings.longestStallMs).toBe(7000);
  });
});

describe('topSelfTime', () => {
  it('ranks functions by the time the thread spent in them', () => {
    const frame = (functionName, url, lineNumber) => ({ functionName, url, lineNumber, columnNumber: 0 });
    const profile = {
      nodes: [
        { id: 1, callFrame: frame('(root)', '', -1) },
        { id: 2, callFrame: frame('parse', 'file:///c:/u/.vscode/extensions/sidecar-0.135.0/dist/extension.js', 9) },
        { id: 3, callFrame: frame('readFile', 'node:fs', 0) },
      ],
      samples: [2, 2, 3, 2],
      timeDeltas: [0, 1000, 1000, 1000],
    };
    expect(topSelfTime(profile)).toEqual([
      { fn: 'parse dist/extension.js:10', ms: 2, share: 2 / 3 },
      { fn: 'readFile node:fs:1', ms: 1, share: 1 / 3 },
    ]);
  });

  it('names the file, not where it was installed', () => {
    expect(shortUrl('file:///c:/Users/x/.vscode/extensions/nedonatelli.sidecar-ai-0.134.0/dist/extension.js')).toBe(
      'dist/extension.js',
    );
    expect(shortUrl('')).toBe('(native)');
  });
});
