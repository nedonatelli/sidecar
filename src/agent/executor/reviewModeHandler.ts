import { workspace, Uri } from 'vscode';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';
import type { PendingEditStore } from '../pendingEdits.js';
import type { AgentLogger } from '../logger.js';

/**
 * Tools whose disk output needs augmenting with the pending-edit
 * shadow store in review mode. `read_file` / `write_file` / `edit_file`
 * are already handled upstream by `handleReviewModeTool`; these three
 * run on disk and get a post-process overlay so the agent sees a
 * consistent workspace view across all its retrieval paths.
 */
export const REVIEW_OVERLAY_TOOLS = new Set(['grep', 'search_files', 'list_directory']);

/**
 * Review-mode interception. Returns a tool result when the tool is one we
 * should redirect into the shadow store (read_file / write_file / edit_file),
 * or `null` to signal "let the normal executor handle this."
 *
 * Reads return pending content when available so the agent sees a coherent
 * view of its own edits. Writes / edits capture the proposed result into
 * the store without touching disk. The revert baseline is locked on the
 * first capture for a given file; subsequent edits update only the
 * post-content so the user ultimately sees one before/after pair per file.
 */
export async function handleReviewModeTool(
  toolUse: ToolUseContentBlock,
  pendingEdits: PendingEditStore,
  logger?: AgentLogger,
): Promise<ToolResultContentBlock | null> {
  const root = workspace.workspaceFolders?.[0]?.uri;
  if (!root) return null;

  // --- read_file: prefer pending content when present ---
  if (toolUse.name === 'read_file') {
    const relPath = toolUse.input.path as string | undefined;
    if (!relPath) return null;
    const absPath = Uri.joinPath(root, relPath).fsPath;
    const pending = pendingEdits.get(absPath);
    if (pending) {
      logger?.info(`[REVIEW] Served pending content for read_file ${relPath}`);
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: pending.newContent,
      };
    }
    return null; // fall through to disk read
  }

  // --- write_file: queue the full new content ---
  if (toolUse.name === 'write_file') {
    const relPath = toolUse.input.path as string | undefined;
    const content = toolUse.input.content as string | undefined;
    if (!relPath || content === undefined) return null;
    const absPath = Uri.joinPath(root, relPath).fsPath;
    const diskBaseline = await readDiskOrNull(root, relPath);
    pendingEdits.record(absPath, diskBaseline, content, 'write_file');
    logger?.info(`[REVIEW] Captured write_file for ${relPath} (${content.length} bytes pending)`);
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Pending write queued for review: ${relPath}`,
    };
  }

  // --- edit_file: apply search/replace against the pending or disk version ---
  if (toolUse.name === 'edit_file') {
    const relPath = toolUse.input.path as string | undefined;
    const search = toolUse.input.search as string | undefined;
    const replace = toolUse.input.replace as string | undefined;
    if (!relPath || search === undefined || replace === undefined) return null;
    const absPath = Uri.joinPath(root, relPath).fsPath;
    const existing = pendingEdits.get(absPath);
    // Build the base text we're editing — pending version if we've already
    // queued changes to this file this session, otherwise the disk version.
    const base = existing ? existing.newContent : await readDiskOrNull(root, relPath);
    if (base === null) {
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error: cannot edit ${relPath} — file does not exist`,
        is_error: true,
      };
    }
    if (!base.includes(search)) {
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Error: Search text not found in ${relPath}`,
        is_error: true,
      };
    }
    const newContent = base.replace(search, replace);
    // Pass the disk baseline only if this is the first capture — record()
    // ignores the baseline on subsequent updates so we can safely pass null.
    const baselineForRecord = existing ? null : base;
    pendingEdits.record(absPath, baselineForRecord, newContent, 'edit_file');
    logger?.info(`[REVIEW] Captured edit_file for ${relPath}`);
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Pending edit queued for review: ${relPath}`,
    };
  }

  return null;
}

