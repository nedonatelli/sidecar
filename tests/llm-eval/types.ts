// ---------------------------------------------------------------------------
// Case and result shapes for the LLM eval harness.
// ---------------------------------------------------------------------------

/**
 * One evaluation case: a user message, the conditions a good response
 * should meet, and the conditions it absolutely must not meet. Cases
 * test the prompt + model jointly — the same case run against
 * different system prompts or different models produces different
 * pass/fail patterns, which is exactly the signal we want for
 * regression detection.
 */
export interface EvalCase {
  /** Stable identifier for this case. */
  id: string;
  /** One-line description shown in the report. */
  description: string;
  /** The user message sent to the model. */
  userMessage: string;
  /**
   * Tags for filtering. Useful tags so far: `prompt`, `safety`,
   * `honesty`, `tool-output`, `regression`. Free-form — nothing
   * enforces the set.
   */
  tags: string[];
  /** Expectations the response must satisfy to score as passing. */
  expect: Expectations;
  /**
   * If the base prompt is being exercised in a non-default mode
   * (plan / review / etc.) pass that here so `buildBaseSystemPrompt`
   * picks up the mode-specific addendum. Defaults to 'cautious'.
   */
  approvalMode?: 'autonomous' | 'cautious' | 'manual' | 'plan' | 'review';
}

/**
 * Assertions over a model response. All checks are deterministic —
 * keyword matching and length bounds — so scoring is stable across
 * runs even though the underlying LLM output is not. Any LLM-as-judge
 * scoring lives in a separate scorer and is called out per-case.
 */
export interface Expectations {
  /** All listed substrings must appear in the response (case-insensitive). */
  mustContain?: string[];
  /** None of these substrings may appear in the response (case-insensitive). */
  mustNotContain?: string[];
  /** Regex patterns, all must match. */
  mustMatch?: RegExp[];
  /** Regex patterns, none may match. */
  mustNotMatch?: RegExp[];
  /** Response length must be at least this many characters. */
  minLength?: number;
  /** Response length must be at most this many characters. */
  maxLength?: number;
}

/**
 * Per-case scoring output. `passed` is the aggregate — true only if
 * every expectation held. `failures` lists the individual predicates
 * that failed, so the report tells you WHY a case regressed.
 */
export interface CaseResult {
  id: string;
  description: string;
  passed: boolean;
  failures: string[];
  response: string;
  durationMs: number;
}
