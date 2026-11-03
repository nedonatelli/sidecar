import type { ChatMessage } from '../../ollama/types.js';
import type { DecisionSink } from '../decisions.js';

/**
 * Every message the loop injects into the conversation goes through
 * {@link injectNudge}, so the trajectory records which nudge fired, on which
 * iteration, and about which files (#390). Before this, the only way to count a
 * nudge was to search the model's thinking for a quote of it: a lower bound
 * that broke whenever the wording changed, and that could not tell two nudges
 * sharing a prefix apart ("The request mentions" opens both no-read and
 * no-file-write). `nudge.test.ts` fails on a new `messages.push` of a user
 * message that bypasses this module.
 *
 * Each id names one injection site and never changes with the wording. The
 * completion gates use their gate `name`.
 */
export const NUDGE_SOURCES = [
  // completion gates (loop/completionGates/)
  'completion',
  'behavioral-verification',
  'change-impact',
  'numerical-contract',
  'analytic-bound',
  'plan-incomplete',
  'red-check',
  'no-read',
  'no-shell',
  'no-grounding',
  'unverified-claim',
  'mcp-mutation-verify',
  'no-file-write',
  'syntax',
  // the loop's own turn handling (loop.ts)
  'tool-call-parse',
  'degenerate-output',
  'output-limit',
  'empty-response',
  'cycle-nudge',
  // post-turn policies
  'action-already-done',
  'code-not-applied',
  'no-tools-called',
  'auto-fix',
  'rewrite-escalation',
  'edit-to-write',
  'isolate-rewrite',
  'stub-check',
  'unapplied-edit',
  'regression-guard',
  'regression-guard-exhausted',
  // SWE-bench harness hooks (bench/swe/)
  'whole-suite',
  'bad-test-label',
] as const;

export type NudgeSource = (typeof NUDGE_SOURCES)[number];

/** What a nudge needs from the loop: where to push it and where to record it. */
export interface NudgeTarget {
  messages: ChatMessage[];
  logger?: DecisionSink;
  iteration: number;
}

/** Record that a nudge was injected. For a site that appends to an existing message instead of pushing one. */
export function recordNudge(
  state: Omit<NudgeTarget, 'messages'>,
  source: NudgeSource,
  text: string,
  files?: string[],
): void {
  state.logger?.logDecision?.({
    kind: 'reprompt',
    action: 'injected',
    source,
    iteration: state.iteration,
    ...(files && files.length > 0 ? { files } : {}),
    text: text.slice(0, 200),
  });
}

/** Push a nudge as a user message and record it. */
export function injectNudge(
  state: NudgeTarget,
  source: NudgeSource,
  content: ChatMessage['content'],
  files?: string[],
): void {
  state.messages.push({ role: 'user', content });
  const text =
    typeof content === 'string'
      ? content
      : content
          .map((b) => (b.type === 'text' ? b.text : ''))
          .join('\n')
          .trim();
  recordNudge(state, source, text, files);
}
