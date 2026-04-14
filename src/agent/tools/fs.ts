import { workspace, Uri } from 'vscode';
import * as path from 'path';
import type { ToolDefinition } from '../../ollama/types.js';
import { validateFilePath, isSensitiveFile, isProtectedWritePath, getRootUri } from './shared.js';
import { compactSourceFile, outlineSourceFile } from './compression.js';

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

export async function readFile(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string;
  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;
  if (isSensitiveFile(filePath)) {
    return `Warning: "${filePath}" appears to contain secrets or credentials. Reading this file would send its contents to the LLM provider. Use read_file on a non-sensitive file instead, or ask the user to provide the needed information directly.`;
  }
  const fileUri = Uri.joinPath(getRootUri(), filePath);
  const bytes = await workspace.fs.readFile(fileUri);
  const text = Buffer.from(bytes).toString('utf-8');
  const mode = input.mode as string | undefined;
  if (mode === 'compact') return compactSourceFile(text);
  if (mode === 'outline') return outlineSourceFile(text);
  return text;
}

export async function writeFile(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string;
  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;
  const protectedError = isProtectedWritePath(filePath);
  if (protectedError) return protectedError;
  const content = input.content as string;
  const fileUri = Uri.joinPath(getRootUri(), filePath);
  // Create parent directories
  const dir = path.dirname(filePath);
  if (dir && dir !== '.') {
    await workspace.fs.createDirectory(Uri.joinPath(getRootUri(), dir));
  }
  await workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
  return `File written: ${filePath}`;
}

export async function editFile(input: Record<string, unknown>): Promise<string> {
  const filePath = input.path as string;
  const pathError = validateFilePath(filePath);
  if (pathError) return pathError;
  const protectedError = isProtectedWritePath(filePath);
  if (protectedError) return protectedError;
  const search = input.search as string;
  const replace = input.replace as string;
  const fileUri = Uri.joinPath(getRootUri(), filePath);
  const bytes = await workspace.fs.readFile(fileUri);
  const text = Buffer.from(bytes).toString('utf-8');
  if (!text.includes(search)) {
    return `Error: Search text not found in ${filePath}`;
  }
  const newText = text.replace(search, replace);
  await workspace.fs.writeFile(fileUri, Buffer.from(newText, 'utf-8'));
  return `File edited: ${filePath}`;
}

export async function listDirectory(input: Record<string, unknown>): Promise<string> {
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
  const dirUri = Uri.joinPath(getRootUri(), dirPath);
  const entries = await workspace.fs.readDirectory(dirUri);
  return entries.map(([name, type]) => `${type === 2 ? '📁 ' : '📄 '}${name}`).join('\n');
}
