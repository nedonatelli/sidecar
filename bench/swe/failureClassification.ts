// ---------------------------------------------------------------------------
// Infra-vs-capability failure classification for SWE-bench arms.
//
// A solve that dies to a dropped backend connection is not the model failing to
// fix the bug, but both previously serialised to an indistinguishable empty
// patch. That conflation is not random noise: longer runs have more exposure to
// aborts, so it falls hardest on whichever arm does the most work — measured
// live at `gate-only` 1202s against `scaffold-off` 154s on the same task. The
// harness therefore *understated* scaffolded arms, hiding real effects rather
// than inventing false ones.
//
// The pre-existing convention on `SwePrediction.toolCalls` ("zero + empty patch
// = infrastructure failure the ablation excludes") only caught runs that never
// engaged the repo at all. Observed failures ran 6 and 8 turns before dying.
// ---------------------------------------------------------------------------

import type { SwePrediction } from './types.js';

export type FailureKind = 'infra' | 'capability' | 'none';

export interface FailureClassification {
  reason: string;
  kind: FailureKind;
}

/**
 * Error substrings meaning the harness or backend failed, not the model.
 * Matched case-insensitively against the thrown message.
 */
const INFRA_SIGNATURES = [
  'fetch failed',
  'terminated',
  'aborted',
  'socket hang up',
  'econnrefused',
  'econnreset',
  'etimedout',
  'network',
  'stream closed',
  // Repo preparation, not the model. A checkout that cannot reach its base
  // commit fails BEFORE the agent runs — 0 turns, 3 seconds — yet landed in the
  // capability bucket because every signature above describes the backend.
  // Observed on 3 of 20 tasks in one run: `Command failed: git reset --hard
  // --quiet 44c24bf…`, reported as `[capability]`. The ablation excluded them
  // anyway via the toolCalls===0 fallback, so the numbers were right and only
  // the label lied — but the label is what a reader trusts a run by.
  'command failed: git',
  'fatal: ',
  'reference is not a tree',
  'did not match any file(s) known to git',
];

export function classifyFailure(err: unknown): FailureClassification {
  if (err === null || err === undefined) return { reason: '', kind: 'none' };
  const reason = err instanceof Error ? err.message : String(err);
  const haystack = reason.toLowerCase();
  const kind: FailureKind = INFRA_SIGNATURES.some((s) => haystack.includes(s)) ? 'infra' : 'capability';
  return { reason, kind };
}

/**
 * Should this prediction be excluded from the capability denominator?
 *
 * A salvaged patch always counts, even after an infra failure — the agent
 * produced real work and the official harness can judge whether it resolves.
 */
export function isInfraFailure(
  p: Pick<SwePrediction, 'failureReason' | 'toolCalls'> & { model_patch: string },
): boolean {
  if (p.model_patch) return false;
  if (p.failureReason && classifyFailure(new Error(p.failureReason)).kind === 'infra') return true;
  return p.toolCalls === 0;
}
