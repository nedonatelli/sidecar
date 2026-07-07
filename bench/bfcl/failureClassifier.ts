// ---------------------------------------------------------------------------
// BFCL failure classification — instrument the failure taxonomy where there's
// GROUND TRUTH (scaffolding roadmap Phase 0 / §2.1).
//
// Aggregate pass/fail hides WHICH failure mode dominates, and the two dominant
// modes have OPPOSITE fixes:
//   - SELECTION errors (wrong/hallucinated/missing function, over/under-eager
//     calling) → fixed by per-turn tool SUBSETTING (fewer, more-relevant tools
//     in context → better selection, less lost-in-the-middle).
//   - ARGUMENT errors (wrong value, missing/extra param) → fixed by constrained
//     DECODING (grammar the arguments to the tool's schema).
//
// BFCL is where this is measurable without guessing: the AST checker knows the
// correct function + args, so its failure `reason` string already encodes the
// mode. This maps that reason to a type + axis so a run can report the
// distribution — the number that decides subsetting-vs-constraining ROI, per the
// strategy's "syntactic-vs-semantic split decides 1-vs-4".
//
// Pure: a total function of the reason string.
// ---------------------------------------------------------------------------

export type BfclFailureType =
  | 'wrong-function' //          called the wrong function name
  | 'hallucinated-function' //   called a function absent from the schema
  | 'spurious-call' //           called a function when none applied (irrelevance)
  | 'missing-call' //            emitted no call when one was required (relevance)
  | 'wrong-call-count' //        wrong NUMBER of calls (parallel/multiple)
  | 'wrong-argument-value' //    right function, an argument value is off
  | 'missing-argument' //        a required/expected argument is absent
  | 'extra-argument' //          a hallucinated argument (not in schema)
  | 'no-parallel-match' //       a parallel ground-truth entry went unsatisfied
  | 'other'; //                  harness/data issue (no ground truth, etc.)

/** The lever axis a failure type points to. `selection` → tool subsetting;
 *  `argument` → constrained decoding; `structure` → prompt/format shaping. */
export type FailureAxis = 'selection' | 'argument' | 'structure';

const RULES: ReadonlyArray<{ re: RegExp; type: BfclFailureType }> = [
  { re: /is not in the provided schema/i, type: 'hallucinated-function' },
  { re: /expected function ".*?", got/i, type: 'wrong-function' },
  { re: /expected no function call, got/i, type: 'spurious-call' },
  { re: /expected at least one function call, got none/i, type: 'missing-call' },
  { re: /expected (?:exactly \d+ call|\d+ calls), got/i, type: 'wrong-call-count' },
  { re: /hallucinated parameter/i, type: 'extra-argument' },
  { re: /missing (?:required )?parameter/i, type: 'missing-argument' },
  { re: /not in acceptable set/i, type: 'wrong-argument-value' },
  { re: /no call satisfied expected/i, type: 'no-parallel-match' },
];

/** Classify an AST-checker failure `reason` into a failure type. A passing
 *  result (empty reason) is not a failure — callers should not pass it. */
export function classifyBfclFailure(reason: string): BfclFailureType {
  for (const { re, type } of RULES) {
    if (re.test(reason)) return type;
  }
  return 'other';
}

const AXIS: Record<BfclFailureType, FailureAxis> = {
  'wrong-function': 'selection',
  'hallucinated-function': 'selection',
  'spurious-call': 'selection',
  'missing-call': 'selection',
  'wrong-call-count': 'structure',
  'wrong-argument-value': 'argument',
  'missing-argument': 'argument',
  'extra-argument': 'argument',
  'no-parallel-match': 'structure',
  other: 'structure',
};

export function failureAxis(type: BfclFailureType): FailureAxis {
  return AXIS[type];
}

export interface FailureDistribution {
  total: number;
  byType: Record<string, number>;
  byAxis: Record<FailureAxis, number>;
}

/** Aggregate a set of failure reasons into type + axis distributions. */
export function summarizeFailures(reasons: readonly string[]): FailureDistribution {
  const byType: Record<string, number> = {};
  const byAxis: Record<FailureAxis, number> = { selection: 0, argument: 0, structure: 0 };
  for (const reason of reasons) {
    const type = classifyBfclFailure(reason);
    byType[type] = (byType[type] ?? 0) + 1;
    byAxis[failureAxis(type)] += 1;
  }
  return { total: reasons.length, byType, byAxis };
}

/** One-line readable summary: the selection-vs-argument split that decides ROI. */
export function formatFailureAxes(d: FailureDistribution): string {
  if (d.total === 0) return 'no failures to classify';
  const pct = (n: number): string => `${((n / d.total) * 100).toFixed(0)}%`;
  return (
    `${d.total} failures — selection ${d.byAxis.selection} (${pct(d.byAxis.selection)}), ` +
    `argument ${d.byAxis.argument} (${pct(d.byAxis.argument)}), ` +
    `structure ${d.byAxis.structure} (${pct(d.byAxis.structure)})`
  );
}
