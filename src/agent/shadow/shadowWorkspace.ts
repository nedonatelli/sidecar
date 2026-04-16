import * as path from 'path';
import * as fs from 'fs';
import { randomBytes } from 'crypto';
import { GitCLI } from '../../github/git.js';

/**
 * A `ShadowWorkspace` is an ephemeral git worktree at
 * `.sidecar/shadows/<task-id>/` where the agent performs its writes
 * while the user's main working tree stays pristine. On task completion,
 * a unified diff is computed and — if the user accepts — applied onto
 * main. On reject, the worktree is torn down and nothing ever reaches
 * the user's real files.
 *
 * Storage efficiency: `git worktree add` shares the main repo's object
 * database, so only the tracked-source checkout costs disk space. There's
 * no object-copy, no full clone. For a typical codebase this is tens of
 * megabytes — most of it in the checked-out files, not git metadata.
 *
 * Scope for v0.59 MVP:
 *   - Creation + teardown over the GitCLI worktree primitives.
 *   - Diff computation against the original HEAD (tracked + untracked).
 *   - Apply-diff-to-main on accept.
 *   - No symlinked build-dir mounting yet — agents that need
 *     `node_modules` etc. during gate runs will have to install them
 *     once per shadow (or we add mounting in v0.60).
 *   - No rebase-on-moved-main conflict handling — a shadow created off
 *     HEAD assumes main hasn't moved while it was active. Real usage
 *     rarely hits this; we'll add rebase when it does.
 */
export interface ShadowWorkspaceOptions {
  /** Main workspace root — the repository the shadow branches off of. */
  mainRoot: string;
  /**
   * Where shadows live. Default `<mainRoot>/.sidecar/shadows/`.
   * Kept outside the git-tracked top-level because shadows are
   * per-machine ephemeral state (matches the gitignored-subdirs rule).
   */
  shadowsRoot?: string;
  /**
   * Optional human-friendly prefix for the shadow directory name.
   * Full directory = `<prefix>-<8-hex>`. Default prefix: `task`.
   */
  idPrefix?: string;
}

export class ShadowWorkspace {
  readonly path: string;
  readonly id: string;
  readonly mainRoot: string;
  private readonly mainGit: GitCLI;
  private readonly shadowGit: GitCLI;
  /** Captured at creation so a diff-apply later knows the exact ref the shadow branched off of. */
  private baseSha: string | null = null;
  private disposed = false;

  constructor(options: ShadowWorkspaceOptions) {
    this.mainRoot = options.mainRoot;
    const shadowsRoot = options.shadowsRoot ?? path.join(options.mainRoot, '.sidecar', 'shadows');
    const prefix = options.idPrefix ?? 'task';
    this.id = `${prefix}-${randomBytes(4).toString('hex')}`;
    this.path = path.join(shadowsRoot, this.id);
    this.mainGit = new GitCLI(this.mainRoot);
    this.shadowGit = new GitCLI(this.path);
  }

  /**
   * Create the shadow worktree. Must be called before any other method.
   * Also captures the base SHA so later diff/apply operations know what
   * ref the shadow branched off of.
   */
  async create(): Promise<void> {
    if (this.disposed) throw new Error('ShadowWorkspace: cannot create() after dispose()');
    fs.mkdirSync(path.dirname(this.path), { recursive: true });
    this.baseSha = await this.mainGit.getHeadSha();
    await this.mainGit.worktreeAdd(this.path, this.baseSha);
  }

  /**
   * Produce a unified diff of all changes in the shadow vs the base HEAD
   * it was created from. Covers both tracked edits and untracked new
   * files. Returns an empty string if nothing changed — callers use that
   * to short-circuit the review UI.
   */
  async diff(): Promise<string> {
    this.ensureActive();
    return this.shadowGit.diffAgainstHead();
  }

  /**
   * Apply the shadow's diff onto the main working tree. Stages the
   * changes so the user sees them in `git status` as staged. Returns
   * the human-readable result from `git apply` (mostly for the
   * one-line confirmation in the UI).
   *
   * Throws if the patch won't apply cleanly — the caller is expected
   * to surface the conflict to the user. v0.59 doesn't auto-rebase
   * on conflicts; that's a follow-up.
   */
  async applyToMain(): Promise<string> {
    this.ensureActive();
    const patch = await this.diff();
    if (!patch) return 'No changes to apply.';
    // Dry-run first so a partial apply doesn't leave main in a half-
    // patched state if the end of the patch conflicts with something.
    await this.mainGit.applyPatch(patch, { check: true });
    return this.mainGit.applyPatch(patch, { stage: true });
  }

  /**
   * Tear down the worktree and delete the shadow directory. Idempotent —
   * calling after already-disposed is a no-op rather than throwing,
   * which makes it safe to chain in `finally` blocks.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.mainGit.worktreeRemove(this.path, true);
    } catch {
      // Worktree might already be gone if the user deleted it manually,
      // or git might not know about it if create() failed partway. Fall
      // through to the directory cleanup — best-effort.
    }
    try {
      fs.rmSync(this.path, { recursive: true, force: true });
    } catch {
      // Directory might already be gone or have readonly children from
      // symlinked deps. Not fatal for teardown.
    }
  }

  /** True iff create() succeeded and dispose() hasn't run yet. */
  get isActive(): boolean {
    return this.baseSha !== null && !this.disposed;
  }

  private ensureActive(): void {
    if (this.disposed) throw new Error('ShadowWorkspace: already disposed');
    if (!this.baseSha) throw new Error('ShadowWorkspace: call create() before diff() / applyToMain()');
  }
}
