import { window, commands, Uri } from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { GitCLI } from '../../github/git.js';
import { filesTouchedByDiff } from '../facets/facetReview.js';
import type { ForkDispatchBatchResult } from './forkDispatcher.js';

// ---------------------------------------------------------------------------
// Fork review (v0.67 chunk 5, diff-only MVP).
//
// After `dispatchForks` completes, every fork carries a `pendingDiff`
// in its sandbox field (v0.66 chunk 3.6 deferPrompt pattern). This
// module turns the batch into a pick-the-winner review surface:
//
//   1. Show a QuickPick listing every reviewable fork with its label,
//      duration, files-touched count, and success/failure state.
//   2. On pick: render the fork's diff via `vscode.diff` against an
//      empty buffer so the user can inspect + confirm.
//   3. On confirm: `git apply` the winner's diff to main; the other
//      forks are discarded (their shadows were already disposed by
//      the sandbox's autoCleanup). On conflict: surface the error
//      so the user knows which fork couldn't merge cleanly.
//
// Semantic differs from Facets (v0.66 chunk 3.6): Facets review is
// multi-select (each specialist did a different subtask, accept/
// reject each independently). Fork review is single-select — every
// fork attempted the same task, so the question is "which one won?"
// not "which ones to merge?"
//
// Chunk 4's per-fork metrics strip (LOC added/removed, tests added/
// passed, guards passed/failed) was dropped from v0.67 — the review
// UX compares forks by eyeballing diffs, not by measurable criteria.
// If eyeballing proves insufficient in practice, metrics ship as
// v0.67.1 or v0.68's carry-forward.
// ---------------------------------------------------------------------------

export interface ReviewableFork {
  readonly forkId: string;
  readonly index: number;
  readonly label: string;
  readonly pendingDiff: string;
  readonly files: readonly string[];
  readonly durationMs: number;
  readonly charsConsumed: number;
}

export interface ForkReviewPlan {
  readonly reviewable: readonly ReviewableFork[];
  readonly skipped: readonly { forkId: string; label: string; reason: string }[];
}

/**
 * Classify a dispatched fork batch into reviewable entries (successful
 * runs with a non-empty diff) and skipped entries (failed runs, or
 * successful runs that produced no changes). The skipped list feeds
 * the picker's header so nothing drops silently — "2 forks ran with
 * no changes, 1 failed with <error>, 1 reviewable" keeps the user
 * oriented.
 */
export function planForkReview(batch: ForkDispatchBatchResult): ForkReviewPlan {
  const reviewable: ReviewableFork[] = [];
  const skipped: Array<{ forkId: string; label: string; reason: string }> = [];

  for (const r of batch.results) {
    const diff = r.sandbox.pendingDiff;
    if (r.success && diff && diff.length > 0) {
      reviewable.push({
        forkId: r.forkId,
        index: r.index,
        label: r.label,
        pendingDiff: diff,
        files: filesTouchedByDiff(diff),
        durationMs: r.durationMs,
        charsConsumed: r.charsConsumed,
      });
    } else if (!r.success) {
      skipped.push({
        forkId: r.forkId,
        label: r.label,
        reason: r.errorMessage ?? 'failed',
      });
    } else {
      skipped.push({
        forkId: r.forkId,
        label: r.label,
        reason: r.sandbox.reason ?? 'no-diff',
      });
    }
  }

  return { reviewable, skipped };
}

// ---------------------------------------------------------------------------
// Review UI
// ---------------------------------------------------------------------------

export interface ForkReviewUi {
  /** Pick one fork from the reviewable set, or undefined to cancel. */
  showQuickPick<T extends { label: string }>(items: T[], placeholder: string): Promise<T | undefined>;
  /** Confirm-or-cancel modal after viewing the winner's diff. */
  showWarningConfirm(message: string, confirmLabel: string): Promise<string | undefined>;
  showInfo(message: string): void;
  showError(message: string): void;
  openDiff(left: Uri, right: Uri, title: string): Promise<void>;
}

export interface ForkReviewDeps {
  readonly ui: ForkReviewUi;
  readonly mainRoot: string;
  /**
   * Overrideable applier — production calls `GitCLI.applyPatch`;
   * tests inject a spy. Returns the `git apply` stdout on success,
   * throws on conflict.
   */
  readonly applyDiff?: (mainRoot: string, diff: string) => Promise<string>;
  /**
   * Hook for writing temp scratch files for the diff viewer. Tests
   * inject a no-op returning a fake URI.
   */
  readonly writeTempFile?: (prefix: string, content: string) => Promise<Uri>;
}

export interface ForkReviewOutcome {
  /** Index of the fork that won, or null when the review was cancelled. */
  readonly winnerIndex: number | null;
  /** `true` iff `git apply` of the winner's diff succeeded. */
  readonly appliedOk: boolean;
  /** Error message when `appliedOk === false` despite `winnerIndex !== null`. */
  readonly errorMessage?: string;
  /** Labels of forks skipped because they failed or produced no diff. */
  readonly skippedLabels: readonly string[];
}

