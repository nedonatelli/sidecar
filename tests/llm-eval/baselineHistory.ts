import * as fs from 'fs';
import * as path from 'path';
import type { BaselineProvenance } from './baselineProvenance.js';

/**
 * Append-only record of every baseline run, so improvement and regression are
 * visible over time rather than only in the latest snapshot.
 *
 * A baseline file is a single snapshot that each run overwrites. That answers
 * "where is this model now" and nothing else — "did this change help", "when did
 * this case start failing", "is -2 a regression or noise" all require the runs
 * before it, and those only existed in git and in backups taken by hand.
 *
 * Twice in one sweep a truncated run replaced a complete baseline: ministral's
 * 61/70 became 50/53 when the backend wedged, and llama3.2's 27/69 became 6/16
 * when an aborted case threw. Both were recoverable only because copies had been
 * made manually. History would not have prevented either overwrite, but it would
 * have made both obvious immediately and left the earlier numbers intact.
 *
 * One JSON line per run. Append-only and never rewritten, so a run that dies
 * mid-way still leaves its entry — `complete` says whether it finished, which is
 * the field that stops a 16-case run being read as a collapse.
 */

export interface BaselineHistoryEntry {
  /** ISO timestamp the run finished (or gave up). */
  at: string;
  model: string;
  /** Extension version the run was measured under. */
  version: string;
  provenance: BaselineProvenance;
  /** Cases that produced a result. NOT the size of the case suite. */
  casesRun: number;
  /** Size of the selection this run drew from — the FILTERED size when a case
   *  or tag filter was set, which is why `filtered` exists alongside it. */
  casesAvailable: number;
  /** True when SIDECAR_EVAL_CASE / SIDECAR_EVAL_TAGS narrowed the run.
   *
   *  A filtered run is a legitimate 4-of-4 and a nonsense datapoint: the
   *  llama3.2 window redo recorded `1/4, complete` next to its `26/70`, which
   *  reads as the model collapsing to 25%. Completeness alone cannot express
   *  that — the run DID finish everything it was asked to do. */
  filtered: boolean;
  passed: number;
  failed: number;
  /** Cases skipped because the backend returned nothing. */
  unavailable: number;
  /** False when the run aborted — a circuit breaker, a throw, a timeout. */
  complete: boolean;
  /** Why it stopped early, when it did. */
  abortReason?: string;
  /** Failing case ids, so a regression can be diffed without the baseline file. */
  failedCases: string[];
  /** Wall clock, seconds. */
  durationSec: number;
}

export const HISTORY_FILE = 'history.jsonl';

/**
 * Append one run to the history log.
 *
 * Never throws: history is telemetry, and losing it must not fail a run that
 * produced real measurements. A write failure is reported and swallowed — the
 * opposite trade from the baseline file itself.
 */
export function appendHistory(dir: string, entry: BaselineHistoryEntry): void {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, HISTORY_FILE), JSON.stringify(entry) + '\n', 'utf-8');
  } catch (err) {
    console.warn(`[baseline] could not append run history: ${(err as Error).message}`);
  }
}

/** Read the log back, newest last. Returns [] when it does not exist yet. */
export function readHistory(dir: string): BaselineHistoryEntry[] {
  const file = path.join(dir, HISTORY_FILE);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as BaselineHistoryEntry];
      } catch {
        // A corrupt line must not hide the rest of the timeline.
        return [];
      }
    });
}

/**
 * The timeline for one model, oldest first: full runs that finished.
 *
 * Two exclusions, for different reasons.
 *
 * INCOMPLETE runs compare a fragment against a whole — llama3.2's aborted 6/16
 * next to its 27/69 reads as a collapse and is nothing of the sort.
 *
 * FILTERED runs are worse, because they look fine. The window redo recorded
 * `1/4, complete: true`; it ran everything it was asked to and finished, so
 * completeness does not catch it, and a naive trend would show llama3.2 going
 * 27/69 -> 26/70 -> 1/4. Targeted re-runs are common here, so this is not an
 * edge case.
 *
 * Both stay in the file — the record of what happened matters — but neither is
 * a point on a trend.
 */
export function timelineFor(dir: string, model: string): BaselineHistoryEntry[] {
  return readHistory(dir)
    .filter((e) => e.model === model && e.complete && !e.filtered)
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Change against the previous complete run, or null when there is no prior. */
export function deltaAgainstPrevious(
  dir: string,
  model: string,
): { previous: BaselineHistoryEntry; latest: BaselineHistoryEntry; delta: number } | null {
  const runs = timelineFor(dir, model);
  if (runs.length < 2) return null;
  const [previous, latest] = [runs[runs.length - 2], runs[runs.length - 1]];
  return { previous, latest, delta: latest.passed - previous.passed };
}
