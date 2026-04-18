import { window, commands, workspace, Uri } from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { GitCLI } from '../../github/git.js';
import type { FacetDispatchBatchResult, FacetDispatchResult } from './facetDispatcher.js';

// ---------------------------------------------------------------------------
// Facet batch review (v0.66 chunk 3.6).
//
// After `dispatchFacets` completes with `deferPrompt: true`, every
// facet carries a `pendingDiff` in its `sandbox` field instead of
// having prompted the user mid-run. This module turns that batch into
// a single review surface:
//
//   1. Build an apply plan: parse per-facet diffs for the files they
//      touch; detect cross-facet overlap (two facets editing the same
//      file is a conflict — the second one sees a dirty tree).
//   2. Drive a quickpick UI that lets the user Accept / Reject / Diff
//      one facet at a time. Accepted facets are queued for apply in
//      the order they were chosen.
//   3. After the review loop exits, apply queued diffs to main in
//      order using `git apply`. Conflicts during apply surface as
//      per-facet errors and stop subsequent applies to that same
//      path — the rest of the queue continues.
//
// The pure planner + per-step handlers live here; `extension.ts` and
// `facetCommands.ts` thread in the real VS Code surface. Tests inject
// a `FacetReviewUi` shim so they don't need `window.*`.
// ---------------------------------------------------------------------------

export interface FacetReviewableResult {
  readonly facetId: string;
  readonly displayName?: string;
  readonly pendingDiff: string;
  readonly shadowId?: string;
}

export interface FacetApplyPlanEntry {
  readonly facetId: string;
  readonly displayName: string;
  readonly pendingDiff: string;
  readonly files: readonly string[];
  /**
   * Other facetIds in the batch that also touch at least one file in
   * `files`. Surfaced to the user so they understand the apply-order
   * risk. Does NOT prevent apply; the planner is advisory.
   */
  readonly overlapsWith: readonly string[];
}

export interface FacetReviewPlan {
  readonly entries: readonly FacetApplyPlanEntry[];
  /** Facets that returned no pendingDiff (empty-diff, failed run, direct mode). */
  readonly skipped: readonly { facetId: string; reason: string }[];
}

/**
 * Parse a unified diff and extract every file path the patch modifies.
 * Uses the `diff --git a/<path> b/<path>` header so renames surface both
 * names; we dedupe before returning. Non-git patches (raw `--- /+++`)
 * are handled as a fallback. Returned paths are relative to the repo
 * root — `a/` / `b/` prefixes are stripped.
 */
export function filesTouchedByDiff(diff: string): string[] {
  const touched = new Set<string>();
  const gitHeaderRe = /^diff --git a\/(\S+) b\/(\S+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = gitHeaderRe.exec(diff)) !== null) {
    touched.add(match[1]);
    touched.add(match[2]);
  }
  if (touched.size === 0) {
    const fallbackRe = /^\+\+\+ (?:b\/)?(\S+)$/gm;
    while ((match = fallbackRe.exec(diff)) !== null) {
      if (match[1] !== '/dev/null') touched.add(match[1]);
    }
  }
  return [...touched];
}

/**
 * Build a review plan from a batch result. Facets without a
 * `pendingDiff` (failed / empty-diff / non-shadow mode) are collected
 * into `skipped` with a reason string; the user sees them in the
 * picker header so nothing is silently dropped.
 */
export function planFacetReview(batch: FacetDispatchBatchResult): FacetReviewPlan {
  const reviewable: Array<{ result: FacetDispatchResult; files: string[] }> = [];
  const skipped: Array<{ facetId: string; reason: string }> = [];

  for (const r of batch.results) {
    const diff = r.sandbox.pendingDiff;
    if (diff && diff.length > 0) {
      reviewable.push({ result: r, files: filesTouchedByDiff(diff) });
    } else if (!r.success) {
      skipped.push({ facetId: r.facetId, reason: r.errorMessage ?? 'failed' });
    } else {
      skipped.push({ facetId: r.facetId, reason: r.sandbox.reason ?? 'no-diff' });
    }
  }

  const entries: FacetApplyPlanEntry[] = reviewable.map(({ result, files }) => {
    const overlapsWith = reviewable
      .filter((other) => other.result.facetId !== result.facetId)
      .filter((other) => other.files.some((f) => files.includes(f)))
      .map((other) => other.result.facetId);
    return {
      facetId: result.facetId,
      displayName: result.facetId,
      pendingDiff: result.sandbox.pendingDiff ?? '',
      files,
      overlapsWith,
    };
  });

  return { entries, skipped };
}

// ---------------------------------------------------------------------------
// Review UI
// ---------------------------------------------------------------------------

export interface FacetReviewUi {
  showQuickPick<T extends { label: string }>(items: T[], placeholder: string): Promise<T | undefined>;
  showInfo(message: string): void;
  showError(message: string): void;
  /** Open VS Code's diff editor — compares `left` vs `right` at `title`. */
  openDiff(left: Uri, right: Uri, title: string): Promise<void>;
}

export interface FacetReviewDeps {
  readonly ui: FacetReviewUi;
  /** Absolute path of the main working tree for `git apply`. */
  readonly mainRoot: string;
  /**
   * Overrideable applier. Production wiring calls `GitCLI.applyPatch`;
   * tests inject a spy. Returns the `git apply` stdout on success,
   * throws on conflict.
   */
  readonly applyDiff?: (mainRoot: string, diff: string) => Promise<string>;
  /**
   * Hook for writing temp scratch files for the diff viewer. Tests
   * inject a no-op; production writes to `os.tmpdir()`.
   */
  readonly writeTempFile?: (prefix: string, content: string) => Promise<Uri>;
}

