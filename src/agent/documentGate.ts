import { workspace } from 'vscode';

/**
 * Check if any of the target file paths are currently open and have unsaved changes.
 * Used by the scheduler to detect if a scheduled task would overwrite dirty edits.
 *
 * @param filePaths Relative or absolute file paths to check (preferably absolute)
 * @returns Object with `dirty` (boolean) and `dirtyFiles` (list of paths that are dirty)
 */
export function checkDocumentGate(filePaths: string[]): { dirty: boolean; dirtyFiles: string[] } {
  if (filePaths.length === 0) {
    return { dirty: false, dirtyFiles: [] };
  }

  const dirtyFiles: string[] = [];

  for (const openDoc of workspace.textDocuments) {
    const openPath = openDoc.uri.fsPath;

    // Check if this open document matches any of the target file paths
    for (const targetPath of filePaths) {
      // Normalize both paths for comparison (handle different separators, etc.)
      const targetNorm = targetPath.replace(/\\/g, '/');
      const openNorm = openPath.replace(/\\/g, '/');

      if (
        targetNorm === openNorm ||
        targetNorm === openNorm.split('/').pop() ||
        openNorm === targetNorm.split('/').pop()
      ) {
        if (openDoc.isDirty) {
          dirtyFiles.push(targetPath);
        }
        break;
      }
    }
  }

  return {
    dirty: dirtyFiles.length > 0,
    dirtyFiles,
  };
}
