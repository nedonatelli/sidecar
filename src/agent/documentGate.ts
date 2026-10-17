import * as path from 'path';
import { workspace } from 'vscode';

/**
 * Check if any of the target file paths are currently open and have unsaved changes.
 * Used by the scheduler to detect if a scheduled task would overwrite dirty edits.
 *
 * @param filePaths Relative or absolute file paths to check (preferably absolute)
 * @param platform Whose path rules to apply; a parameter so each platform's
 *   case rules are tested on every machine, not only on that platform.
 * @returns Object with `dirty` (boolean) and `dirtyFiles` (list of paths that are dirty)
 */
export function checkDocumentGate(
  filePaths: string[],
  platform: NodeJS.Platform = process.platform,
): { dirty: boolean; dirtyFiles: string[] } {
  if (filePaths.length === 0) {
    return { dirty: false, dirtyFiles: [] };
  }

  // Compare full, absolute paths (#115). Targets are usually relative to the
  // workspace (`src/a.ts`) and open documents are absolute, so a target with a
  // directory never matched, and a drive letter's case (`C:` vs `c:`) failed
  // an exact match. A bare file name still matches any open file of that name:
  // this gate protects unsaved edits, so matching too much costs a sandbox
  // run and matching too little costs the user's work.
  const root = workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  const caseInsensitive = platform === 'win32' || platform === 'darwin';
  const fold = (p: string): string => (caseInsensitive ? p.toLowerCase() : p);
  const key = (p: string): string => fold(path.resolve(root, p).replace(/\\/g, '/'));
  const isBareName = (p: string): boolean => !/[\\/]/.test(p);
  const dirtyFiles: string[] = [];
  for (const openDoc of workspace.textDocuments) {
    if (!openDoc.isDirty) continue;
    const openKey = key(openDoc.uri.fsPath);
    const openName = openKey.slice(openKey.lastIndexOf('/') + 1);
    for (const target of filePaths) {
      const hit = isBareName(target) ? fold(target) === openName : key(target) === openKey;
      if (hit && !dirtyFiles.includes(target)) dirtyFiles.push(target);
    }
  }

  return {
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
  };
}
