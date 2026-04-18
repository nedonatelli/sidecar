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
import { getConfig } from '../../config/settings.js';
import { getDefaultAuditBuffer } from '../audit/auditBuffer.js';

/**
 * True when Audit Mode is active — writes should buffer, reads should
 * read-through the buffer for buffered paths. Checked per-call so the
 * user flipping agentMode mid-session takes effect on the next tool
 * dispatch. Returns false when no context is available or the mode
 * isn't `audit`, so tools that don't check this fall through to the
 * real-disk path unchanged.
 */
function isAuditModeActive(): boolean {
  try {
    return getConfig().agentMode === 'audit';
  } catch {
    return false;
  }
}

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
    'The `search` argument must match exactly one location in the file; include enough surrounding context to guarantee uniqueness, otherwise the tool returns an error listing the match count. ' +
    'Example: `edit_file(path="src/utils.ts", search="function greet(name: string)", replace="function greet(name: string, greeting = \'Hello\')")`.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path from the project root' },
      search: {
        type: 'string',
        description:
          'Exact text to find in the file. Must be unique — include enough surrounding context to match only one location. Only the first match is replaced; if the search text appears multiple times the call returns an error.',
      },
      replace: { type: 'string', description: 'Text to replace the search match with' },
    },
    required: ['path', 'search', 'replace'],
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
  if (isAuditModeActive()) {
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
  const bytes = await workspace.fs.readFile(fileUri);
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
  const content = input.content as string;

  // Audit Mode: divert the write to the in-memory buffer instead of
  // touching disk. The agent sees a normal success response and keeps
  // working against the buffered state; user reviews later and either
  // flushes (applies every buffered change atomically) or rejects.
  if (isAuditModeActive()) {
    await getDefaultAuditBuffer().write(filePath, content, (p) => readDiskViaWorkspace(context, p));
    return `File written: ${filePath} (buffered for audit review)`;
  }

  const rootUri = resolveRootUri(context);
  const fileUri = Uri.joinPath(rootUri, filePath);
  // Create parent directories in the same root the file write targets.
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') {
    await workspace.fs.createDirectory(Uri.joinPath(rootUri, dir));
  }
  await workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
  return `File written: ${filePath}`;
}

export async function editFile(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const filePath = input.path as string;
  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;
  const protectedError = isProtectedWritePath(filePath);
  if (protectedError) return protectedError;
  const search = input.search as string;
  const replace = input.replace as string;

  // Audit Mode: read the current state (from buffer if already there,
  // else from disk), apply the substring replacement, and write the
  // result back to the buffer. The buffer's own write() method handles
  // the create-vs-modify classification + originalContent capture.
  if (isAuditModeActive()) {
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
      return `Error: Search text not found in ${filePath}`;
    }
    const newText = currentText.replace(search, replace);
    await buf.write(filePath, newText, (p) => readDiskViaWorkspace(context, p));
    return `File edited: ${filePath} (buffered for audit review)`;
  }

  const fileUri = Uri.joinPath(resolveRootUri(context), filePath);
  const bytes = await workspace.fs.readFile(fileUri);
  const text = Buffer.from(bytes).toString('utf-8');
  if (!text.includes(search)) {
    return `Error: Search text not found in ${filePath}`;
  }
  const newText = text.replace(search, replace);
  await workspace.fs.writeFile(fileUri, Buffer.from(newText, 'utf-8'));
  return `File edited: ${filePath}`;
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
  { definition: listDirectoryDef, executor: listDirectory, requiresApproval: false },
];
