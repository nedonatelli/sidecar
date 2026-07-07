import type { Mutant } from './mutationOperators.js';

// ---------------------------------------------------------------------------
// Mutation scoring — aggregate per-mutant outcomes into the credibility number.
//
//   killed      — the test FAILED on the mutant. Good: the suite caught the
//                 seeded fault.
//   survived    — the test PASSED on the mutant. Bad: a real bug the suite would
//                 miss. These are the credibility gaps worth surfacing.
//   no-coverage — the mutant couldn't be evaluated because the baseline test
//                 didn't pass on the ORIGINAL (mutation testing is meaningless
//                 without a green baseline). Excluded from the score.
//   error       — the test run errored/timed out on the mutant. Excluded.
//
// Mutation score = killed / (killed + survived). Errors and no-coverage don't
// count for or against — they're measurement gaps, reported separately.
// ---------------------------------------------------------------------------

export type MutantOutcome = 'killed' | 'survived' | 'no-coverage' | 'error';

export interface MutantResult {
  mutant: Mutant;
  outcome: MutantOutcome;
  /** First line of the failing test output (for killed) or the error message. */
  detail?: string;
}

export interface MutationScore {
  total: number;
  killed: number;
  survived: number;
  noCoverage: number;
  errored: number;
  /** killed + survived — the mutants that actually tested the suite. */
  viable: number;
  /** killed / viable, in [0,1]. 0 when nothing was viable. */
  score: number;
  /** The surviving mutants — bugs the suite would miss. The actionable output. */
  survivors: MutantResult[];
}

export function scoreMutants(results: MutantResult[]): MutationScore {
  let killed = 0;
  let survived = 0;
  let noCoverage = 0;
  let errored = 0;
  const survivors: MutantResult[] = [];
  for (const r of results) {
    switch (r.outcome) {
      case 'killed':
        killed++;
        break;
      case 'survived':
        survived++;
        survivors.push(r);
        break;
      case 'no-coverage':
        noCoverage++;
        break;
      case 'error':
        errored++;
        break;
    }
  }
  const viable = killed + survived;
  return {
    total: results.length,
    killed,
    survived,
    noCoverage,
    errored,
    viable,
    score: viable > 0 ? killed / viable : 0,
    survivors,
  };
}

/** One-line human summary of a mutation score. */
export function formatMutationScore(s: MutationScore): string {
  const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
  const extras: string[] = [];
  if (s.noCoverage) extras.push(`${s.noCoverage} no-coverage`);
  if (s.errored) extras.push(`${s.errored} errored`);
  const tail = extras.length ? ` (${extras.join(', ')})` : '';
  return `mutation score ${pct(s.score)} — ${s.killed}/${s.viable} mutants killed, ${s.survived} survived${tail}`;
}
