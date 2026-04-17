/**
 * LLM-judged retrieval quality eval (v0.62 e.3). Runs the shipped
 * retrieval pipeline (symbol embedding + graph walk) against the
 * golden-case fixture from the main suite, then asks a real model
 * to rate each result's relevance + whether the top-K answers the
 * query. Output metrics:
 *
 *   - Mean LLM-judged precision (fraction of hits the judge flagged
 *     as RELEVANT / BORDERLINE / IRRELEVANT, averaged across cases)
 *   - Mean answer-relevancy (fraction of queries the judge flagged
 *     as ANSWERED, PARTIAL, or MISSED)
 *
 * Skips cleanly when no eval backend is available so forgetting an
 * API key yields a green run instead of a red one. Same pattern as
 * `prompt.eval.ts` / `agent.eval.ts`.
 *
 * Dataset: reuses the synthetic fixture + golden cases from
 * `src/test/retrieval-eval/` — the same 11 cases the deterministic
 * ratchet scores, so per-case LLM judgments can be compared against
 * per-case deterministic judgments.
 */

import { describe, it } from 'vitest';
import { pickBackend, pickModel } from './backend.js';
import {
  buildFixtureHarness,
  runGoldenQuery,
  type EvalHit,
} from '../../src/test/retrieval-eval/harness.js';
import { GOLDEN_CASES } from '../../src/test/retrieval-eval/goldenCases.js';
import { FIXTURE_FILES } from '../../src/test/retrieval-eval/fixture.js';
import { judgeHitRelevance, judgeAnswerRelevancy, type JudgeHit } from './retrievalJudge.js';

/**
 * Resolve a retrieval hit back to the fixture entry that produced
 * it so the judge sees the actual symbol body (not a summary). The
 * harness doesn't carry bodies through the result shape, so we
 * re-lookup against the fixture.
 */
function buildJudgeHit(hit: EvalHit): JudgeHit | null {
  for (const file of FIXTURE_FILES) {
    if (file.path !== hit.filePath) continue;
    const sym = file.symbols.find((s) => s.qualifiedName === hit.qualifiedName);
    if (!sym) continue;
    const lines = file.source.split('\n');
    const body = lines.slice(sym.startLine - 1, sym.endLine).join('\n');
    return {
      symbolId: hit.symbolId,
      qualifiedName: hit.qualifiedName,
      kind: hit.kind,
      body,
    };
  }
  return null;
}

describe('retrieval LLM-eval (v0.62 e.3)', () => {
  const backend = pickBackend();
  const model = backend ? pickModel(backend) : '';

  it('scores every golden case via LLM judgment', async () => {
    if (!backend) {
      console.log('[retrieval.eval] Skipping — no backend available (set ANTHROPIC_API_KEY or SIDECAR_EVAL_BACKEND).');
      return;
    }

    const harness = await buildFixtureHarness();
    type CaseResult = {
      name: string;
      precision: number;
      perHitScores: number[];
      answerScore: number;
    };
    const results: CaseResult[] = [];

    for (const c of GOLDEN_CASES) {
      const hits = await runGoldenQuery(c.query, c, harness);
      // Cap to top-5 per case so one eval run doesn't fire 110+ LLM
      // calls. Cases with >5 hits are rare but the cap keeps cost
      // bounded regardless.
      const topHits = hits.slice(0, 5);
      const judgeHits = topHits.map(buildJudgeHit).filter((h): h is JudgeHit => h !== null);

      const perHitScores: number[] = [];
      for (const h of judgeHits) {
        const s = await judgeHitRelevance(c.query, h, backend, model);
        perHitScores.push(s);
      }
      const precision =
        perHitScores.length === 0
          ? 0
          : perHitScores.reduce((a, b) => a + b, 0) / perHitScores.length;

      const answerScore = await judgeAnswerRelevancy(c.query, judgeHits, backend, model);

      results.push({ name: c.name, precision, perHitScores, answerScore });
    }

    // Aggregate + report — this eval doesn't hard-fail on a
    // threshold because the judge is nondeterministic; the report
    // is the signal we want to watch release-over-release.
    const meanPrecision = results.reduce((a, r) => a + r.precision, 0) / results.length;
    const meanAnswer = results.reduce((a, r) => a + r.answerScore, 0) / results.length;
    const rows = results.map(
      (r) =>
        `  ${r.name.padEnd(64)}  judgedP=${r.precision.toFixed(2)}  answer=${r.answerScore.toFixed(2)}  hits=[${r.perHitScores.map((s) => s.toFixed(1)).join(',')}]`,
    );
    console.log(
      [
        '',
        '=========================================================',
        'LLM-judged retrieval scorecard',
        `  backend=${backend.name} model=${model}`,
        `  meanJudgedPrecision=${meanPrecision.toFixed(3)}  meanAnswerRelevancy=${meanAnswer.toFixed(3)}`,
        '',
        ...rows,
        '=========================================================',
        '',
      ].join('\n'),
    );
  }, 600_000); // hard timeout: 10 minutes (100+ LLM calls × 1-6s each)
});
