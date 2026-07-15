import { describe, it } from 'vitest';
import { runLongHorizonCase } from './longHorizonHarness.js';
import { LONG_HORIZON_CASES } from './longHorizonCases.js';
import { pickAgentBackend, DEFAULT_CASE_TIMEOUT_MS } from './agentHarness.js';

// ---------------------------------------------------------------------------
// Long-horizon eval runner — the coverage the `long-horizon-state` branch is
// named after and has never had.
//
//   SIDECAR_EVAL_MODEL=qwen2.5-coder:7b \
//     npx vitest run --config vitest.eval.config.ts tests/llm-eval/longHorizon.eval.ts
//
// Each case is a real conversation; every turn must pass in order (a failed turn
// stops the case, because the conversation diverges and later turns would score
// noise). Cases tagged requiresCompression are VACUOUS unless compaction actually
// fired — reported, never a silent pass.
// ---------------------------------------------------------------------------

const backend = pickAgentBackend();
const results: Awaited<ReturnType<typeof runLongHorizonCase>>[] = [];

describe.skipIf(!backend)('llm-eval :: long-horizon', () => {
  for (const lhCase of LONG_HORIZON_CASES) {
    // A multi-turn conversation needs a bigger budget than a single case.
    it(
      `${lhCase.id} — ${lhCase.description}`,
      async () => {
        const r = await runLongHorizonCase(lhCase, backend!);
        results.push(r);

        if (r.apiUnavailable) return; // infra, not a behavioral verdict

        const { expect } = await import('vitest');
        if (r.vacuous) {
          throw new Error(
            `Long-horizon case "${r.caseId}" is VACUOUS: it requires compression but compaction never fired ` +
              `(final history ${r.finalHistoryLength} turns). It proved nothing — raise the turn volume or ` +
              `lower agentMaxTokens further.`,
          );
        }
        if (!r.passed) {
          const firstFail = r.turns.find((t) => !t.passed);
          const detail = firstFail
            ? `first failing turn "${firstFail.label}":\n  - ${firstFail.failures.join('\n  - ')}`
            : 'no turn detail';
          throw new Error(
            `Long-horizon case "${r.caseId}" failed after ${r.turns.length}/${lhCase.turns.length} turns ` +
              `(compaction fired ${r.compressionCount}x). ${detail}`,
          );
        }
        expect(r.passed).toBe(true);
      },
      DEFAULT_CASE_TIMEOUT_MS * lhCase.turns.length + 60_000,
    );
  }

  it('summary', () => {
    if (results.length === 0) return;
    const lines = ['\nLong-horizon results:', ''];
    for (const r of results) {
      const status = r.apiUnavailable ? 'API-UNAVAIL' : r.vacuous ? 'VACUOUS' : r.passed ? 'PASS' : 'FAIL';
      const passedTurns = r.turns.filter((t) => t.passed).length;
      lines.push(
        `  ${status.padEnd(11)} ${r.caseId.padEnd(26)} ${passedTurns}/${r.turns.length} turns  ` +
          `compaction=${r.compressionCount}  history=${r.finalHistoryLength}`,
      );
    }
    // eslint-disable-next-line no-console -- intentional report output
    console.log(lines.join('\n') + '\n');
  });
});
