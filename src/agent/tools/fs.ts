import { workspace, Uri } from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
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
// edit_file search-not-found recovery helper
// ---------------------------------------------------------------------------

/**
 * When a search string isn't found verbatim, find the file region that most
 * closely matches it and return it so the model can correct its search string
 * without a separate read_file round-trip.
 *
 * Strategy: split the search into lines, slide a same-height window over the
 * file, score each window by the number of lines that appear (in any order)
 * as substrings of that window. Return the top-scoring window plus a few
 * lines of context on each side, capped to 20 lines total.
 */
function grepLines(fileText: string, keywords: string[]): { lineNo: number; line: string }[] {
  const results: { lineNo: number; line: string }[] = [];
  const lines = fileText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lower = lines[i].toLowerCase();
    if (keywords.some((kw) => lower.includes(kw))) {
      results.push({ lineNo: i + 1, line: lines[i] });
    }
  }
  return results;
}

/**
 * Build grep hints from a search/replace string: extract distinctive
 * keywords (≥5 chars) and find which lines in the file contain them.
 * Returns a formatted hint telling the model exactly which lines to read,
 * so it can get the precise text and construct a correct search string.
 */
function buildGrepHint(fileText: string, searchOrReplace: string): string | null {
  const keywords = searchOrReplace
    .split(/\W+/)
    .filter((w) => w.length >= 5)
    .map((w) => w.toLowerCase())
    .slice(0, 4); // top 4 most distinctive words
  if (keywords.length === 0) return null;

  const hits = grepLines(fileText, keywords.slice(0, 2)); // grep with top 2
  if (hits.length === 0) return null;

  const top = hits.slice(0, 3); // show at most 3 matching lines
  const lineList = top.map((h) => `  line ${h.lineNo}: ${h.line.trim().slice(0, 80)}`).join('\n');
  const readCall = `read_file(path="${'<file>'}", start_line=${Math.max(1, top[0].lineNo - 2)}, end_line=${top[0].lineNo + 2})`;
  return `Grep for [${keywords.slice(0, 2).join(', ')}] found these lines:\n${lineList}\n→ Call \`${readCall}\` to get the exact text, then use it verbatim as your search string.`;
}
function findNearestMatch(fileText: string, search: string): string | null {
  const searchLines = search
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (searchLines.length === 0) return null;

  // Extract significant words (≥4 chars, not common filler) from the search.
  const searchWords = search
    .split(/\W+/)
    .filter((w) => w.length >= 4)
    .map((w) => w.toLowerCase());
  if (searchWords.length === 0) return null;

  const fileLines = fileText.split('\n');
  const windowSize = Math.max(searchLines.length, 1);
  let bestScore = 0;
  let bestIdx = -1;

  for (let i = 0; i <= fileLines.length - windowSize; i++) {
    const window = fileLines
      .slice(i, i + windowSize)
      .join('\n')
      .toLowerCase();
    // Score by fraction of search words that appear in the window.
    const score = searchWords.filter((w) => window.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  // Require at least 30% of search words to match to avoid showing noise.
  if (bestIdx < 0 || bestScore < Math.ceil(searchWords.length * 0.3)) return null;

  const contextLines = 3;
  const start = Math.max(0, bestIdx - contextLines);
  const end = Math.min(fileLines.length, bestIdx + windowSize + contextLines);
  return fileLines.slice(start, end).join('\n');
}

/**
 * Find the region in the file that the model INTENDS to replace, using
 * the desired new content (replace) to locate the target. Differs from
 * findNearestMatch in two ways:
 *
 *   1. It uses `replace` (what the model wants to write) rather than
 *      `search` (which is wrong). The model's desired output has keyword
 *      overlap with the existing target region even when the search
 *      string doesn't match — e.g. both old and new contain "eslint" and
 *      "tsc" around the lint-detection if-block.
 *
 *   2. It returns ONLY the core window (no surrounding context lines) so
 *      the result can be passed directly to text.replace() without
 *      accidentally removing the context lines around the target.
 *
 * Returns null when confidence is below 40% so low-signal guesses are
 * rejected rather than silently corrupting unrelated regions.
 */
function findIntentTarget(fileText: string, replace: string): string | null {
  const searchWords = replace
    .split(/\W+/)
    .filter((w) => w.length >= 4)
    .map((w) => w.toLowerCase());
  if (searchWords.length === 0) return null;

  const fileLines = fileText.split('\n');
  const windowSize = Math.max(replace.split('\n').filter(Boolean).length, 1);
  let bestScore = 0;
  let bestIdx = -1;

  for (let i = 0; i <= fileLines.length - windowSize; i++) {
    const window = fileLines
      .slice(i, i + windowSize)
      .join('\n')
      .toLowerCase();
    const score = searchWords.filter((w) => window.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestScore < Math.ceil(searchWords.length * 0.4)) return null;
  return fileLines.slice(bestIdx, bestIdx + windowSize).join('\n');
}

/**
 * Like findNearestMatch but returns a wider window (up to maxLines).
 * Used for the "file not read this turn" injection where we want to
 * show enough context that the model can see the full code block
 * (comment + if statement + body) rather than just the comment line.
 */
function findNearestMatchWide(fileText: string, search: string, maxLines = 25): string | null {
  const searchLines = search
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (searchLines.length === 0) return null;

  const searchWords = search
    .split(/\W+/)
    .filter((w) => w.length >= 4)
    .map((w) => w.toLowerCase());
  if (searchWords.length === 0) return null;

  const fileLines = fileText.split('\n');
  const windowSize = Math.max(searchLines.length, 1);
  let bestScore = 0;
  let bestIdx = -1;

  for (let i = 0; i <= fileLines.length - windowSize; i++) {
    const window = fileLines
      .slice(i, i + windowSize)
      .join('\n')
      .toLowerCase();
    const score = searchWords.filter((w) => window.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestScore < Math.ceil(searchWords.length * 0.3)) return null;

  // Wide context: enough to show the full surrounding code block
  const half = Math.floor((maxLines - windowSize) / 2);
  const start = Math.max(0, bestIdx - half);
  const end = Math.min(fileLines.length, bestIdx + windowSize + half);
  return fileLines.slice(start, end).join('\n');
}

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
  nondeterministicOutput: true,
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
      // Throw so the executor sets is_error:true on the tool_result — the
      // eval harness and completion gate both check is_error to detect
      // file-not-found. The helpful message is still visible to the model.
      throw new Error(
        `File not found: ${filePath}\nDid you mean one of these?\n  - ${suggestions}\nUse list_directory to explore the directory structure if none match.`,
      );
    }
    throw new Error(
      `File not found: ${filePath}\nNo file named "${basename}" exists in the workspace. Use list_directory or search_files to find the correct path.`,
    );
  }
  const text = Buffer.from(bytes).toString('utf-8');
  // Track this file as read so editFile knows the model has current content.
  context?.filesReadThisTurn?.add(path.posix.normalize(filePath.split(path.sep).join('/')));
  if (mode === 'compact') return compactSourceFile(text);
  if (mode === 'outline') return outlineSourceFile(text);
  return text;
}

/**
 * Consecutive write_file calls allowed to a single path with no intervening
 * verification before the next one is soft-blocked. Create + two rewrites, then
 * the model must run/diagnose the file before rewriting a 4th time.
 */
const MAX_UNVERIFIED_REWRITES = 3;

/** True if `filePath` matches an entry in `set` exactly or by basename. */
function pathInSetByBasename(filePath: string, set: Set<string>): boolean {
  if (set.has(filePath)) return true;
  const base = filePath.split('/').pop()!.toLowerCase();
  for (const p of set) {
    if (p.split('/').pop()!.toLowerCase() === base) return true;
  }
  return false;
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

  // --- Rewrite-thrash guards (per-run state threaded via context) ---

  // 0. Enforce edit-over-rewrite. Once the model is making targeted edits to a
  // file, a full write_file would clobber them — regenerating the whole file
  // re-introduces the bug the edit just fixed (dogfooding caught exactly that
  // write→edit→write→edit loop on a recurring syntax error). Force edit_file.
  if (context?.filesEditedViaEditTool && pathInSetByBasename(filePath, context.filesEditedViaEditTool)) {
    return (
      `write_file to \`${filePath}\` was NOT applied. You've been making targeted edits to this file, and a full ` +
      `rewrite would clobber them — regenerating the whole file keeps re-introducing the bug you just fixed with ` +
      `edit_file. Make this change with edit_file instead: put the exact current lines in \`search\` and the new ` +
      `lines in \`replace\`. To replace a whole section, pass that entire block as \`search\` and the new block as ` +
      `\`replace\`. Read the file first if you're unsure of the current text.`
    );
  }

  const writeHistory = context?.writeHistoryByFile;
  const contentHash = writeHistory ? crypto.createHash('sha256').update(content).digest('hex') : undefined;

  // 1. Circular rewrite: content byte-identical to a version already written to
  // this path this run — a no-op on disk and the signature of A→B→A thrash.
  // Returning a soft-block instead of a false "success" tells the model nothing
  // changed and points it at edit_file; cycleDetection skips blocked circular
  // writes so the run continues. Identical content is never progress.
  if (writeHistory && contentHash !== undefined && writeHistory.get(filePath)?.has(contentHash)) {
    return (
      `No change written — the content is byte-identical to a version you already wrote to \`${filePath}\` ` +
      `this session, so the file is unchanged. Stop rewriting the whole file: if you need to change something, ` +
      `use edit_file to modify ONLY the specific lines. If you believe it is already correct, verify it instead — ` +
      `write a test that imports this module and asserts its behavior, then run it.`
    );
  }

  // 2. Verify-before-rewrite: too many consecutive rewrites of this file with no
  // verification in between. Rewriting blind never surfaces bugs — dogfooding
  // caught qwen3.5 rewriting a GUI 7× without ever running it, converging on a
  // NameError one execution would have caught. Force the feedback step.
  if (context?.writesSinceVerifyByFile) {
    const n = (context.writesSinceVerifyByFile.get(filePath) ?? 0) + 1;
    context.writesSinceVerifyByFile.set(filePath, n);
    if (n > MAX_UNVERIFIED_REWRITES) {
      return (
        `This write was NOT applied. You've rewritten \`${filePath}\` ${n} times without running or checking it ` +
        `once — rewriting blind doesn't surface bugs (a NameError, a wrong result, a dead button only appear when ` +
        `the code RUNS). Verify the current file before rewriting again: call get_diagnostics, or run it / a test ` +
        `that imports it. Then fix exactly what the output reports with edit_file — change only the broken lines, ` +
        `do not regenerate the whole file.`
      );
    }
  }

  // Committing to write — record the content hash for circular detection.
  if (writeHistory && contentHash !== undefined) {
    const set = writeHistory.get(filePath);
    if (set) set.add(contentHash);
    else writeHistory.set(filePath, new Set([contentHash]));
  }

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
  context?.workspaceIndex?.invalidateFile(filePath);

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
    // The model wrote the desired new text in both fields instead of putting
    // the CURRENT file text in search. Surface the nearest matching region
    // so the model can copy it directly as the search string without a
    // separate read_file round-trip.
    let hint =
      'The search field must contain the CURRENT text in the file (what you are replacing). ' +
      'The replace field contains the NEW text (what you want it to say). They cannot be the same.';
    const currentContent = isAuditModeActive(context)
      ? (getDefaultAuditBuffer().read(filePath).content ?? (await readDiskViaWorkspace(context, filePath)))
      : await readDiskViaWorkspace(context, filePath);
    if (currentContent) {
      const nearest = findNearestMatch(currentContent, search);
      if (nearest) {
        hint =
          'search = CURRENT file text (copy exactly). replace = NEW text (what you want).\n\n' +
          `COPY THIS INTO YOUR search FIELD — it is what the file currently says:\n\`\`\`\n${nearest}\n\`\`\`\n\n` +
          'Your replace field should contain the updated version of the above text.';
      }
    }
    // Same steer: the model gave us the desired new content — use it to
    // find the intent target and apply the edit rather than failing.
    if (currentContent) {
      const intentTarget = findIntentTarget(currentContent, search);
      if (intentTarget && currentContent.includes(intentTarget) && intentTarget !== search) {
        // We're in the early path (before file is read via fileUri), so
        // re-read or use currentContent directly based on which path we're in.
        // The identical check fires before audit-mode vs disk branching, so
        // we use `currentContent` which was read above.
        const inferredText = currentContent.replace(intentTarget, replace);
        const patch = computeLineDiff(currentContent, inferredText, filePath);
        if (context?.onOutput && patch) context.onOutput(DIFF_PREFIX + patch);
        if (isAuditModeActive(context)) {
          await getDefaultAuditBuffer().write(filePath, inferredText, (p) => readDiskViaWorkspace(context, p));
          return (
            `Applied inferred edit to ${filePath} (buffered for audit review): ` +
            `found closest matching region for your content.\n` +
            `Replaced:\n\`\`\`\n${intentTarget}\n\`\`\`\nWith:\n\`\`\`\n${replace}\n\`\`\``
          );
        }
        const fileUri2 = Uri.joinPath(resolveRootUri(context), filePath);
        await workspace.fs.writeFile(fileUri2, Buffer.from(inferredText, 'utf-8'));
        return (
          `Applied inferred edit to ${filePath}: ` +
          `found closest matching region for your content.\n` +
          `Replaced:\n\`\`\`\n${intentTarget}\n\`\`\`\nWith:\n\`\`\`\n${replace}\n\`\`\``
        );
      }
    }
    return `Error: edit_file failed — search and replace text are identical; no change would be made.\n${hint}`;
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
      const nearest = findNearestMatch(currentText, search);
      const grepHint = buildGrepHint(currentText, search) ?? buildGrepHint(currentText, replace);
      const hint = grepHint
        ? `\n\n${grepHint}`
        : nearest
          ? `\n\nNearest matching region in the file (use this as your search string):\n\`\`\`\n${nearest}\n\`\`\``
          : '\n\nCall read_file to see the exact current content.';
      return `Error: edit_file failed — search string not found in ${filePath}. The file was NOT modified.${hint}`;
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

  // If the model is editing a file it hasn't explicitly read this turn,
  // inject the nearest relevant section so it has current file context.
  // This structurally closes the gap where models call edit_file without
  // calling read_file first, leading to wrong search strings.
  const normalizedPath = path.posix.normalize(filePath.split(path.sep).join('/'));
  const hasReadFile = context?.filesReadThisTurn?.has(normalizedPath) ?? true;
  const unreadPrefix =
    !hasReadFile && context?.filesReadThisTurn !== undefined
      ? (() => {
          // Grep-first: find the exact line numbers for keywords from the
          // search/replace content. This seeds the model with "line 42 contains
          // X" so it can call read_file(start_line=40, end_line=44) to get the
          // exact text, rather than guessing at the search string.
          const grepResult = buildGrepHint(text, search + '\n' + replace);
          if (grepResult) {
            return `[You have not read ${filePath} this turn. ${grepResult.replace('<file>', filePath)}]\n\n`;
          }
          const section = findNearestMatchWide(text, search + '\n' + replace, 25);
          return section
            ? `[You have not read ${filePath} this turn. Current file section near your intended edit:\n\`\`\`\n${section}\n\`\`\`\nUse the exact text from above as your search string — it must match the file byte-for-byte.]\n\n`
            : `[You have not read ${filePath} this turn. Call read_file first to see the current content before editing.]\n\n`;
        })()
      : '';

  if (!text.includes(search)) {
    // Steer the model's intent: the replace content is usually correct even
    // when the search string isn't. Use the desired new content to locate
    // the target region and apply the edit directly. This handles the common
    // small-model failure where the model writes the new text in search instead
    // of the old text — we infer where it wants to make the change.
    const intentTarget = findIntentTarget(text, replace);
    if (intentTarget && text.includes(intentTarget) && intentTarget !== replace) {
      const inferredText = text.replace(intentTarget, replace);
      const patch = computeLineDiff(text, inferredText, filePath);

      if (context?.onOutput && patch) context.onOutput(DIFF_PREFIX + patch);
      if (context?.editTimeline && !context.cwd) context.editTimeline.record(filePath, text, inferredText);

      await workspace.fs.writeFile(fileUri, Buffer.from(inferredText, 'utf-8'));
      context?.workspaceIndex?.invalidateFile(filePath);
      return (
        `${unreadPrefix}Applied inferred edit to ${filePath}: the search string didn't match exactly, ` +
        `but I found the closest matching region and replaced it with your content.\n` +
        `Replaced:\n\`\`\`\n${intentTarget}\n\`\`\`\n` +
        `With:\n\`\`\`\n${replace}\n\`\`\`` +
        (partialReplaceWarning ? `\n${partialReplaceWarning}` : '')
      );
    }

    const grepHint2 = buildGrepHint(text, search) ?? buildGrepHint(text, replace);
    const nearest = findNearestMatch(text, search);
    const hint = grepHint2
      ? `\n\n${grepHint2.replace('<file>', filePath)}`
      : nearest
        ? `\n\nNearest matching region in the file (use this as your search string):\n\`\`\`\n${nearest}\n\`\`\``
        : '\n\nCall read_file to see the exact current content.';
    return `${unreadPrefix}Error: edit_file failed — search string not found in ${filePath}. The file was NOT modified.${hint}`;
  }
  const matchCount = text.split(search).length - 1;
  if (matchCount > 1) {
    return `${unreadPrefix}Error: edit_file failed — search string appears ${matchCount} times in ${filePath}. The file was NOT modified. Add more surrounding context to your search string to make it unique, then retry.`;
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
  context?.workspaceIndex?.invalidateFile(filePath);
  return `${unreadPrefix}File edited: ${filePath}${partialReplaceWarning}`;
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
