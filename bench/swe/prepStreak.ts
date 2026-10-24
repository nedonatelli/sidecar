// ---------------------------------------------------------------------------
// Stop a shard whose repository preparation keeps failing.
//
// On 2026-10-23 a VS Code window reload left a running SWE shard unable to run
// git. The shard carried on: 21 of its 50 tasks failed repo preparation in
// 0 s each (`git reset --hard`, then three `git clone` attempts per repo), and
// every one was recorded as an `EMPTY [infra]` row. The cell "finished" and
// had to be rerun in full. A run that can't prepare repositories can't produce
// anything; it should stop at once and say why, keeping what it already did.
// ---------------------------------------------------------------------------

/** Consecutive repo-preparation failures that stop a shard. */
export const PREP_STREAK_LIMIT = 3;

// The failure reasons repo preparation raises before the agent starts. These
// are the harness's own commands (prepareRepo, setupTaskEnv, the repo cache), so
// a model's run_command can never produce them, and the turn count is 0.
const PREP_SIGNATURES = [
  'command failed: git',
  'fatal: ',
  'repo cache miss',
  'cannot clear clone dir',
  'checkout mismatch',
  ' pip install --python ',
  ' venv --python ',
];

/** True when the prediction failed in repository preparation, before the agent ran. */
export function isRepoPrepFailure(p: { turns?: number; failureReason?: string | null }): boolean {
  if ((p.turns ?? 0) !== 0 || !p.failureReason) return false;
  const reason = p.failureReason.toLowerCase();
  return PREP_SIGNATURES.some((s) => reason.includes(s));
}

/** Counts consecutive repo-preparation failures; any other outcome resets it. */
export class PrepFailureStreak {
  private streak: { id: string; reason: string }[] = [];

  constructor(private readonly limit = PREP_STREAK_LIMIT) {}

  /**
   * Record a prediction. Returns the stop message once `limit` in a row failed
   * repo preparation, else null.
   */
  record(p: { instance_id: string; turns?: number; failureReason?: string | null }): string | null {
    if (!isRepoPrepFailure(p)) {
      this.streak = [];
      return null;
    }
    this.streak.push({ id: p.instance_id, reason: (p.failureReason ?? '').split('\n')[0].slice(0, 200) });
    if (this.streak.length < this.limit) return null;
    return (
      `[swe] stopping: repository preparation failed for ${this.streak.length} tasks in a row ` +
      `(${this.streak.map((s) => s.id).join(', ')}). Last error: ${this.streak[this.streak.length - 1].reason}. ` +
      `The run cannot prepare repositories (git unavailable, network, or a broken clone), so further tasks would ` +
      `only record empty [infra] rows. Fix the cause and rerun the shard.`
    );
  }
}
