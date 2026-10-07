import * as path from 'path';
import type { Uri } from 'vscode';
import { isSensitiveFile, realWorkspaceRelative } from '../agent/tools/shared.js';
import { loadSidecarIgnore, isSidecarIgnored } from './sidecarIgnore.js';

/**
 * Whether a file may go into the prompt as context, by its absolute path.
 *
 * Every source of context must apply the same rules read_file does, or it
 * becomes a way around them: the file must really be inside the workspace (a
 * link out of it does not count), must not be a credential file under any
 * name, and must not be excluded by .sidecarignore. Documentation retrieval,
 * the chunk retriever and the no-index fallback each used to scan files with
 * their own fixed excludes and none of these checks.
 */
export type ContextFileFilter = (fsPath: string) => boolean;

export async function loadContextFileFilter(rootUri: Uri): Promise<ContextFileFilter> {
  const ignore = await loadSidecarIgnore(rootUri);
  const rootPath = rootUri.fsPath;
  return (fsPath: string) => {
    const rel = path.relative(rootPath, fsPath);
    if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
    const relKey = rel.split(path.sep).join('/');
    const real = realWorkspaceRelative(rootPath, rel);
    if (real === null) return false;
    if (isSensitiveFile(relKey) || isSensitiveFile(real)) return false;
    return !isSidecarIgnored(relKey, ignore) && !isSidecarIgnored(real, ignore);
  };
}
