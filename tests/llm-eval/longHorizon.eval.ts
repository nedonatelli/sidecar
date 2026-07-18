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

// SIDECAR_EVAL_CASE=id1,id2 narrows the run — useful for focusing reps on the
// cases that actually flip between arms (memory-recall, plan-survives) instead of
// re-running the saturated ones.
const CASE_FILTER = process.env.SIDECAR_EVAL_CASE?.split(',').map((s) => s.trim());
const SELECTED = CASE_FILTER ? LONG_HORIZON_CASES.filter((c) => CASE_FILTER.includes(c.id)) : LONG_HORIZON_CASES;

describe.skipIf(!backend)('llm-eval :: long-horizon', () => {
  for (const lhCase of SELECTED) {
    // A multi-turn conversation needs a bigger budget than a single case.
    it(
      `${lhCase.id} — ${lhCase.description}`,
      async () => {
        // The internal abort budget must scale with turn count — it covers the
        // WHOLE conversation. A flat single-case budget starved multi-turn cases
        // (compaction-survival's heavy bulk-text turns timed out). Give it the same
        // turns-scaled budget as the vitest `it` below, minus the 60s slack, so the
        // case aborts itself cleanly before vitest kills it.
        const caseBudget = DEFAULT_CASE_TIMEOUT_MS * lhCase.turns.length;
        const r = await runLongHorizonCase(lhCase, backend!, caseBudget);
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
          let detail = firstFail
            ? `first failing turn "${firstFail.label}":\n  - ${firstFail.failures.join('\n  - ')}`
            : 'no turn detail';
          // Dump WHAT THE MODEL DID on the failing turn — the whole point of a
          // diagnosis is to tell a SideCar edit-path failure (bad tool call,
          // rejected edit) from a model failure (never acted, wrong content).
          if (firstFail?.trajectory?.length) {
            const traj = firstFail.trajectory
              .map((e) => {
                if (e.type === 'tool_call') return `    → ${e.name}(${JSON.stringify(e.input).slice(0, 700)})`;
                if (e.type === 'tool_result')
                  return `    ← ${e.name}${e.isError ? ' [ERROR]' : ''}: ${e.result.replace(/\s+/g, ' ').slice(0, 300)}`;
                if (e.type === 'text') return `    · text: ${e.text.replace(/\s+/g, ' ').slice(0, 160)}`;
                return null;
              })
              .filter(Boolean)
              .join('\n');
            detail += `\n  trajectory of the failing turn:\n${traj}`;
          }
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
          `compaction=${r.compressionCount}  history=${r.finalHistoryLength}  editDiffShown=${r.editDiffShownCount}  ` +
          `steer=${r.steerFiredCount}  reprompt=${r.actionRepromptFiredCount}`,
      );
    }
    // eslint-disable-next-line no-console -- intentional report output
    console.log(lines.join('\n') + '\n');
  });
});
