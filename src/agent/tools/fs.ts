import { workspace, Uri } from 'vscode';
import * as path from 'path';
import type { ToolDefinition } from '../../ollama/types.js';
import {
  validateFilePath,
  isSensitiveFile,
  isProtectedWritePath,
  resolveRootUri,
  type ToolExecutorContext,
  type RegisteredTool,
} from './shared.js';
import { compactSourceFile, outlineSourceFile } from './compression.js';
import { getDefaultAuditBuffer } from '../audit/auditBuffer.js';
import { isAuditModeActive } from './auditHelper.js';
import { getAuditDecorationProvider } from '../../testing/auditDecorations.js';
import { computeLineDiff } from './diffUtils.js';

/**
 * Read buffered content for a workspace-relative path if Audit Mode
 * has it. Returns undefined to mean "fall through to real disk" — the
 * deleted case (buffer marked-for-delete) is surfaced explicitly so
 * the caller can emit a "file not found" response for the agent.
 */
async function readDiskViaWorkspace(
  context: ToolExecutorContext | undefined,
  relPath: string,
): Promise<string | undefined> {
  try {
    const fileUri = Uri.joinPath(resolveRootUri(context), relPath);
    const bytes = await workspace.fs.readFile(fileUri);
    return Buffer.from(bytes).toString('utf-8');
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Streaming diff helpers
// ---------------------------------------------------------------------------

const DIFF_PREFIX = '\x00diff\x00';

// ---------------------------------------------------------------------------
// Filesystem tools: read_file / write_file / edit_file / list_directory.
// All four route through VS Code's workspace.fs (rather than node:fs) so
// that virtual filesystems, remote workspaces, and the workspace trust
// layer behave correctly.

export const readFileDef: ToolDefinition = {
  name: 'read_file',
  description:
    'Read the contents of a file at the given relative path. ' +
    'Use when you already know the filename and need to see its current contents before editing or analyzing it. ' +
    'Not for searching file contents — use `grep` for text matches, `search_files` for glob filename matches, or `list_directory` to explore a folder first. ' +
    'Binary files (images, PDFs, compiled artifacts) return unreadable output; prefer `list_directory` to confirm the file type first. ' +
    'Modes: `full` (default) returns the raw file. `compact` strips block comments, full-line // and # comments, trailing whitespace, and runs of blank lines — use it when reading a large file just to understand what it does, before editing. `outline` returns only top-level signatures (imports, classes, functions, types) — use it for a high-level map of a large file you do NOT plan to edit. ' +
    'If you plan to call `edit_file` after reading, use `full` mode — the `search` argument has to match the file verbatim, and compact/outline strip text that might be inside your search string. ' +
    'Example: `read_file(path="src/utils.ts")` for full contents, `read_file(path="src/large.ts", mode="compact")` for a leaner read.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path from the project root' },
      mode: {
        type: 'string',
        enum: ['full', 'compact', 'outline'],
        description:
          'Output mode. `full` (default) returns raw file contents. `compact` strips comments and blank-line runs. `outline` returns signatures only.',
      },
    },
    required: ['path'],
  },
  nondeterministicOutput: true,
};

export const writeFileDef: ToolDefinition = {
  name: 'write_file',
  description:
    'Create a new file, or overwrite an existing file completely, with the given content. ' +
    'Use when creating a brand-new file or when replacing >50% of an existing file. ' +
    'Not for surgical changes to an existing file — use `edit_file` for small targeted edits, which is safer because it leaves the rest of the file untouched and reviewable. ' +
    '**Overwrites existing content silently** — call `read_file` first if there is any chance the file already exists and you need to preserve parts of it. ' +
    'Example: `write_file(path="src/hello.ts", content="export const hello = () => \'hi\';")`.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path from the project root' },
      content: { type: 'string', description: 'Full file content to write' },
    },
    required: ['path', 'content'],
  },
};

