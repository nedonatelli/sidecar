// ---------------------------------------------------------------------------
// BFCL runner — pure orchestration.
//
// Given a list of cases and a `CallModel` function (which turns a prompt + tool
// schemas into the model's emitted calls), run every case, score each with the
// AST checker, and aggregate per category. `CallModel` is injected so the
// runner is testable without a network round-trip: tests pass a canned/replay
// implementation; the live driver passes a real backend (see backend.ts).
// ---------------------------------------------------------------------------

import { checkCase, AST_CATEGORIES } from './astChecker.js';
import type { BfclCase, BfclReport, CaseOutcome, CategoryReport, ParsedCall } from './types.js';

/**
 * Ask the model to respond to `question` with the given function schemas
 * available, and return the function call(s) it emitted (empty array = the
 * model chose to answer in prose / declined to call). Implemented per-backend.
 */
export type CallModel = (question: string, functions: BfclCase['functions']) => Promise<ParsedCall[]>;

export interface RunOptions {
  /** Bound concurrent model calls. Default 1 (local models serialize anyway). */
  concurrency?: number;
  /** Called after each case completes — for progress logging. */
  onCase?: (outcome: CaseOutcome) => void;
}

export async function runBfcl(cases: BfclCase[], callModel: CallModel, opts: RunOptions = {}): Promise<BfclReport> {
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const outcomes = new Array<CaseOutcome>(cases.length);

  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= cases.length) return;
      const c = cases[i];
      let calls: ParsedCall[] = [];
      let error = '';
      const startedAt = Date.now();
      try {
        calls = await callModel(c.question, c.functions);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
      }
      const durationMs = Date.now() - startedAt;
      const scored = error ? { pass: false, reason: `model call failed: ${error}` } : checkCase(c, calls);
      const outcome: CaseOutcome = { id: c.id, category: c.category, durationMs, ...scored };
      outcomes[i] = outcome;
      opts.onCase?.(outcome);
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, cases.length) }, () => worker()));
  return aggregate(outcomes);
}

export function aggregate(outcomes: CaseOutcome[]): BfclReport {
  const categories: CategoryReport[] = [];
  for (const category of AST_CATEGORIES) {
    const inCat = outcomes.filter((o) => o.category === category);
    if (inCat.length === 0) continue;
    const passed = inCat.filter((o) => o.pass).length;
    categories.push({ category, passed, total: inCat.length, accuracy: passed / inCat.length });
  }

  const passed = outcomes.filter((o) => o.pass).length;
  const total = outcomes.length;
  const macroAccuracy =
    categories.length === 0 ? 1 : categories.reduce((s, c) => s + c.accuracy, 0) / categories.length;

  const durations = outcomes.map((o) => o.durationMs).filter((d): d is number => typeof d === 'number');
  const meanDurationMs = durations.length === 0 ? undefined : durations.reduce((s, d) => s + d, 0) / durations.length;

  return {
    categories,
    macroAccuracy,
    microAccuracy: total === 0 ? 1 : passed / total,
    passed,
    total,
    failures: outcomes.filter((o) => !o.pass),
    meanDurationMs,
  };
}
