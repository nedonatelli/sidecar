/**
 * Failure taxonomy (scaffolding roadmap F1).
 *
 * Aggregate pass/fail hides WHICH failure bucket is killing a model, and each
 * bucket has a different fix (constrained decoding vs. plan externalization vs.
 * model escalation). This classifies a failed agent run into exactly one bucket
 * from signals the loop already has, so the distribution can be reported per
 * model and steer where scaffolding effort goes.
 *
 * Pure + deterministic — no model call, no I/O. A run that completed cleanly
 * classifies as `null` (success).
 */

export type FailureBucket =
  /** The model couldn't emit a valid/parseable tool call (even after repair). */
  | 'malformed-call'
  /** Tools were called but kept erroring — wrong tool or wrong arguments. */
  | 'wrong-tool'
  /** Ran out of iterations / wall-clock before finishing. */
  | 'timeout'
  /** Verification kept rejecting the work and the gate gave up. */
  | 'incomplete'
  /** Produced output but never acted, or stalled without progress. */
  | 'bad-reasoning';

export interface RunFailureSignals {
  /** The run terminated naturally via the model declaring done. */
  completedNaturally: boolean;
  /** The run hit its iteration cap. */
  hitMaxIterations: boolean;
  /** User pressed Stop. Aborted runs are not failures — classify as success. */
  aborted: boolean;
  /** Tool calls whose arguments never parsed, even after repair. */
  unrepairedMalformedCalls: number;
  /** Total tool calls in the run. */
  toolCalls: number;
  /** Tool calls that returned an error result. */
  toolErrors: number;
  /** Completion gate exhausted its injection budget (couldn't get verification). */
  gateExhausted: boolean;
}

const HIGH_TOOL_ERROR_RATE = 0.5;

/**
 * Classify a run into a failure bucket, or `null` when it succeeded. Order
 * matters: the most specific, highest-confidence signals are checked first so a
 * run lands in exactly one bucket.
 */
export function classifyFailureBucket(s: RunFailureSignals): FailureBucket | null {
  // A clean, user-initiated stop is not a failure.
  if (s.aborted) return null;
  // Natural completion with no exhausted gate is a success.
  if (s.completedNaturally && !s.gateExhausted) return null;

  // Couldn't produce valid tool calls — the syntactic failure class.
  if (s.unrepairedMalformedCalls > 0) return 'malformed-call';

  // Ran out of room before finishing.
  if (s.hitMaxIterations) return 'timeout';

  // Verification kept rejecting the work and the gate gave up.
  if (s.gateExhausted) return 'incomplete';

  // Tools were exercised but mostly errored — wrong tool / wrong args.
  if (s.toolCalls > 0 && s.toolErrors / s.toolCalls >= HIGH_TOOL_ERROR_RATE) return 'wrong-tool';

  // Terminated without completing and without any of the above — the model
  // stalled or reasoned itself into a dead end.
  return 'bad-reasoning';
}
