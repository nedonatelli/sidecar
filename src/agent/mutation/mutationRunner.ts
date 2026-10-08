import { generateMutants, type GenerateOptions } from './mutationOperators.js';
import { scoreMutants, type MutantResult, type MutationScore } from './mutationScore.js';

// ---------------------------------------------------------------------------
// Mutation runner — drive one file's mutants through a test command.
//
// The loop: confirm the baseline is green → for each mutant, write it, run the
// test, classify killed (test failed) vs survived (test passed) → always
// restore the original. IO is injected (read / write / runTest) so this is
// unit-testable with a fake test process and wires to the real fs + shell at
// the call site (an agent tool or a gate). The runner never touches the
// filesystem or a shell itself.
//
// Ordering matters for safety: the ORIGINAL is restored in a finally, so a
// throw mid-run never leaves a mutant on disk -- but only over the runner's own
// mutant: a file someone else has written since keeps their content.
//
// Stop is checked before every test run. The executors ignore a signal that
// was already aborted when they start, so without the check every remaining
// mutant was still written and tested after Stop, and the late restore then
// wrote the original over edits the next run had made meanwhile.
// ---------------------------------------------------------------------------

export interface MutationIo {
  /** Read the file under mutation. */
  read(path: string): Promise<string>;
  /** Overwrite the file (with a mutant, or the original on restore). */
  write(path: string, content: string): Promise<void>;
  /** Run the test command for this file. `passed` = the suite went green. */
  runTest(): Promise<{ passed: boolean; output: string }>;
}

export interface MutationRunResult {
  /** False when the baseline test didn't pass on the original — the whole run
   *  is void (you can't measure kill rate without a green start). */
  baselinePassed: boolean;
  /** True when Stop ended the run early; `results` covers the mutants run so far. */
  stopped: boolean;
  results: MutantResult[];
  score: MutationScore;
}

const firstLine = (s: string): string => (s.split('\n').find((l) => l.trim()) ?? '').slice(0, 200);

const EMPTY_SCORE: MutationScore = {
  total: 0,
  killed: 0,
  survived: 0,
  noCoverage: 0,
  errored: 0,
  viable: 0,
  score: 0,
  survivors: [],
};

/**
 * Run mutation testing on `filePath`. Requires a green baseline; generates
 * single-point mutants; classifies each; restores the original no matter what.
 */
export async function runMutationTest(
  filePath: string,
  io: MutationIo,
  options: GenerateOptions & { signal?: AbortSignal } = {},
): Promise<MutationRunResult> {
  const { signal } = options;
  const original = await io.read(filePath);

  if (signal?.aborted) return { baselinePassed: false, stopped: true, results: [], score: EMPTY_SCORE };
  const baseline = await io.runTest();
  if (!baseline.passed) {
    return { baselinePassed: false, stopped: false, results: [], score: EMPTY_SCORE };
  }

  const mutants = generateMutants(original, options);
  const results: MutantResult[] = [];
  let lastWritten: string | undefined;
  try {
    for (const m of mutants) {
      if (signal?.aborted) break;
      lastWritten = m.mutatedSource;
      await io.write(filePath, m.mutatedSource);
      try {
        const r = await io.runTest();
        results.push({
          mutant: m,
          outcome: r.passed ? 'survived' : 'killed',
          detail: r.passed ? undefined : firstLine(r.output),
        });
      } catch (err) {
        results.push({
          mutant: m,
          outcome: 'error',
          detail: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } finally {
    if (lastWritten !== undefined) {
      const current = await io.read(filePath).catch(() => undefined);
      if (current === undefined || current === lastWritten) await io.write(filePath, original);
    }
  }

  return { baselinePassed: true, stopped: signal?.aborted === true, results, score: scoreMutants(results) };
}