export const editFileDef: ToolDefinition = {
  name: 'edit_file',
  description:
    'Edit an existing file by replacing an exact search string with a replacement. ' +
    'Use for surgical changes — renaming a function, updating a single line, adding an import. ' +
    'Not for creating a file or doing a full rewrite — use `write_file` for those. ' +
    'Not for multi-location changes in one call — call `edit_file` once per location, each with a unique search string. ' +
    'The `search` argument must match exactly one location in the file; if it appears multiple times the call returns an error — add more surrounding lines to make it unique. ' +
    'Match is byte-exact: whitespace, indentation, and trailing spaces must match the file verbatim. When in doubt, call `read_file` first and copy-paste the target text directly into `search`. ' +
    'Example: `edit_file(path="src/utils.ts", search="function greet(name: string)", replace="function greet(name: string, greeting = \'Hello\')")`.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path from the project root' },
      search: {
        type: 'string',
        description:
          'Exact text to find in the file — whitespace and indentation must match the file byte-for-byte. Must appear exactly once; if it appears multiple times the call returns an error. Include enough surrounding lines to guarantee uniqueness.',
      },
      replace: {
        type: 'string',
        description:
          'New text to substitute for the search match. Must differ from search — if they are identical the call returns an error. ' +
          'If the replacement is very short and appears verbatim inside the search string, the call succeeds but appends a warning; call read_file to verify the result.',
      },
    },
    required: ['path', 'search', 'replace'],
  },
};

export const deleteFileDef: ToolDefinition = {
  name: 'delete_file',
  description:
    'Permanently delete a file at the given relative path. ' +
    'Use when the user explicitly asks you to remove or delete a file, or when a refactor requires removing a deprecated module. ' +
    'Not for emptying a file — use `write_file` with empty content if you want to keep the file but clear it. ' +
    'Not for deleting directories — this tool only removes individual files. ' +
    'Example: `delete_file(path="src/legacy.ts")`.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path from the project root' },
    },
    required: ['path'],
  },
};

export const listDirectoryDef: ToolDefinition = {
  name: 'list_directory',
  description:
    'List the files and folders in a directory, one entry per line with type markers. ' +
    'Use when orienting yourself in an unfamiliar project, or when you need to confirm a file exists before reading it. ' +
    'Not for finding files by pattern (use `search_files` for globs like `**/*.test.ts`) or for searching contents (use `grep`). ' +
    'Empty path or `.` lists the project root. ' +
    'Example: `list_directory(path="src/agent")`.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Relative directory path from the project root (empty or "." for project root)',
      },
    },
    required: [],
  },
};

export async function readFile(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const filePath = input.path as string;
  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;
  if (isSensitiveFile(filePath)) {
    return `Warning: "${filePath}" appears to contain secrets or credentials. Reading this file would send its contents to the LLM provider. Use read_file on a non-sensitive file instead, or ask the user to provide the needed information directly.`;
  }
  const mode = input.mode as string | undefined;

  // Audit Mode read-through: if the agent previously wrote this file
  // during the same session, return the buffered content rather than
  // the stale disk contents. Keeps multi-step edits stacking correctly.
  if (isAuditModeActive(context)) {
    const bufState = getDefaultAuditBuffer().read(filePath);
    if (bufState.buffered) {
      if (bufState.deleted) {
        return `Error: File not found (${filePath}) — deleted in Audit Buffer pending review.`;
      }
      const text = bufState.content ?? '';
      if (mode === 'compact') return compactSourceFile(text);
      if (mode === 'outline') return outlineSourceFile(text);
      return text;
    }
    // Not buffered — fall through to real disk.
  }

  // resolveRootUri consults `context.cwd` first so ShadowWorkspace-pinned
  // reads see the shadow's state (including the agent's own in-progress
  // writes) instead of main-tree content.
  const fileUri = Uri.joinPath(resolveRootUri(context), filePath);
  let bytes: Uint8Array;
  try {
    bytes = await workspace.fs.readFile(fileUri);
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error && (err.message.includes('ENOENT') || (err as { code?: string }).code === 'FileNotFound');
    if (!isNotFound) throw err;

    // Suggest similarly-named files so the model can self-correct without
    // needing a separate list_directory call.
    const basename = path.posix.basename(filePath);
    const similar = await workspace.findFiles(`**/${basename}`, '**/node_modules/**', 5);
    if (similar.length > 0) {
      const suggestions = similar.map((u) => workspace.asRelativePath(u, false)).join('\n  - ');
      return `Error: File not found: ${filePath}\nDid you mean one of these?\n  - ${suggestions}\nUse list_directory to explore the directory structure if none match.`;
    }
    return `Error: File not found: ${filePath}\nNo file named "${basename}" exists in the workspace. Use list_directory or search_files to find the correct path.`;
  }
  const text = Buffer.from(bytes).toString('utf-8');
  if (mode === 'compact') return compactSourceFile(text);
  if (mode === 'outline') return outlineSourceFile(text);
  return text;
}

