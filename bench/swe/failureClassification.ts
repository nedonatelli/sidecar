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

/**
 * - `infra`: the harness or backend broke; excluded from the capability
 *   denominator (isInfraFailure).
 * - `harness-timeout` (#308): the per-task wall clock ended the run. Labelled
 *   apart, so a log doesn't call it a capability failure, but it STAYS in the
 *   denominator: a model too slow to finish in the budget is a real cost to a
 *   user. report.ts counts these per arm separately (timeoutNotes).
 * - `capability`: anything else that failed.
 */
export type FailureKind = 'infra' | 'harness-timeout' | 'capability' | 'none';

/** The failureReason swe.eval.ts records when the per-task timer ends a run. */
const PER_TASK_TIMEOUT_RE = /^per-task timeout after \d+ms/i;

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
  // The task's repository isn't in SIDECAR_SWE_REPO_CACHE: the run stopped
  // before the agent did anything. The nemotron overnight queue (2026-10-21)
  // had 22 of these labelled [capability] (#292). The driver now refuses before
  // the first task; this covers a miss that still happens mid-run.
  'repo cache miss',
  // The task's environment build, also before the agent runs. A cached venv
  // half-deleted by the macOS temp purge failed `uv pip install -e .` on every
  // Django task -- 0 turns, labeled [capability] (#208). These match the
  // harness's own uv invocations (setupTaskEnv), not anything the model runs.
  ' pip install --python ',
  ' venv --python ',
  // The machine slept mid-task (hostSuspend.ts): its requests stalled and the
  // run looked like a model failure (#259).
  'host suspended for ',
  // vLLM's engine process died (EngineDeadError). The server answers every
  // later request with this message; nemotron-3-super on a DGX Spark hit it 27
  // turns into requests-1963 scaffold-on, recorded as [capability].
  'enginecore encountered an issue',
];

export function classifyFailure(err: unknown): FailureClassification {
  if (err === null || err === undefined) return { reason: '', kind: 'none' };
  const reason = err instanceof Error ? err.message : String(err);
  const haystack = reason.toLowerCase();
  if (INFRA_SIGNATURES.some((s) => haystack.includes(s))) return { reason, kind: 'infra' };
  // The v0.132.0 nemotron run (#307) printed `EMPTY [capability]` for a run the
  // per-task timer ended, while its metadata said harness-timeout.
  if (PER_TASK_TIMEOUT_RE.test(reason.trim())) return { reason, kind: 'harness-timeout' };
  return { reason, kind: 'capability' };
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
