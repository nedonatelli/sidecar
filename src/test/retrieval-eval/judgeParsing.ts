/**
 * Pure prompt-building + verdict-parsing primitives for the
 * LLM-judged retrieval eval (v0.62 e.3). Split out from the
 * backend-aware judge (`tests/llm-eval/retrievalJudge.ts`) because
 * these are deterministic and belong in the main test suite — the
 * LLM call is the nondeterministic bit, and it's tested separately
 * by the eval runner.
 *
 * Keeping parsers here means a prompt-engineering change surfaces
 * as a broken unit test *before* anyone spends tokens running the
 * eval against a real model.
 */

/**
 * Input shape for prompt builders. Symbol body is pre-truncated
 * by the caller — keeps this module free of truncation policy.
 */
export interface JudgePromptInput {
  query: string;
  qualifiedName: string;
  kind: string;
  body: string;
}

/** Max body length embedded in the prompt. Caps worst-case token
 *  spend when a symbol body happens to be unusually large. */
export const JUDGE_BODY_CHAR_CAP = 2000;

/**
 * Build the system prompt the per-hit relevance judge sees. Pure
 * function so tests can pin the exact text.
 */
export function buildRelevanceSystemPrompt(): string {
  return (
    'You are a strict retrieval-quality judge. Given a natural-language query about a codebase and a single code symbol (function, class, interface, etc.), decide whether the symbol is relevant to answering the query.\n\n' +
    'Relevance rubric:\n' +
    '- RELEVANT: the symbol directly implements, documents, or is a structurally important part of what the query asks about.\n' +
    '- BORDERLINE: the symbol is tangentially related (adjacent feature, helper called by the relevant one) but not the primary answer.\n' +
    '- IRRELEVANT: the symbol has no meaningful connection to the query.\n\n' +
    'Answer with exactly one word: RELEVANT, BORDERLINE, or IRRELEVANT. No explanation.'
  );
}

/**
 * Build the user message the per-hit relevance judge sees. Applies
 * the body char cap so the caller doesn't need to track it.
 */
export function buildRelevanceUserMessage(input: JudgePromptInput): string {
  return (
    `Query: ${input.query}\n\n` +
    `Symbol: ${input.qualifiedName} (${input.kind})\n` +
    `Body:\n\`\`\`\n${input.body.slice(0, JUDGE_BODY_CHAR_CAP)}\n\`\`\``
  );
}

/**
 * System prompt for the "did the top-K collectively answer the
 * query?" judge. Mirrors `buildRelevanceSystemPrompt` in shape so
 * the two judges return parseable one-word responses.
 */
export function buildAnswerSystemPrompt(): string {
  return (
    'You are a strict retrieval-quality judge. Given a natural-language query about a codebase and the top retrieval results (a list of code symbols), decide whether the results collectively answer the query.\n\n' +
    'Rubric:\n' +
    '- ANSWERED: the results contain enough information for a reader to answer the query without additional retrieval.\n' +
    '- PARTIAL: the results are on-topic but miss one or more load-bearing pieces a reader would need.\n' +
    '- MISSED: the results fail to address the query, even if individual items look plausible.\n\n' +
    'Answer with exactly one word: ANSWERED, PARTIAL, or MISSED. No explanation.'
  );
}

/** Cap the answer-judge prompt at this many hits — keeps the
 *  user message bounded even when the caller throws in 100 hits. */
export const ANSWER_JUDGE_HIT_CAP = 10;
/** Per-hit body length in the answer judge's prompt. Smaller than
 *  the per-hit judge because the answer judge sees N hits × each. */
export const ANSWER_JUDGE_PER_HIT_BODY_CHARS = 600;

export interface AnswerJudgePromptInput {
  query: string;
  hits: JudgePromptInput[];
}

/**
 * Build the user message for the answer-relevancy judge. Caps the
 * number of listed hits and per-hit body size so total prompt
 * length stays predictable.
 */
export function buildAnswerUserMessage(input: AnswerJudgePromptInput): string {
  const resultsBlock = input.hits
    .slice(0, ANSWER_JUDGE_HIT_CAP)
    .map(
      (h, i) =>
        `#${i + 1} ${h.qualifiedName} (${h.kind})\n\`\`\`\n${h.body.slice(0, ANSWER_JUDGE_PER_HIT_BODY_CHARS)}\n\`\`\``,
    )
    .join('\n\n');
  return `Query: ${input.query}\n\nTop results:\n${resultsBlock}`;
}

/**
 * Parse the per-hit relevance verdict into a score in {0, 0.5, 1}.
 * Strict match-on-uppercase so trailing punctuation or whitespace
 * doesn't throw off the score, but a garbage response (judge refused,
 * rate-limited, chatty) scores 0 — one bad response shouldn't
 * silently inflate the aggregate.
 */
export function parseRelevanceVerdict(response: string): number {
  const upper = response.trim().toUpperCase();
  if (upper.startsWith('RELEVANT')) return 1;
  if (upper.startsWith('BORDERLINE')) return 0.5;
  if (upper.startsWith('IRRELEVANT')) return 0;
  return 0;
}

/** Parse the answer-relevancy verdict. Same strict-match rules. */
export function parseAnswerVerdict(response: string): number {
  const upper = response.trim().toUpperCase();
  if (upper.startsWith('ANSWERED')) return 1;
  if (upper.startsWith('PARTIAL')) return 0.5;
  if (upper.startsWith('MISSED')) return 0;
  return 0;
}