export async function writeFile(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const filePath = input.path as string;
  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;
  const protectedError = isProtectedWritePath(filePath);
  if (protectedError) return protectedError;
  if (isSensitiveFile(filePath)) {
    return `Error: "${filePath}" appears to contain secrets or credentials. The agent is not permitted to write to this file.`;
  }
  const content = input.content as string;

  // Audit Mode: divert the write to the in-memory buffer instead of
  // touching disk. The agent sees a normal success response and keeps
  // working against the buffered state; user reviews later and either
  // flushes (applies every buffered change atomically) or rejects.
  if (isAuditModeActive(context)) {
    await getDefaultAuditBuffer().write(filePath, content, (p) => readDiskViaWorkspace(context, p));
    getAuditDecorationProvider()?.refresh();
    return `File written: ${filePath} (buffered for audit review)`;
  }

  const rootUri = resolveRootUri(context);
  const fileUri = Uri.joinPath(rootUri, filePath);
  // Create parent directories in the same root the file write targets.
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') {
    await workspace.fs.createDirectory(Uri.joinPath(rootUri, dir));
  }

  // Read original once for both edit timeline and streaming diff.
  // Skip when cwd is set (shadow workspace — sandbox has its own review flow).
  const needsOriginal = (context?.editTimeline && !context.cwd) || !!context?.onOutput;
  const original = needsOriginal ? await readDiskViaWorkspace(context, filePath) : undefined;

  if (context?.editTimeline && !context.cwd) {
    context.editTimeline.record(filePath, original, content);
  }

  await workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));

  if (context?.onOutput) {
    const patch = computeLineDiff(original ?? '', content, filePath);
    if (patch) context.onOutput(DIFF_PREFIX + patch);
  }

  return `File written: ${filePath}`;
}

export async function editFile(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const filePath = input.path as string;
  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;
  const protectedError = isProtectedWritePath(filePath);
  if (protectedError) return protectedError;
  if (isSensitiveFile(filePath)) {
    return `Error: "${filePath}" appears to contain secrets or credentials. The agent is not permitted to edit this file.`;
  }
  const search = input.search as string;
  const replace = input.replace as string;

  if (search === replace) {
    return (
      `Error: edit_file failed — search and replace text are identical; no change would be made. ` +
      `Verify your replace argument contains the corrected content, not a copy of the search text.`
    );
  }

  // If the replacement is a short substring of the search string the edit
  // will silently truncate context (e.g. replacing a full function signature
  // with just "string"). Warn so the model re-reads and self-corrects.
  const partialReplaceWarning =
    replace.length > 0 && replace.length < search.length / 2 && search.includes(replace)
      ? ` Warning: replace text (${replace.length} chars) is a substring of search text (${search.length} chars) — call read_file to verify the result is correct before continuing.`
      : '';

  // Audit Mode: read the current state (from buffer if already there,
  // else from disk), apply the substring replacement, and write the
  // result back to the buffer. The buffer's own write() method handles
  // the create-vs-modify classification + originalContent capture.
  if (isAuditModeActive(context)) {
    const buf = getDefaultAuditBuffer();
    const bufState = buf.read(filePath);
    let currentText: string;
    if (bufState.buffered) {
      if (bufState.deleted) return `Error: File not found in buffer (${filePath}) — was deleted earlier this session.`;
      // In the buffered + not-deleted branch, `content` is always a
      // string (AuditBuffer only emits `content: undefined` for the
      // deleted op), but the type system can't infer that from the
      // struct shape alone — default to empty string defensively.
      currentText = bufState.content ?? '';
    } else {
      const diskText = await readDiskViaWorkspace(context, filePath);
      if (diskText === undefined) return `Error: File not found: ${filePath}`;
      currentText = diskText;
    }
    if (!currentText.includes(search)) {
      return `Error: edit_file failed — search string not found in ${filePath}. The file was NOT modified. Call read_file to see the exact current content, then retry with a corrected search string.`;
    }
    const matchCount = currentText.split(search).length - 1;
    if (matchCount > 1) {
      return `Error: edit_file failed — search string appears ${matchCount} times in ${filePath}. The file was NOT modified. Add more surrounding context to your search string to make it unique, then retry.`;
    }
    const newText = currentText.replace(search, () => replace);
    await buf.write(filePath, newText, (p) => readDiskViaWorkspace(context, p));
    getAuditDecorationProvider()?.refresh();
    return `File edited: ${filePath} (buffered for audit review)${partialReplaceWarning}`;
  }

  const fileUri = Uri.joinPath(resolveRootUri(context), filePath);
  const bytes = await workspace.fs.readFile(fileUri);
  const text = Buffer.from(bytes).toString('utf-8');
  if (!text.includes(search)) {
    return `Error: edit_file failed — search string not found in ${filePath}. The file was NOT modified. Call read_file to see the exact current content, then retry with a corrected search string.`;
  }
  const matchCount = text.split(search).length - 1;
  if (matchCount > 1) {
    return `Error: edit_file failed — search string appears ${matchCount} times in ${filePath}. The file was NOT modified. Add more surrounding context to your search string to make it unique, then retry.`;
  }
  const newText = text.replace(search, () => replace);

  if (context?.onOutput) {
    const patch = computeLineDiff(text, newText, filePath);
    if (patch) context.onOutput(DIFF_PREFIX + patch);
  }

  // Record to edit timeline before overwriting.
  // Skip when cwd is set (shadow workspace).
  if (context?.editTimeline && !context.cwd) {
    context.editTimeline.record(filePath, text, newText);
  }

  await workspace.fs.writeFile(fileUri, Buffer.from(newText, 'utf-8'));
  return `File edited: ${filePath}${partialReplaceWarning}`;
}

