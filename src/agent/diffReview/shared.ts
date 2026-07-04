import { window, workspace, commands, Uri } from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { GitCLI } from '../../github/git.js';
import type { AgentCallbacks } from '../loop.js';

// ---------------------------------------------------------------------------
// Shared diff-review primitives used by both the Fork (single-winner) and
// Facets (multi-select) batch-review flows. These two flows have genuinely
// different review *semantics*, but the mechanics of applying a diff to the
// main tree, extracting touched files, staging temp diff files, and the base
// VS Code UI adapter are identical — consolidated here so the
// security-sensitive "apply patch to main" path has a single source of truth.
// ---------------------------------------------------------------------------

/**
 * Files touched by a unified diff. Uses the `diff --git a/<p> b/<p>` header so
 * renames surface both names; dedupes before returning. Non-git patches (raw
 * `--- / +++`) fall back to the `+++` lines. Returned paths are repo-relative
 * with `a/` / `b/` prefixes stripped.
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
 * Apply a unified diff to the main working tree, staged. Checks the patch
 * applies cleanly first (throws if not), then applies + stages it.
 */
export async function applyDiffToMain(mainRoot: string, diff: string): Promise<string> {
  const git = new GitCLI(mainRoot);
  await git.applyPatch(diff, { check: true });
  return git.applyPatch(diff, { stage: true });
}

/**
 * Write `content` to a uniquely-named temp `.diff` file and return its Uri.
 * `infix` distinguishes the calling subsystem (e.g. `fork` / `facet`);
 * `label` is sanitized into the filename.
 */
export async function writeTempDiffFile(infix: string, label: string, content: string): Promise<Uri> {
  const safe = label.replace(/[^a-zA-Z0-9_-]/g, '_');
  const file = path.join(os.tmpdir(), `sidecar-${infix}-${safe}-${Date.now()}.diff`);
  await fs.promises.writeFile(file, content, 'utf-8');
  return Uri.file(file);
}

/**
 * Resolve the workspace root used as the `git apply` target. Returns undefined
 * when no workspace is open — callers should skip review (nowhere to apply to).
 */
export function getWorkspaceMainRoot(): string | undefined {
  return workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/** The VS Code UI methods shared by every batch-review adapter. */
export interface BaseReviewUi {
  showQuickPick<T extends { label: string }>(items: T[], placeholder: string): Promise<T | undefined>;
  showInfo(message: string): void;
  showError(message: string): void;
  /** Open VS Code's diff editor — compares `left` vs `right` at `title`. */
  openDiff(left: Uri, right: Uri, title: string): Promise<void>;
}

/** Production adapter for the {@link BaseReviewUi} methods, backed by `window`/`commands`. */
export function createBaseReviewUi(): BaseReviewUi {
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

/**
 * No-op agent callbacks for batch dispatch (Fork / Facets / Arena), where each
 * run's streaming output is captured per-lane rather than surfaced live in chat.
 */
export function silentCallbacks(): AgentCallbacks {
  return {
    onText: () => undefined,
    onToolCall: () => undefined,
    onToolResult: () => undefined,
    onDone: () => undefined,
  };
}
