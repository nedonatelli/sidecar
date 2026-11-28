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
  /**
   * The loop stopped the run itself: cycle detection, the burst cap, degenerate
   * output, or the syntax-gate bail (`termination: 'stuck'`). It used to fall
   * through to `bad-reasoning`, which hid that a loop control ended the run,
   * including runs that had already solved the task and were re-checking
   * (nemotron-3-super astropy-12907, resolved, stopped on four identical reads)
   * (#271).
   */
  | 'loop-stopped'
  /**
   * The run ended on an error from outside the model's reasoning: the backend
   * or the transport (an HTTP 502, vLLM's "EngineCore encountered an issue",
   * a dropped connection). These fell through to `bad-reasoning`, so a server
   * outage counted against the model: 69 of 100 runs in one nemotron3-super
   * canary, 66 of them 502s (#271).
   */
  | 'infra'
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
  /** A loop control stopped the run (`termination: 'stuck'`). Optional for callers built before #271. */
  loopStopped?: boolean;
  /**
   * The message of the error the run ended on (`termination: 'error'`), or
   * undefined when it did not end on one. Optional for callers built before
   * #271's infra bucket.
   */
  runError?: string;
}

const HIGH_TOOL_ERROR_RATE = 0.5;

/**
 * A backend's rejection of a tool call the model wrote, after the loop's
 * re-asks ran out: JSON or XML that did not parse, or a tool name the request
 * did not offer. Mirrors the matchers in loop.ts (not imported: loop.ts
 * imports this module's callers).
 */
const MODEL_CALL_ERROR =
  /error parsing tool call|invalid character |unexpected end of JSON input|XML syntax error|expected element type <|tool '[\s\S]+' not found/i;

/** Ollama aborting generation that repeats itself: a degenerate-output stop. */
const DEGENERATE_OUTPUT_ERROR = /token repeat limit reached/i;

/**
 * The bucket for a run that ended on an error. Most are `infra`; two kinds
 * are the model's own output, refused by the backend:
 * - a tool call it could not parse, or a tool not offered -> `malformed-call`;
 * - generation aborted for repeating itself -> `loop-stopped`, the bucket the
 *   loop's own degenerate-output stop already uses.
 */
export function classifyRunError(message: string): 'infra' | 'malformed-call' | 'loop-stopped' {
  if (MODEL_CALL_ERROR.test(message)) return 'malformed-call';
  if (DEGENERATE_OUTPUT_ERROR.test(message)) return 'loop-stopped';
  return 'infra';
}

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

  // Ended on an error: the error, not the run's other signals, is why it
  // stopped. Checked before the tool-error rate, which a run that had barely
  // started can trip by chance.
  if (s.runError !== undefined) return classifyRunError(s.runError);

  // Couldn't produce valid tool calls — the syntactic failure class.
  if (s.unrepairedMalformedCalls > 0) return 'malformed-call';

  // Ran out of room before finishing.
  if (s.hitMaxIterations) return 'timeout';

  // Verification kept rejecting the work and the gate gave up.
  if (s.gateExhausted) return 'incomplete';

  // Tools were exercised but mostly errored — wrong tool / wrong args.
  if (s.toolCalls > 0 && s.toolErrors / s.toolCalls >= HIGH_TOOL_ERROR_RATE) return 'wrong-tool';

  // A loop control ended it. Checked last before the catch-all, so it only
  // replaces `bad-reasoning`; a stuck run that also matched a more specific
  // bucket above keeps that one.
  if (s.loopStopped) return 'loop-stopped';

  // Terminated without completing and without any of the above — the model
  // stalled or reasoned itself into a dead end.
  return 'bad-reasoning';
}