export async function deleteFile(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const filePath = input.path as string;
  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;
  const protectedError = isProtectedWritePath(filePath);
  if (protectedError) return protectedError;
  if (isSensitiveFile(filePath)) {
    return `Error: "${filePath}" appears to contain secrets or credentials. The agent is not permitted to delete this file.`;
  }

  if (isAuditModeActive(context)) {
    await getDefaultAuditBuffer().deleteFile(filePath, (p) => readDiskViaWorkspace(context, p));
    getAuditDecorationProvider()?.refresh();
    return `File deleted: ${filePath} (buffered for audit review)`;
  }

  const fileUri = Uri.joinPath(resolveRootUri(context), filePath);

  if (context?.editTimeline && !context.cwd) {
    const original = await readDiskViaWorkspace(context, filePath);
    context.editTimeline.record(filePath, original, '');
  }

  await workspace.fs.delete(fileUri, { useTrash: true });
  return `File deleted: ${filePath}`;
}

export async function listDirectory(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const dirPath = (input.path as string) || '.';
  // `.` is the workspace root itself — skip validation for the empty
  // path, otherwise run the same relative-path guard every other file
  // tool uses. Cycle-2 audit: this used to accept raw paths without
  // validateFilePath, so a crafted input like `../../..` or an
  // absolute path could at least attempt a readDirectory outside
  // the workspace boundary. VS Code's fs layer enforces workspace
  // trust independently, but belt-and-suspenders is the right shape.
  if (dirPath !== '.' && dirPath !== '') {
    const pathError = validateFilePath(dirPath);
    if (pathError) return pathError;
  }
  const dirUri = Uri.joinPath(resolveRootUri(context), dirPath);
  const entries = await workspace.fs.readDirectory(dirUri);
  return entries.map(([name, type]) => `${type === 2 ? '📁 ' : '📄 '}${name}`).join('\n');
}

export const fsTools: RegisteredTool[] = [
  { definition: readFileDef, executor: readFile, requiresApproval: false },
  { definition: writeFileDef, executor: writeFile, requiresApproval: true },
  { definition: editFileDef, executor: editFile, requiresApproval: true },
  { definition: deleteFileDef, executor: deleteFile, requiresApproval: true },
  { definition: listDirectoryDef, executor: listDirectory, requiresApproval: false },
];