/**
 * Compute the review-mode overlay for a search-style tool. Returns a
 * formatted string to append to the tool result, or an empty string
 * if there's nothing to add.
 *
 * - `grep`: re-run the pattern against pending file contents; include
 *   any match not already in the disk-based result.
 * - `search_files`: run the glob against every pending file path;
 *   include matches that exist only in the pending store (new files)
 *   or that the disk scan would miss.
 * - `list_directory`: add any pending file whose parent directory
 *   matches the requested path.
 *
 * The overlay is always preceded by a `⚠ Pending edits` banner so the
 * model can tell disk-world from shadow-store entries at a glance.
 */
export function computePendingOverlay(toolUse: ToolUseContentBlock, pendingEdits: PendingEditStore): string {
  const all = pendingEdits.getAll();
  if (all.length === 0) return '';

  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return '';

  const toRel = (abs: string): string => {
    const prefix = root.endsWith('/') || root.endsWith('\\') ? root : root + '/';
    return abs.startsWith(prefix) ? abs.slice(prefix.length).replace(/\\/g, '/') : abs.replace(/\\/g, '/');
  };

  if (toolUse.name === 'grep') {
    const pattern = (toolUse.input.pattern as string) || '';
    const scopePath = (toolUse.input.path as string | undefined)?.replace(/\\/g, '/');
    if (!pattern) return '';
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      // Pattern wasn't a valid regex — treat it as a literal substring
      // the same way the default grep path does.
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    }
    const hits: string[] = [];
    for (const edit of all) {
      const rel = toRel(edit.filePath);
      if (scopePath && !rel.startsWith(scopePath)) continue;
      const lines = edit.newContent.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          if (hits.length >= 50) break;
        }
      }
      if (hits.length >= 50) break;
    }
    if (hits.length === 0) return '';
    return (
      `\n\n⚠ Pending edits (review mode) — the agent has queued changes to these files this session. ` +
      `Results below are from the pending (in-memory) version, not disk:\n` +
      hits.map((h) => `  ${h}`).join('\n')
    );
  }

  if (toolUse.name === 'search_files') {
    const patternInput = (toolUse.input.pattern as string) || '';
    if (!patternInput) return '';
    // Convert the glob to a regex the same way VS Code's glob matcher
    // approximates it. Good-enough for review-mode annotation.
    const regexStr = patternInput
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '§§')
      .replace(/\*/g, '[^/]*')
      .replace(/§§/g, '.*')
      .replace(/\?/g, '[^/]');
    const re = new RegExp('^' + regexStr + '$');
    const hits: string[] = [];
    for (const edit of all) {
      const rel = toRel(edit.filePath);
      if (re.test(rel)) {
        const tag = edit.originalContent === null ? ' (pending new file)' : ' (pending edit)';
        hits.push(rel + tag);
      }
    }
    if (hits.length === 0) return '';
    return (
      `\n\n⚠ Pending edits matching this glob — review mode has queued changes to these files. ` +
      `Disk-based search_files above may not reflect them:\n` +
      hits.map((h) => `  ${h}`).join('\n')
    );
  }

  if (toolUse.name === 'list_directory') {
    const requested = ((toolUse.input.path as string | undefined) || '').replace(/\\/g, '/').replace(/\/$/, '');
    const scope = requested === '' || requested === '.' ? '' : requested + '/';
    const hits: string[] = [];
    for (const edit of all) {
      const rel = toRel(edit.filePath);
      if (scope && !rel.startsWith(scope)) continue;
      // Only include files that are direct children of the requested dir,
      // not arbitrary descendants — matches list_directory's disk semantics.
      const afterScope = scope ? rel.slice(scope.length) : rel;
      if (afterScope.includes('/')) continue;
      const tag = edit.originalContent === null ? ' (pending new file)' : ' (pending edit)';
      hits.push(afterScope + tag);
    }
    if (hits.length === 0) return '';
    return (
      `\n\n⚠ Pending edits in this directory — review mode has queued changes that the disk listing above doesn't reflect:\n` +
      hits.map((h) => `  ${h}`).join('\n')
    );
  }

  return '';
}

async function readDiskOrNull(root: Uri, relPath: string): Promise<string | null> {
  try {
    const bytes = await workspace.fs.readFile(Uri.joinPath(root, relPath));
    return Buffer.from(bytes).toString('utf-8');
  } catch {
    return null;
  }
}
