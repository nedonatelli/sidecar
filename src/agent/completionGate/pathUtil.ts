import { workspace } from 'vscode';
import * as path from 'path';

/** Source files we care about verifying. Non-matching files are skipped. */
export const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/;

/** Test file convention — these don't need their own tests. */
export const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/;

/**
 * Normalize a file path to workspace-relative forward-slashed form.
 * Returns null if the path is outside the workspace or can't be resolved.
 */
export function normalizePath(p: string | undefined | null): string | null {
  if (!p) return null;
  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    // Fall back to forward-slash-only in test environments without a workspace.
    return p.split(path.sep).join('/');
  }
  const abs = path.isAbsolute(p) ? p : path.resolve(root, p);
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return rel.split(path.sep).join('/');
}