/**
 * Drive the fork review. Single-winner semantic: the user picks one
 * fork (or cancels); on pick, the diff opens in `vscode.diff` and a
 * confirmation gate blocks apply until the user signs off. The other
 * forks' shadows were already disposed by the sandbox — nothing to
 * clean up client-side.
 */
export async function reviewForkBatch(
  batch: ForkDispatchBatchResult,
  deps: ForkReviewDeps,
): Promise<ForkReviewOutcome> {
  const plan = planForkReview(batch);
  const skippedLabels = plan.skipped.map((s) => s.label);

  if (plan.reviewable.length === 0) {
    const msg =
      plan.skipped.length === 0
        ? 'No fork results to review.'
        : `No fork produced a reviewable diff (${plan.skipped.length} skipped).`;
    deps.ui.showInfo(msg);
    return { winnerIndex: null, appliedOk: false, skippedLabels };
  }

  const applyDiff = deps.applyDiff ?? defaultApplyDiff;
  const writeTempFile = deps.writeTempFile ?? defaultWriteTempFile;

  const items = plan.reviewable.map(reviewableToPickItem);
  const picked = await deps.ui.showQuickPick(
    items,
    `${plan.reviewable.length} fork${plan.reviewable.length === 1 ? '' : 's'} to review — pick the winner`,
  );
  if (!picked) {
    return { winnerIndex: null, appliedOk: false, skippedLabels };
  }

  const winner = plan.reviewable.find((r) => r.forkId === picked.forkId);
  if (!winner) {
    // Picker item → reviewable mismatch; defensive, should never happen.
    deps.ui.showError('Internal: picked fork no longer in review plan.');
    return { winnerIndex: null, appliedOk: false, skippedLabels };
  }

  // Show the diff, then gate apply behind an explicit confirmation so
  // the user can back out after seeing what lands.
  const left = await writeTempFile(`${winner.forkId}-before`, '');
  const right = await writeTempFile(`${winner.forkId}-patch`, winner.pendingDiff);
  await deps.ui.openDiff(left, right, `${winner.label} — patch (${winner.files.length} file(s))`);

  const choice = await deps.ui.showWarningConfirm(
    `Apply ${winner.label} to main? Other ${plan.reviewable.length - 1} fork(s) will be discarded.`,
    'Apply',
  );
  if (choice !== 'Apply') {
    return { winnerIndex: null, appliedOk: false, skippedLabels };
  }

  try {
    await applyDiff(deps.mainRoot, winner.pendingDiff);
    deps.ui.showInfo(`Applied ${winner.label} (${winner.files.length} file(s)).`);
    return { winnerIndex: winner.index, appliedOk: true, skippedLabels };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.ui.showError(`Failed to apply ${winner.label}: ${message}`);
    return {
      winnerIndex: winner.index,
      appliedOk: false,
      errorMessage: message,
      skippedLabels,
    };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ForkPickItem {
  label: string;
  description: string;
  detail: string;
  forkId: string;
}

function reviewableToPickItem(r: ReviewableFork): ForkPickItem {
  const fileCount = r.files.length;
  const seconds = (r.durationMs / 1000).toFixed(1);
  return {
    label: `$(git-commit) ${r.label}`,
    description: `${fileCount} file${fileCount === 1 ? '' : 's'} · ${seconds}s`,
    detail: r.files.slice(0, 4).join(' · ') + (r.files.length > 4 ? ' …' : ''),
    forkId: r.forkId,
  };
}

async function defaultApplyDiff(mainRoot: string, diff: string): Promise<string> {
  const git = new GitCLI(mainRoot);
  await git.applyPatch(diff, { check: true });
  return git.applyPatch(diff, { stage: true });
}

async function defaultWriteTempFile(prefix: string, content: string): Promise<Uri> {
  const safe = prefix.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(os.tmpdir(), `sidecar-fork-${safe}-${Date.now()}.diff`);
  await fs.promises.writeFile(file, content, 'utf-8');
  return Uri.file(file);
}

/**
 * Production UI adapter for the review flow. `extension.ts` wires
 * this into the `/fork` command (chunk 6); tests substitute their own.
 */
export function createDefaultForkReviewUi(): ForkReviewUi {
  return {
    async showQuickPick(items, placeholder) {
      return window.showQuickPick(items, { placeHolder: placeholder });
    },
    async showWarningConfirm(message, confirmLabel) {
      return window.showWarningMessage(message, { modal: true }, confirmLabel);
    },
    showInfo(message) {
      void window.showInformationMessage(message);
    },
    showError(message) {
      void window.showErrorMessage(message);
    },
    async openDiff(left, right, title) {
      await commands.executeCommand('vscode.diff', left, right, title, { preview: true });
    },
  };
}
