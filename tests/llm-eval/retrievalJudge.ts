/**
 * LLM-as-judge for retrieval quality (v0.62 e.3). Thin backend-
 * aware wrapper around the pure prompt-building + verdict-parsing
 * primitives in [`src/test/retrieval-eval/judgeParsing.ts`](../../src/test/retrieval-eval/judgeParsing.ts).
 *
 * Two judges:
 *   - `judgeHitRelevance`: per-hit (is this symbol relevant to the query?)
 *   - `judgeAnswerRelevancy`: per-query (do the top-K collectively answer it?)
 *
 * Both return a score in {0, 0.5, 1} driven by the verdict parsers
 * in the sibling module. Prompts are pinned in unit tests over
 * there so a prompt-engineering regression surfaces before any
 * tokens are spent.
 *
 * Lives under `tests/llm-eval/` because it calls real models via
 * `ModelBackend` and runs only under `npm run eval:llm`.
 */

import type { ModelBackend } from './backend.js';
import {
  buildRelevanceSystemPrompt,
  buildRelevanceUserMessage,
  buildAnswerSystemPrompt,
  buildAnswerUserMessage,
  parseRelevanceVerdict,
  parseAnswerVerdict,
} from '../../src/test/retrieval-eval/judgeParsing.js';

export interface JudgeHit {
  /** `filePath::qualifiedName` — used in the prompt so the judge
   *  can reason about where the symbol lives. */
  symbolId: string;
  qualifiedName: string;
  kind: string;
  body: string;
}

/**
 * Ask the judge whether a single `hit` is relevant to `query`.
 * Returns 1.0 (RELEVANT), 0.5 (BORDERLINE), or 0.0 (IRRELEVANT /
 * unparseable). Unparseable responses score 0 so rate-limited or
 * chatty output can't silently inflate the aggregate.
 */
export async function judgeHitRelevance(
  query: string,
  hit: JudgeHit,
  backend: ModelBackend,
  model: string,
): Promise<number> {
  const response = await backend.complete({
    systemPrompt: buildRelevanceSystemPrompt(),
    userMessage: buildRelevanceUserMessage({
      query,
      qualifiedName: hit.qualifiedName,
      kind: hit.kind,
      body: hit.body,
    }),
    model,
    maxTokens: 8,
  });
  return parseRelevanceVerdict(response);
}

/**
 * Ask the judge whether the concatenated top-K `hits` collectively
 * answer the query — catches the "every individual hit is plausible
 * but the set misses the point" failure mode.
 */
export async function judgeAnswerRelevancy(
  query: string,
  hits: JudgeHit[],
  backend: ModelBackend,
  model: string,
): Promise<number> {
  if (hits.length === 0) return 0;
  const response = await backend.complete({
    systemPrompt: buildAnswerSystemPrompt(),
    userMessage: buildAnswerUserMessage({
      query,
      hits: hits.map((h) => ({
        query,
        qualifiedName: h.qualifiedName,
        kind: h.kind,
        body: h.body,
      })),
    }),
    model,
    maxTokens: 8,
  });
  return parseAnswerVerdict(response);
}

/**
 * LLM-judged Context Precision — mean per-hit relevance score
 * across the retrieval result. Requires one LLM call per hit; the
 * caller is responsible for capping `hits.length` if cost matters.
 */
export async function llmJudgedPrecision(
  query: string,
  hits: JudgeHit[],
  backend: ModelBackend,
  model: string,
): Promise<{ score: number; perHitScores: number[] }> {
  if (hits.length === 0) return { score: 0, perHitScores: [] };
  const perHitScores: number[] = [];
  for (const hit of hits) {
    perHitScores.push(await judgeHitRelevance(query, hit, backend, model));
  }
  const score = perHitScores.reduce((a, b) => a + b, 0) / perHitScores.length;
  return { score, perHitScores };
}