export interface FacetReviewOutcome {
  readonly applied: readonly string[];
  readonly rejected: readonly string[];
  readonly failed: readonly { facetId: string; error: string }[];
  readonly cancelledRemaining: readonly string[];
}

/**
 * Drive the batch review loop. Exits either when the user dismisses
 * the picker (remaining facets go to `cancelledRemaining`) or when
 * every entry has been accept/rejected.
 */
export async function reviewFacetBatch(
  batch: FacetDispatchBatchResult,
  deps: FacetReviewDeps,
): Promise<FacetReviewOutcome> {
  const plan = planFacetReview(batch);
  if (plan.entries.length === 0) {
    const msg =
      plan.skipped.length === 0
        ? 'No facet diffs to review.'
        : `No facet diffs to review (${plan.skipped.length} skipped).`;
    deps.ui.showInfo(msg);
    return { applied: [], rejected: [], failed: [], cancelledRemaining: [] };
  }

  const applyDiff = deps.applyDiff ?? defaultApplyDiff;
  const writeTempFile = deps.writeTempFile ?? defaultWriteTempFile;

  const pending = new Map(plan.entries.map((e) => [e.facetId, e]));
  const applied: string[] = [];
  const rejected: string[] = [];
  const failed: Array<{ facetId: string; error: string }> = [];

  while (pending.size > 0) {
    const items = [...pending.values()].map(entryToPickItem);
    const picked = await deps.ui.showQuickPick(
      items,
      `${pending.size} facet${pending.size === 1 ? '' : 's'} awaiting review`,
    );
    if (!picked) break;

    const entry = pending.get(picked.facetId);
    if (!entry) {
      // Picker item got out of sync with pending — defensive.
      continue;
    }

    const action = await promptFacetAction(deps.ui, entry, writeTempFile);
    if (action === 'cancel') break;
    if (action === 'skip') {
      // No-op: leave the entry in pending so the user can come back.
      continue;
    }
    if (action === 'reject') {
      rejected.push(entry.facetId);
      pending.delete(entry.facetId);
      continue;
    }
    // Accept: apply the diff onto main.
    try {
      await applyDiff(deps.mainRoot, entry.pendingDiff);
      applied.push(entry.facetId);
      deps.ui.showInfo(`Applied facet "${entry.facetId}" (${entry.files.length} file(s)).`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ facetId: entry.facetId, error: message });
      deps.ui.showError(`Facet "${entry.facetId}" failed to apply: ${message}`);
    }
    pending.delete(entry.facetId);
  }

  const cancelledRemaining = [...pending.keys()];
  if (cancelledRemaining.length > 0) {
    deps.ui.showInfo(`Review dismissed — ${cancelledRemaining.length} facet(s) left unreviewed.`);
  }

  return { applied, rejected, failed, cancelledRemaining };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FacetPickItem {
  label: string;
  description?: string;
  detail?: string;
  facetId: string;
}

function entryToPickItem(entry: FacetApplyPlanEntry): FacetPickItem {
  const conflictTag = entry.overlapsWith.length > 0 ? ` · overlaps: ${entry.overlapsWith.join(', ')}` : '';
  return {
    label: `$(git-commit) ${entry.displayName}`,
    description: `${entry.files.length} file(s)${conflictTag}`,
    detail: entry.files.slice(0, 4).join(' · ') + (entry.files.length > 4 ? ' …' : ''),
    facetId: entry.facetId,
  };
}

async function promptFacetAction(
  ui: FacetReviewUi,
  entry: FacetApplyPlanEntry,
  writeTempFile: NonNullable<FacetReviewDeps['writeTempFile']>,
): Promise<'accept' | 'reject' | 'skip' | 'cancel'> {
  const choice = await ui.showQuickPick(
    [
      { label: '$(check) Accept — apply diff to main', action: 'accept' as const },
      { label: '$(diff) Show diff', action: 'diff' as const },
      { label: '$(close) Reject — drop this facet', action: 'reject' as const },
      { label: '$(history) Skip for now — decide later', action: 'skip' as const },
    ],
    `Facet "${entry.facetId}" — what to do?`,
  );
  if (!choice) return 'cancel';
  if (choice.action === 'diff') {
    const left = await writeTempFile(`${entry.facetId}-before`, '');
    const right = await writeTempFile(`${entry.facetId}-patch`, entry.pendingDiff);
    await ui.openDiff(left, right, `Facet "${entry.facetId}" — patch`);
    // Re-prompt after viewing: the user still has to decide.
    return promptFacetAction(ui, entry, writeTempFile);
  }
  return choice.action;
}

async function defaultApplyDiff(mainRoot: string, diff: string): Promise<string> {
  const git = new GitCLI(mainRoot);
  await git.applyPatch(diff, { check: true });
  return git.applyPatch(diff, { stage: true });
}

async function defaultWriteTempFile(prefix: string, content: string): Promise<Uri> {
  const safe = prefix.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(os.tmpdir(), `sidecar-facet-${safe}-${Date.now()}.diff`);
  await fs.promises.writeFile(file, content, 'utf-8');
  return Uri.file(file);
}

export function createDefaultFacetReviewUi(): FacetReviewUi {
  return {
    async showQuickPick(items, placeholder) {
      return window.showQuickPick(items, { placeHolder: placeholder });
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

export function getWorkspaceMainRoot(): string | undefined {
  return workspace.workspaceFolders?.[0]?.uri.fsPath;
}
