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
import { editWouldBreakSyntax, canParseSyntax, tryLiteralEscapeRecovery } from './syntaxCheck.js';
import { findEditMatch, matchToleranceNote, applyEol, detectEol, type MatchTier } from './editMatch.js';
import { delimiterBalance, balanceEquals } from '../delimiters.js';

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
 * Returns null when confidence is below `minConfidenceRatio` (default 40%)
 * so low-signal guesses are rejected rather than silently corrupting
 * unrelated regions. A caller retrying after repeated identical failures
 * (see recordEditFailure) may pass a lower ratio — the file/replace content
 * is unchanged between attempts, so re-running at the SAME ratio would
 * reject again for the same reason; loosening it is the only way a retry
 * can find something the stricter first pass didn't.
 */
/**
 * Detect an edit whose intent is ALREADY SATISFIED by the file.
 *
 * A search-not-found failure has two very different causes, and telling the
 * model "search string not found" for both is what produced a live loop
 * (v0.119 dogfood): llama3.2 renamed `greet`→`welcome` correctly on iteration
 * 1, verified it, then kept re-sending the rename. Each retry failed with
 * "search string not found" — technically true, uselessly so — and it edited
 * until cycle detection bailed. The file was right the whole time.
 *
 * The signal is deterministic: the tokens the edit meant to REMOVE are absent
 * from the file, and the tokens it meant to ADD are present. Nothing is left
 * to do. Deliberately conservative — it fires only when the search introduces
 * at least one distinctive token that is now gone AND every distinctive token
 * the replacement adds is already there, so a half-finished rename (old name
 * still present somewhere) still reads as a normal failure.
 */
function isEditAlreadyApplied(fileText: string, search: string, replace: string): boolean {
  const tokens = (s: string) => new Set((s.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).map((t) => t));
  const searchTokens = tokens(search);
  const replaceTokens = tokens(replace);

  const removed = [...searchTokens].filter((t) => !replaceTokens.has(t));
  const added = [...replaceTokens].filter((t) => !searchTokens.has(t));
  if (removed.length === 0 || added.length === 0) return false;

  const gone = removed.every((t) => !new RegExp(`\\b${t}\\b`).test(fileText));
  const present = added.every((t) => new RegExp(`\\b${t}\\b`).test(fileText));
  return gone && present;
}

/**
 * An inferred (fuzzy) replacement is structurally safe only when it preserves
 * the file's delimiter balance — i.e. `replace` opens and closes exactly as
 * many brackets as the region it replaces.
 *
 * Why this exists (v0.119 dogfood, live file corruption): `findIntentTarget`
 * sizes its window by the REPLACE string's line count. A model asked to rename
 * `greet` sent a one-line replace, so the window was the single line
 * `export function greet(name: string): string {` — a block HEADER (curly +1).
 * Replacing it with a self-contained one-liner (curly 0) orphaned the old body
 * (`return …` / `}`), dropped `export`, and left a syntax error. The tool
 * reported SUCCESS, so the model "fixed" it four more times, each pass
 * mangling further; the run only ended when cycle detection bailed at
 * iteration 22 with the file broken on disk.
 *
 * Balance mismatch means the replacement cannot be a drop-in for the region,
 * regardless of how well the fuzzy scorer liked it — so refuse to guess.
 */
function isStructurallySafeReplacement(filePath: string, target: string, replace: string): boolean {
  // The delimiter-balance heuristic is a FALLBACK, not the gate.
  //
  // It predates the tree-sitter syntax guard (both landed in the same v0.119
  // session) and is strictly weaker: an edit that breaks structure makes the
  // file stop parsing, which the syntax check catches with a real grammar. The
  // heuristic, by contrast, is measurably unreliable — run over real source, it
  // reports a NON-ZERO balance for complete, valid files:
  //     TypeScript  72/900   (regex literals: /\{|\}/ — braces inside a regex)
  //     Rust        58/344   (lifetimes: &'a str — the ' reads as a string open)
  //     Python      14/400   (# comments and ''' strings are not modelled)
  // Every one of those is a FALSE REFUSAL of a legitimate edit.
  //
  // So it now runs only where the syntax guard cannot: a language with no
  // grammar. There, a rough structural signal beats none. Where a grammar
  // exists — which is every language people actually edit here — the parse
  // decides, and this never fires.
  if (canParseSyntax(filePath)) return true;
  return balanceEquals(delimiterBalance(target), delimiterBalance(replace));
}

/**
 * Below the apply bar, the fuzzy matcher SUGGESTS rather than writes.
 *
 * A wrong region that happens to parse is silent corruption of untouched code:
 * the syntax guard cannot see it, because the result IS valid — it is just valid
 * in the wrong place. So a merely-plausible guess is never written. It is handed
 * to the model as the exact text to copy into `search`, which routes the edit
 * back through the exact-match path where every guard applies. That keeps the
 * recovery value (the model gets the precise text it needs) at zero risk to the
 * file: a bad suggestion costs one retry.
 *
 * See APPLY_MARGIN for the bar above which a guess is trustworthy enough to
 * write without asking.
 */
function suggestRegionError(filePath: string, candidate: string, why: string): string {
  return (
    `Error: edit_file did not apply this edit to ${filePath} — ${why}. The file was NOT modified.\n\n` +
    `The closest matching region in the file is:\n\`\`\`\n${candidate}\n\`\`\`\n\n` +
    `If that is the code you meant to change, call edit_file again with 'search' set to EXACTLY that text ` +
    `(copy it byte-for-byte) and your new version in 'replace'. If it is not, call read_file to find the ` +
    `right text first.`
  );
}

/**
 * Margin required to APPLY an inferred edit without asking: the winning window
 * must beat the runner-up by this many distinctive words. Measured over 1,700
 * real edits from eleven repositories:
 *
 *     margin 1 → 6.7% of committed guesses rewrite the WRONG region
 *     margin 2 → 1.3%
 *     margin 3 → 0.0%   (177 commitments, zero wrong)
 *
 * So a guess is written to disk only when it is unambiguous by that measure.
 */
const APPLY_MARGIN = 3;

/** Margin required merely to SUGGEST a region to the model. A suggestion writes nothing, so it can be looser. */
const SUGGEST_MARGIN = 1;

/**
 * Locate the region a model most likely meant to rewrite, from its `replace`
 * text alone. Returns null when it cannot tell — declining is always safe;
 * naming the wrong region is not.
 *
 * Ground-truthed against 1,700 real edits mined from the git history of eleven
 * repositories (SideCar, flask, requests, fastapi, pip, black, pytest, httpx,
 * attrs, ripgrep, fd), which fixed three genuine bugs in the original:
 *
 *   1. TIES WENT TO THE FIRST WINDOW. `score > best` is strictly greater, so
 *      among equally-scoring windows it silently took the earliest one in the
 *      file. In code, where patterns repeat, that is a coin flip dressed as a
 *      decision — and it is why even a 100%-of-words match was wrong a quarter
 *      of the time. Ambiguity now DECLINES.
 *   2. SUBSTRING, NOT WORD, MATCHING. `window.includes('name')` also matched
 *      `filename`; `get` matched `target`. Scores were inflated by coincidence.
 *   3. NO MARGIN. A best score barely ahead of the runner-up was treated as
 *      certainty. A win must now be clear.
 *
 * Exported for the oracle (findIntentTarget.oracle.test.ts); not part of the
 * tool surface.
 */
export function findIntentTarget(
  fileText: string,
  replace: string,
  minConfidenceRatio = 0.4,
  minMargin = 1,
): string | null {
  const words = [
    ...new Set(
      replace
        .split(/\W+/)
        .filter((w) => w.length >= 4)
        .map((w) => w.toLowerCase()),
    ),
  ];
  if (words.length === 0) return null;

  const fileLines = fileText.split('\n');
  const windowSize = Math.max(replace.split('\n').filter((l) => l.trim()).length, 1);

  // Word-boundary scoring: `name` must not match `filename`.
  const wordRes = words.map((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`));

  let best = 0;
  let bestIdx = -1;
  let runnerUp = 0;
  let bestTied = false;

  for (let i = 0; i <= fileLines.length - windowSize; i++) {
    const window = fileLines
      .slice(i, i + windowSize)
      .join('\n')
      .toLowerCase();
    let score = 0;
    for (const re of wordRes) if (re.test(window)) score++;

    if (score > best) {
      runnerUp = best;
      best = score;
      bestIdx = i;
      bestTied = false;
    } else if (score === best && best > 0 && i !== bestIdx) {
      // A second window scores exactly as well. We cannot tell them apart, and
      // guessing here is what rewrote the wrong code.
      bestTied = true;
    } else if (score > runnerUp) {
      runnerUp = score;
    }
  }

  if (bestIdx < 0) return null;
  if (bestTied) return null; // ambiguous → decline
  if (best < Math.ceil(words.length * minConfidenceRatio)) return null;

  // The win must be CLEAR: at least one distinctive word more than the next-best
  // candidate. Without this, "5 words matched here, 5 there" reads as certainty.
  if (best - runnerUp < minMargin) return null;

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

/**
 * Detect a verbatim-repeated failing `edit_file` call for the same path — the
 * signature of a weak model that got a hint (nearest-match / search-not-found)
 * and resubmitted the identical broken call instead of adapting. Both
 * "search === replace" and "search not found" are unrecoverable-without-more-
 * info failures (the tool can only show a hint, not safely guess the intended
 * change), so a verbatim repeat means the hint didn't land — escalating to a
 * blunter instruction is the only lever left before cycle detection bails the
 * whole run. Records the new signature as a side effect so the NEXT call can
 * be checked against this one; returns false (never escalates) when the
 * tracker is absent (unit tests / non-loop calls).
 */
function recordEditFailure(
  context: ToolExecutorContext | undefined,
  filePath: string,
  search: string,
  replace: string,
): number {
  const signature = `${search.length}:${replace.length}:${search} ${replace}`;
  const map = context?.editFailureSignatures;
  if (!map) return 1;
  const prev = map.get(filePath);
  let count = 1;
  if (prev) {
    const sepIdx = prev.indexOf('|');
    const prevCount = Number(prev.slice(0, sepIdx));
    const prevSignature = prev.slice(sepIdx + 1);
    if (prevSignature === signature && Number.isFinite(prevCount)) count = prevCount + 1;
  }
  map.set(filePath, `${count}|${signature}`);
  return count;
}

/** Clear a path's failure-repeat tracking after a successful edit, so a LATER
 *  distinct failure isn't mistaken for a repeat of an already-fixed one. */
function clearEditFailure(context: ToolExecutorContext | undefined, filePath: string): void {
  context?.editFailureSignatures?.delete(filePath);
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
    'To read only part of a large file, pass `start_line` and/or `end_line` (1-based, inclusive) — the returned text is the raw lines with NO line-number prefixes, so you can copy it straight into an `edit_file` `search`. A line range takes precedence over `mode`. ' +
    'Example: `read_file(path="src/utils.ts")` for full contents, `read_file(path="src/large.ts", mode="compact")` for a leaner read, `read_file(path="src/big.ts", start_line=40, end_line=55)` for just those lines.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path from the project root' },
      mode: {
        type: 'string',
        enum: ['full', 'compact', 'outline'],
        description:
          'Output mode. `full` (default) returns raw file contents. `compact` strips comments and blank-line runs. `outline` returns signatures only. Ignored when a line range is given.',
      },
      start_line: {
        type: 'integer',
        description:
          'First line to return (1-based, inclusive). Omit to start at line 1. Use with end_line to read a range from a large file.',
      },
      end_line: {
        type: 'integer',
        description: 'Last line to return (1-based, inclusive). Omit to read to end of file.',
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
    'To ADD text rather than replace it, use `insert_before` or `insert_after` with the anchor in `search` — do not restate the anchor inside `replace`. ' +
    'Example: `edit_file(path="src/utils.ts", search="function greet(name: string)", replace="function greet(name: string, greeting = \'Hello\')")`. ' +
    'Insert example: `edit_file(path="src/utils.ts", search="export function greet(", insert_before="/** Greets someone. */")`.',
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
      insert_before: {
        type: 'string',
        description:
          'ADD text immediately before the search match, keeping the match itself. Use this to insert — a JSDoc comment above a function, an import at the top of a block — instead of restating the anchor inside `replace`. Mutually exclusive with `replace` and `insert_after`.',
      },
      insert_after: {
        type: 'string',
        description:
          'ADD text immediately after the search match, keeping the match itself. Mutually exclusive with `replace` and `insert_before`.',
      },
    },
    // Only `path` is structurally required. search/replace presence is
    // enforced INSIDE the executor, where file existence is knowable: small
    // models constantly call edit_file with one of them missing on a file
    // that doesn't exist yet (creation intent — the content is in whichever
    // field they filled). A dispatcher schema bounce dead-ends them
    // (measured: 1 recovery in 41 bounces); the executor coerces instead.
    required: ['path'],
  },
};

/**
 * V2 insert-API variant of the edit_file definition (`editFile.insertApiV2`).
 * Same tool, same executor — the SCHEMA teaches the convention whose naive
 * English reading matches its semantics: `insert_after`/`insert_before` hold
 * the EXISTING anchor ("insert after THIS"), `new_text` holds the code to add.
 * Campaigns 3/4: gemma4 read the V1 field names as positions every single run
 * (anchor in `insert_after`, payload nowhere) and fast-stuck on it; field
 * names are prompt surface and must survive the naive parse. The executor
 * accepts both conventions regardless of which definition is advertised.
 */
export const editFileDefV2: ToolDefinition = {
  ...editFileDef,
  description:
    'Edit an existing file by replacing an exact search string with a replacement. ' +
    'Use for surgical changes — renaming a function, updating a single line, adding an import. ' +
    'Not for creating a file or doing a full rewrite — use `write_file` for those. ' +
    'Not for multi-location changes in one call — call `edit_file` once per location, each with a unique search string. ' +
    'The `search` argument must match exactly one location in the file; if it appears multiple times the call returns an error — add more surrounding lines to make it unique. ' +
    'Match is byte-exact: whitespace, indentation, and trailing spaces must match the file verbatim. When in doubt, call `read_file` first and copy-paste the target text directly into `search`. ' +
    'To ADD text rather than replace it: put the EXISTING text to insert next to in `insert_after` (or `insert_before`), and the NEW code in `new_text`. ' +
    'Example: `edit_file(path="src/utils.ts", search="function greet(name: string)", replace="function greet(name: string, greeting = \'Hello\')")`. ' +
    'Insert example: `edit_file(path="src/utils.ts", insert_after="export function greet(name) {\\n  return name;\\n}", new_text="export function farewell(name) {\\n  return \'bye \' + name;\\n}")`.',
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Relative file path from the project root' },
      search: {
        type: 'string',
        description:
          'Exact text to find in the file — whitespace and indentation must match the file byte-for-byte. Must appear exactly once. Used with `replace` to substitute text.',
      },
      replace: {
        type: 'string',
        description:
          'New text to substitute for the search match. Must differ from search — if they are identical the call returns an error.',
      },
      insert_after: {
        type: 'string',
        description:
          'EXISTING text from the file — the anchor to insert after. The new code goes in `new_text`, which is inserted immediately after this anchor; the anchor itself is kept unchanged. Mutually exclusive with `replace` and `insert_before`.',
      },
      insert_before: {
        type: 'string',
        description:
          'EXISTING text from the file — the anchor to insert before. The new code goes in `new_text`, which is inserted immediately before this anchor; the anchor itself is kept unchanged. Mutually exclusive with `replace` and `insert_after`.',
      },
      new_text: {
        type: 'string',
        description:
          'The NEW code to add when inserting. Required alongside `insert_after` or `insert_before`. Contains ONLY the new text — never repeat the anchor.',
      },
    },
    required: ['path'],
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
  if (pathError) throw new Error(pathError);
  if (isSensitiveFile(filePath)) {
    return `Warning: "${filePath}" appears to contain secrets or credentials. Reading this file would send its contents to the LLM provider. Use read_file on a non-sensitive file instead, or ask the user to provide the needed information directly.`;
  }
  const mode = input.mode as string | undefined;
  const startLine = toLineNum(input.start_line);
  const endLine = toLineNum(input.end_line);

  // Audit Mode read-through: if the agent previously wrote this file
  // during the same session, return the buffered content rather than
  // the stale disk contents. Keeps multi-step edits stacking correctly.
  if (isAuditModeActive(context)) {
    const bufState = getDefaultAuditBuffer().read(filePath);
    if (bufState.buffered) {
      if (bufState.deleted) {
        throw new Error(`Error: File not found (${filePath}) — deleted in Audit Buffer pending review.`);
      }
      const text = bufState.content ?? '';
      return applyReadView(text, mode, startLine, endLine);
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

    // Render a found file relative to the root WE resolved, not via
    // `workspace.asRelativePath`. That API resolves against the extension host's
    // workspace folders, which are not the root here when the agent is pinned to a
    // Shadow Workspace or a temp dir — the eval harness got back absolute
    // `/var/folders/T/…` paths, so the model was handed a wall of noise instead of
    // `src/utils.ts`. resolveRootUri is the same root `read_file` just read from,
    // so it is correct in every context.
    const uriPath = (u: { path?: string; fsPath?: string }): string => u.path ?? u.fsPath ?? '';
    const rootPath = uriPath(resolveRootUri(context)).replace(/\/$/, '');
    const rel = (u: { path?: string; fsPath?: string }): string => {
      const p = uriPath(u);
      return rootPath && p.startsWith(rootPath + '/')
        ? p.slice(rootPath.length + 1)
        : workspace.asRelativePath(u as never, false);
    };

    // Suggest similarly-named files so the model can self-correct without
    // needing a separate list_directory call.
    const basename = path.posix.basename(filePath);
    const similar = await workspace.findFiles(`**/${basename}`, '**/node_modules/**', 5);
    if (similar.length > 0) {
      const suggestions = similar.map(rel).join('\n  - ');
      // Throw so the executor sets is_error:true on the tool_result — the
      // eval harness and completion gate both check is_error to detect
      // file-not-found. The helpful message is still visible to the model.
      throw new Error(
        `File not found: ${filePath}\nDid you mean one of these?\n  - ${suggestions}\nUse list_directory to explore the directory structure if none match.`,
      );
    }
    // No file by that name anywhere. Telling the model to "use search_files" here
    // is a dead end and we have watched it die: qwen2.5-coder asked for
    // src/helpers.ts, was told to search, ran search_files("*helpers*"), got "No
    // files found", and gave up — while src/utils.ts, the file it actually needed,
    // sat one directory listing away. Searching for a filename the model INVENTED
    // can never succeed; that is the one query guaranteed to return nothing.
    //
    // We know what is in that directory. Say it, and point the model at content
    // search (the symbol it is after) rather than name search.
    const dir = path.posix.dirname(filePath);
    const dirGlob = dir && dir !== '.' ? `${dir}/*` : '*';
    const siblings = await workspace.findFiles(dirGlob, '**/node_modules/**', 20);
    if (siblings.length > 0) {
      const listing = siblings.map(rel).sort().join('\n  - ');
      throw new Error(
        `File not found: ${filePath}\nNo file named "${basename}" exists. ` +
          `${dir && dir !== '.' ? `The directory \`${dir}/\`` : 'The workspace root'} contains:\n  - ${listing}\n\n` +
          `If one of these is the file you want, read it. If not, search by CONTENT — ` +
          `grep for the symbol or text you are looking for — rather than by filename: ` +
          `you already know the name you guessed does not exist.`,
      );
    }

    throw new Error(
      `File not found: ${filePath}\nNo file named "${basename}" exists in the workspace, and ` +
        `${dir && dir !== '.' ? `\`${dir}/\` has no files either` : 'the workspace root appears empty'}. ` +
        `Use list_directory to see the real structure, or grep for the symbol you are after — ` +
        `do not search for the filename you guessed.`,
    );
  }
  const text = Buffer.from(bytes).toString('utf-8');
  // Track this file as read so editFile knows the model has current content.
  context?.filesReadThisTurn?.add(path.posix.normalize(filePath.split(path.sep).join('/')));
  return applyReadView(text, mode, startLine, endLine);
}

/** Coerce a line-number input (number or numeric string, as weak models send
 *  either) to a positive integer, or undefined if it isn't one. */
function toLineNum(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

/**
 * Apply the requested view to raw file text. A line range (start_line/end_line,
 * 1-based inclusive) takes precedence over mode and returns the raw lines with NO
 * line-number prefix, so the slice can be copied verbatim into an edit_file
 * `search`. Without a range, mode selects full/compact/outline.
 */
export function applyReadView(text: string, mode: string | undefined, startLine?: number, endLine?: number): string {
  if (startLine !== undefined || endLine !== undefined) {
    const lines = text.split('\n');
    const start = Math.max(1, startLine ?? 1);
    const end = Math.min(lines.length, endLine ?? lines.length);
    if (start > lines.length) {
      return `(file has ${lines.length} line${lines.length === 1 ? '' : 's'}; requested start_line ${start} is past the end)`;
    }
    if (start > end) {
      return `(empty range: start_line ${start} is after end_line ${end})`;
    }
    return lines.slice(start - 1, end).join('\n');
  }
  if (mode === 'compact') return compactSourceFile(text);
  if (mode === 'outline') return outlineSourceFile(text);
  return text;
}

/**
 * Consecutive write_file calls allowed to a single path with no intervening
 * verification before the next one is soft-blocked. Create + two rewrites, then
 * the model must run/diagnose the file before rewriting a 4th time.
 */
export const MAX_UNVERIFIED_REWRITES = 3;

/** True if `filePath` matches an entry in `set` exactly or as a `/`-boundary
 * path suffix (handles relative vs absolute). NOT a bare-basename match, so
 * `src/util.py` doesn't collide with `test/util.py`. */
function pathInSetByBasename(filePath: string, set: Set<string>): boolean {
  const f = filePath.toLowerCase();
  for (const p of set) {
    const q = p.toLowerCase();
    if (q === f || q.endsWith('/' + f) || f.endsWith('/' + q)) return true;
  }
  return false;
}

export async function writeFile(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const filePath = input.path as string;
  const pathError = validateFilePath(filePath);
  if (pathError) throw new Error(pathError);
  const protectedError = isProtectedWritePath(filePath);
  if (protectedError) return protectedError;
  if (isSensitiveFile(filePath)) {
    throw new Error(
      `Error: "${filePath}" appears to contain secrets or credentials. The agent is not permitted to write to this file.`,
    );
  }
  let content = input.content as string;

  // --- Rewrite-thrash guards (per-run state threaded via context) ---

  // 0. Enforce edit-over-rewrite. Once the model is making targeted edits to a
  // file, a full write_file would clobber them — regenerating the whole file
  // re-introduces the bug the edit just fixed (dogfooding caught exactly that
  // write→edit→write→edit loop on a recurring syntax error). Force edit_file.
  if (context?.filesEditedViaEditTool && pathInSetByBasename(filePath, context.filesEditedViaEditTool)) {
    throw new Error(
      `write_file to \`${filePath}\` was NOT applied. You've been making targeted edits to this file, and a full ` +
        `rewrite would clobber them — regenerating the whole file keeps re-introducing the bug you just fixed with ` +
        `edit_file. Make this change with edit_file instead: put the exact current lines in \`search\` and the new ` +
        `lines in \`replace\`. To replace a whole section, pass that entire block as \`search\` and the new block as ` +
        `\`replace\`. Read the file first if you're unsure of the current text.`,
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
      throw new Error(
        `This write was NOT applied. You've rewritten \`${filePath}\` ${n} times without running or checking it ` +
          `once — rewriting blind doesn't surface bugs (a NameError, a wrong result, a dead button only appear when ` +
          `the code RUNS). Verify the current file before rewriting again: call get_diagnostics, or run it / a test ` +
          `that imports it. Then fix exactly what the output reports with edit_file — change only the broken lines, ` +
          `do not regenerate the whole file.`,
      );
    }
  }

  // Syntax guard — the same invariant edit_file enforces: never write source
  // that does not parse. Live v0.119 dogfood: asked to add a JSDoc comment,
  // llama3.2 sidestepped edit_file entirely and called write_file with
  // `@tsdoc \n\nfunction welcome(name: string): string {…` — dropping `export`,
  // writing a non-comment, and clobbering a clean file with unparseable source.
  // Every corruption defence lived in edit_file, so this sailed through and
  // reported success. An empty/absent file parses clean, so the same rule
  // covers creation: don't create a file that doesn't parse either. Fails open
  // when no grammar applies (markdown, JSON, unknown extensions).
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

  // Read the original ONCE — the syntax guard, the edit timeline, and the
  // streaming diff all need it, and a second read would consume a different
  // snapshot (and, in tests, a different mock).
  const original = await readDiskViaWorkspace(context, filePath);

  // Syntax guard — the same invariant edit_file enforces: never write source
  // that does not parse. Live v0.119 dogfood: asked to add a JSDoc comment,
  // llama3.2 sidestepped edit_file entirely and called write_file with
  // `@tsdoc \n\nfunction welcome(name: string): string {…` — dropping `export`,
  // writing a non-comment, and clobbering a clean file with unparseable source.
  // Every corruption defence lived in edit_file, so this sailed through and
  // reported success. An absent file reads as empty, which parses clean, so the
  // same rule covers creation. Fails open when no grammar applies (md, json…).
  const syntax = await editWouldBreakSyntax(filePath, original ?? '', content);
  let escapeRecoveryNote = '';
  if (syntax.refuse) {
    // Code-as-text recovery: content serialized with literal \n escapes
    // (llama3.2's signature failure) decodes to valid source — apply the
    // decoded variant only when the parse gate proves it, and disclose.
    const recovered =
      context?.config?.codeAsTextRecoveryEnabled === true
        ? await tryLiteralEscapeRecovery(filePath, original ?? '', content)
        : null;
    if (recovered === null) {
      throw new Error(
        (syntax.message ?? '').replace('edit_file refused this edit to', 'write_file refused this write to') +
          `\n\nTo change part of a file, prefer edit_file(path, search, replace) — it edits in place instead of ` +
          `replacing the whole file.`,
      );
    }
    content = recovered;
    escapeRecoveryNote =
      `\n[note: your content contained literal \\n escape sequences where line breaks belong. They were ` +
      `decoded to real newlines and the decoded file parses cleanly. Send content with real line breaks, ` +
      `not \\n escapes.]`;
  }

  if (context?.editTimeline && !context.cwd) {
    context.editTimeline.record(filePath, original, content);
  }

  await workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf-8'));
  context?.workspaceIndex?.invalidateFile(filePath);

  if (context?.onOutput) {
    const patch = computeLineDiff(original ?? '', content, filePath);
    if (patch) context.onOutput(DIFF_PREFIX + patch);
  }

  return `File written: ${filePath}` + escapeRecoveryNote;
}

/**
 * Split a fused anchor+content insertion: the longest leading run of full
 * lines that appears verbatim in the file is the anchor; the rest (non-empty)
 * is the content to insert. Null when no split works — the caller keeps its
 * normal missing-search error. Pure; exported for tests.
 */
export function splitFusedAnchor(fileText: string, insertion: string): { anchor: string; remainder: string } | null {
  const lines = insertion.split('\n');
  for (let k = lines.length - 1; k >= 1; k--) {
    const anchor = lines.slice(0, k).join('\n');
    if (anchor.trim() === '' || !fileText.includes(anchor)) continue;
    const remainder = lines.slice(k).join('\n');
    if (remainder.trim() === '') return null; // pure anchor echo — nothing to insert
    return { anchor, remainder };
  }
  return null;
}

/**
 * Directive error for `search: ""`. The old path fell through to the
 * multiple-match branch — an empty string "appears" at every character, so the
 * model was told "search appears 69 times, add more surrounding context",
 * which is unactionable when there is no string to add context to. Observed
 * as qwen2.5-coder's and llama3.2's standard add-code move on the calculator
 * session: search="" + the new functions in replace. Name the two calls that
 * actually do what they want.
 */
function emptySearchError(filePath: string): string {
  return (
    `Error: edit_file failed — 'search' is empty. edit_file replaces an EXACT existing string, so 'search' must ` +
    `contain the current text you want to replace. The file was NOT modified. To ADD new code instead: call ` +
    `edit_file(path="${filePath}", search=<an existing line to anchor on, copied verbatim>, insert_after=<the new ` +
    `code>), or write_file(path="${filePath}", content=<the COMPLETE file including your new code>).`
  );
}

export async function editFile(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const filePath = input.path as string;
  const pathError = validateFilePath(filePath);
  if (pathError) throw new Error(pathError);
  const protectedError = isProtectedWritePath(filePath);
  if (protectedError) return protectedError;
  if (isSensitiveFile(filePath)) {
    throw new Error(
      `Error: "${filePath}" appears to contain secrets or credentials. The agent is not permitted to edit this file.`,
    );
  }
  const search = typeof input.search === 'string' ? (input.search as string) : undefined;
  const rawReplace = typeof input.replace === 'string' ? (input.replace as string) : undefined;
  const insertBefore = typeof input.insert_before === 'string' ? (input.insert_before as string) : undefined;
  const insertAfter = typeof input.insert_after === 'string' ? (input.insert_after as string) : undefined;

  // INSERTION, normalized into the replace machinery.
  //
  // edit_file inherited pure SEARCH/REPLACE from the diff-edit convention.
  // Insertion is expressible in it — anchor in `search`, "new text + the anchor
  // restated" in `replace` — but that encoding is exactly what weak models fail:
  // asked to add a JSDoc comment they send only the comment in `replace`, which
  // MEANS "delete the function and put a comment there" (live v0.119: qwen2.5-coder
  // and llama3.2 both failed the task this way). Adding text is one of the
  // commonest edits there is, so it gets a first-class form. Rewriting it into
  // search/replace here keeps every guard — uniqueness, token boundaries,
  // structural balance, syntax — applying unchanged.
  const newTextArg = typeof input.new_text === 'string' ? (input.new_text as string) : undefined;
  const insertion = insertBefore ?? insertAfter;
  if (newTextArg !== undefined && insertion === undefined) {
    throw new Error(
      `Error: edit_file received 'new_text' with no position. Put the EXISTING text to insert next to in ` +
        `'insert_after' (or 'insert_before'), and the new code in 'new_text'.`,
    );
  }
  if (insertion !== undefined) {
    if (rawReplace !== undefined) {
      throw new Error(
        `Error: edit_file received both 'replace' and an insert argument. Use 'replace' to SUBSTITUTE text, ` +
          `or 'insert_before'/'insert_after' to ADD text — not both.`,
      );
    }
    if (insertBefore !== undefined && insertAfter !== undefined) {
      throw new Error(`Error: edit_file received both 'insert_before' and 'insert_after'. Use one.`);
    }
    // V2 CONVENTION (insert-API redesign): `insert_after`/`insert_before` hold
    // the EXISTING anchor — the plain-English reading of the field name — and
    // `new_text` holds the code to add. Accepted unconditionally (the flag
    // only controls which convention the schema TEACHES), so both V1 and V2
    // emissions dispatch deterministically:
    //   insert_* + new_text            → V2: anchor = insert_*, payload = new_text
    //   insert_* + search (no new_text) → V1: anchor = search,  payload = insert_*
    //   insert_* alone                  → recovery / teaching errors below
    if (newTextArg !== undefined) {
      const anchor = insertion;
      const joined = insertBefore !== undefined ? `${newTextArg}\n${anchor}` : `${anchor}\n${newTextArg}`;
      if (newTextArg.trim() === '') {
        throw new Error(`Error: 'new_text' is empty — there is nothing to add.`);
      }
      if (newTextArg.trim() === anchor.trim()) {
        throw new Error(
          `Error: 'new_text' is identical to your anchor — you repeated the existing text instead of giving the ` +
            `NEW code to add. Put ONLY the new code in 'new_text'.`,
        );
      }
      return editFile({ path: filePath, search: anchor, replace: joined }, context);
    }
    if (search === undefined) {
      const currentText = isAuditModeActive(context)
        ? (getDefaultAuditBuffer().read(filePath).content ?? (await readDiskViaWorkspace(context, filePath)) ?? '')
        : ((await readDiskViaWorkspace(context, filePath)) ?? '');
      // FUSED-ANCHOR RECOVERY (code-as-text package). qwen2.5-coder's insert
      // move on the calculator session: everything in `insert_after`, no
      // `search` — and the value STARTS with the existing anchor block
      // (`def subtract…` verbatim) followed by the new code. The longest
      // leading line-prefix that appears verbatim in the file IS the anchor;
      // the remainder is the insertion. Split, dispatch, disclose. The inner
      // editFile still enforces anchor uniqueness and the syntax guard.
      if (insertAfter !== undefined && context?.config?.codeAsTextRecoveryEnabled === true) {
        const split = splitFusedAnchor(currentText, insertAfter);
        if (split) {
          return editFile({ path: filePath, search: split.anchor, insert_after: split.remainder }, context).then(
            (r) =>
              `[note: 'search' was missing and your 'insert_after' began with text already in the file. That ` +
              `leading text was used as the anchor and only the remainder was inserted after it. Pass the anchor ` +
              `in 'search' and ONLY the new code in 'insert_after'.]\n${r}`,
          );
        }
      }
      // POSITION-NOT-PAYLOAD teaching error. gemma4 reads `insert_after` as
      // plain English — "insert after THIS TEXT" — and sends the ANCHOR in it
      // with the new code nowhere (campaign 3/4: `insert_after: "    return
      // a - b"`, six identical bounces per run on the generic error). When the
      // value exists VERBATIM in the file we know exactly which misreading
      // happened; name it, instead of implying the payload was fine.
      if (insertion.trim() !== '' && currentText.includes(insertion.trim())) {
        const which = insertBefore !== undefined ? 'insert_before' : 'insert_after';
        // Under the V2 teaching this emission is HALF RIGHT — the anchor is in
        // the right field, only the payload is missing. Ask for exactly that.
        if (context?.config?.insertApiV2Enabled === true) {
          throw new Error(
            `Error: '${which}' names the position, but there is no new code to add — pass it in 'new_text'. ` +
              `Resend as: edit_file(path="${filePath}", ${which}=<that same existing text>, new_text=<the NEW ` +
              `code to add>). The file was NOT modified.`,
          );
        }
        throw new Error(
          `Error: your '${which}' value is text that is ALREADY IN ${filePath} — you gave the position, but not ` +
            `the new code. '${which}' must contain the NEW text to add; the existing text it goes ` +
            `${insertBefore !== undefined ? 'before' : 'after'} belongs in 'search'. Resend as: ` +
            `edit_file(path="${filePath}", search=<that existing text>, ${which}=<the NEW code to add>). ` +
            `The file was NOT modified.`,
        );
      }
      if (context?.config?.insertApiV2Enabled === true) {
        const which = insertBefore !== undefined ? 'insert_before' : 'insert_after';
        throw new Error(
          `Error: edit_file's '${which}' must be EXISTING text from ${filePath} (the anchor to insert ` +
            `${insertBefore !== undefined ? 'before' : 'after'}), and your value is not in the file. Put the ` +
            `anchor in '${which}' and the NEW code in 'new_text'. Call read_file(path="${filePath}") and copy ` +
            `the anchor verbatim.`,
        );
      }
      throw new Error(
        `Error: edit_file needs 'search' — the existing text to insert ${insertBefore !== undefined ? 'before' : 'after'} — ` +
          `alongside '${insertBefore !== undefined ? 'insert_before' : 'insert_after'}'. Call read_file(path="${filePath}") ` +
          `and copy the anchor text verbatim into 'search'.`,
      );
    }
    const whichInsert = insertBefore !== undefined ? 'insert_before' : 'insert_after';
    // API-INVERSION GUARD. Weak models read `insert_after: X` as "insert after X"
    // and put the ANCHOR in it instead of the NEW text — so the insert equals the
    // search. The naive encoding below then becomes `search\nsearch`, which
    // DUPLICATES the anchor and reports success: gemma4 did exactly this on a
    // calculator build (inserted a second `subtract`, never added the requested
    // functions, then declared success). Catch the inversion and say what went
    // wrong instead of silently duplicating.
    if (insertion.trim() === search.trim()) {
      throw new Error(
        `Error: your '${whichInsert}' text is identical to your 'search' anchor — you repeated the anchor instead ` +
          `of giving the NEW text to add. Put ONLY the new code in '${whichInsert}'; the existing anchor stays in ` +
          `'search'. Example — to add a function after an existing one: ` +
          `search="def subtract(a, b):\\n    return a - b", ${whichInsert}="def multiply(a, b):\\n    return a * b".`,
      );
    }
    // An empty insert is a no-op that would also report success — reject it.
    if (insertion.trim() === '') {
      throw new Error(
        `Error: '${whichInsert}' is empty — there is nothing to add. Put the new text to insert in '${whichInsert}'.`,
      );
    }
    const joined = insertBefore !== undefined ? `${insertBefore}\n${search}` : `${search}\n${insertAfter as string}`;
    return editFile({ path: filePath, search, replace: joined }, context);
  }

  const replace = rawReplace;

  // Creation-intent coercion. Small models constantly call edit_file with
  // one of search/replace missing on a file that doesn't exist yet — the
  // content they want is sitting in whichever field they filled (observed
  // live: edit_file({path: 'out/f1.md', search: 'k4q9-alpha'}) for the task
  // "create f1 containing k4q9-alpha"). Teaching errors measured 1 recovery
  // in 41 bounces, so on a NONEXISTENT file the call is executed as a
  // write_file with a loud disclosure. On an existing file the missing
  // field stays a hard error — there the intent really is ambiguous.
  if (search === undefined || replace === undefined) {
    if (search === undefined && replace === undefined) {
      throw new Error(
        `Error: edit_file requires 'search' (the current text in the file) and 'replace' (the new text). ` +
          `To CREATE a new file, use write_file(path="${filePath}", content="...").`,
      );
    }
    let fileExists: boolean;
    if (isAuditModeActive(context)) {
      const bufState = getDefaultAuditBuffer().read(filePath);
      fileExists = bufState.buffered
        ? !bufState.deleted
        : (await readDiskViaWorkspace(context, filePath)) !== undefined;
    } else {
      fileExists = (await readDiskViaWorkspace(context, filePath)) !== undefined;
    }
    if (!fileExists) {
      const filled = replace !== undefined ? 'replace' : 'search';
      const content = replace ?? search ?? '';
      const note =
        `[note: ${filePath} did not exist — edit_file cannot edit it, so the '${filled}' text was written as ` +
        `the full content of a NEW file. To create files, call write_file(path, content) directly.]\n`;
      return note + (await writeFile({ path: filePath, content }, context));
    }
    // MISSING SEARCH, PRESENT REPLACE — infer the target region.
    //
    // Live v0.119 dogfood: asked to add a JSDoc comment, llama3.2 sent
    // edit_file with only `replace` (the complete new text) NINE times in a
    // row. It read the file three times in between and still never produced a
    // `search` field — telling it to "copy the exact text into search" simply
    // does not land on this model class. The intent, though, is unambiguous:
    // it wants the region that `replace` supersedes to become `replace`.
    //
    // So infer it, exactly as the search-not-found path does, and let the
    // structural + syntax guards decide whether the result is safe. That keeps
    // the deterministic-recovery contract (paramRemap / toolNameAlias): a
    // wrong-but-unambiguous call is executed and the correction is disclosed,
    // rather than bounced into a loop. When inference is unsafe or impossible,
    // the error now hands the model the EXACT text to use as `search`.
    if (search === undefined && replace !== undefined) {
      const currentText = isAuditModeActive(context)
        ? (getDefaultAuditBuffer().read(filePath).content ?? (await readDiskViaWorkspace(context, filePath)) ?? '')
        : ((await readDiskViaWorkspace(context, filePath)) ?? '');

      const target = findIntentTarget(currentText, replace, 0.4, APPLY_MARGIN);
      if (target && currentText.includes(target) && target !== replace) {
        if (isStructurallySafeReplacement(filePath, target, replace)) {
          const inferred = currentText.replace(target, () => replace);
          const syntax = await editWouldBreakSyntax(filePath, currentText, inferred);
          if (!syntax.refuse) {
            return await editFile({ path: filePath, search: target, replace }, context).then(
              (r) =>
                `[note: 'search' was missing. The region your 'replace' text supersedes was inferred and used as ` +
                `the search string. Always pass 'search' explicitly — it is the exact current text to replace.]\n${r}`,
            );
          }
        }

        // INSERTION intent. edit_file only replaces, but models routinely use it
        // to ADD something — "add a JSDoc comment above welcome" — by sending
        // only the new text in `replace`. Replacing the target with it then
        // destroys the target (the comment would eat the function header), which
        // the syntax guard correctly refuses, and the task fails with the file
        // untouched (live v0.119: qwen2.5-coder, three attempts, no JSDoc).
        //
        // If the replacement cannot stand in for the target but CAN sit in front
        // of it and still parse, that is what the model meant. Try it, and
        // disclose that it was treated as an insertion.
        if (!replace.includes(target)) {
          const insertion = currentText.replace(target, () => `${replace}\n${target}`);
          const insertSyntax = await editWouldBreakSyntax(filePath, currentText, insertion);
          if (!insertSyntax.refuse && insertion !== currentText) {
            return await editFile({ path: filePath, search: target, replace: `${replace}\n${target}` }, context).then(
              (r) =>
                `[note: 'search' was missing, and your 'replace' text could not stand in for any existing ` +
                `region — so it was INSERTED immediately before the closest matching code instead of ` +
                `overwriting it. To insert deliberately, pass the existing text in 'search' and ` +
                `'<new text>\\n<existing text>' in 'replace'.]\n${r}`,
            );
          }
        }
      }

      // Not unambiguous enough to write. Hand over the best candidate region so
      // the model can resend with an exact `search` (a suggestion writes nothing,
      // so it is allowed a looser bar than an application).
      const suggestion = findIntentTarget(currentText, replace, 0.4, SUGGEST_MARGIN);
      const nearest = suggestion ?? findNearestMatchWide(currentText, replace, 25) ?? currentText.slice(0, 800);
      recordEditFailure(context, filePath, '', replace);
      throw new Error(
        `Error: edit_file requires 'search' — the EXACT text currently in ${filePath} that you want to replace. ` +
          `You sent only 'replace'.\n\n` +
          `Copy this into 'search' (it is the current text, byte-for-byte):\n\`\`\`\n${nearest}\n\`\`\`\n\n` +
          `Then put your new version in 'replace'. To rewrite the whole file instead, call ` +
          `write_file(path="${filePath}", content="…").`,
      );
    }

    const missing = search === undefined ? 'search' : 'replace';
    throw new Error(
      `Error: edit_file on an existing file requires both 'search' (the current text) and 'replace' (the new text); ` +
        `'${missing}' is missing. Call read_file(path="${filePath}") and copy the exact text you want to change into 'search'.`,
    );
  }

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
    // search === replace: the model put the NEW text in both fields. Suggest the
    // region it most likely meant; never guess-and-write (see suggestRegionError).
    if (currentContent) {
      const intentTarget = findIntentTarget(currentContent, search);
      if (intentTarget && currentContent.includes(intentTarget) && intentTarget !== search) {
        recordEditFailure(context, filePath, search, replace);
        throw new Error(
          suggestRegionError(
            filePath,
            intentTarget,
            `'search' and 'replace' are identical, so there is no change to make — 'search' must be the text ` +
              `CURRENTLY in the file and 'replace' the new version`,
          ),
        );
      }
    }
    const failureCount = recordEditFailure(context, filePath, search, replace);
    if (failureCount >= 2) {
      // search === replace carries NO information about the intended change
      // (both fields are identical) — unlike the search-not-found case below,
      // there's no candidate content to retry a looser auto-repair against.
      // The only lever left is a MORE PRECISE hint: prefer an exact-line-number
      // grep hit over the fuzzy nearest-match block, since the model has
      // already ignored the fuzzy block once (or twice).
      const preciseHint = currentContent ? buildGrepHint(currentContent, search) : null;
      throw new Error(
        `Error: edit_file failed AGAIN — you resubmitted the EXACT SAME search and replace text as your ` +
          `last call to ${filePath}, which failed for the same reason${failureCount > 2 ? ` (attempt ${failureCount})` : ''}. ` +
          `Repeating an identical call will never work. You MUST change your approach: (1) call read_file on ` +
          `${filePath} right now, (2) copy the CURRENT text you want to change into search VERBATIM, and ` +
          `(3) write your DIFFERENT intended new text into replace. search and replace must not be the same string.` +
          `\n${preciseHint ?? hint}`,
      );
    }
    throw new Error(
      `Error: edit_file failed — search and replace text are identical; no change would be made.\n${hint}`,
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
      if (bufState.deleted)
        throw new Error(`Error: File not found in buffer (${filePath}) — was deleted earlier this session.`);
      // In the buffered + not-deleted branch, `content` is always a
      // string (AuditBuffer only emits `content: undefined` for the
      // deleted op), but the type system can't infer that from the
      // struct shape alone — default to empty string defensively.
      currentText = bufState.content ?? '';
    } else {
      const diskText = await readDiskViaWorkspace(context, filePath);
      if (diskText === undefined) {
        throw new Error(
          `Error: ${filePath} does not exist, so it cannot be edited. ` +
            `To CREATE a new file, call write_file(path="${filePath}", content="...") with the full desired content. ` +
            `Use edit_file only to change files that already exist.`,
        );
      }
      currentText = diskText;
    }
    const resolvedAudit = await resolveEditedText({ filePath, text: currentText, search, replace, context });
    if (resolvedAudit.newText === null) return resolvedAudit.message;
    const auditPatch = computeLineDiff(currentText, resolvedAudit.newText, filePath);
    await buf.write(filePath, resolvedAudit.newText, (p) => readDiskViaWorkspace(context, p));
    getAuditDecorationProvider()?.refresh();
    clearEditFailure(context, filePath);
    const auditLine =
      resolvedAudit.summary ?? `File edited: ${filePath} (buffered for audit review)${partialReplaceWarning}`;
    return `${resolvedAudit.prefixNote}${auditLine}${resolvedAudit.suffixNote}${editDiffSuffix(auditPatch, context)}`;
  }

  const fileUri = Uri.joinPath(resolveRootUri(context), filePath);
  let bytes: Uint8Array;
  try {
    bytes = await workspace.fs.readFile(fileUri);
  } catch (err: unknown) {
    const isNotFound =
      err instanceof Error && (err.message.includes('ENOENT') || (err as { code?: string }).code === 'FileNotFound');
    if (!isNotFound) throw err;
    // The #1 small-model failure on file CREATION: edit_file on a path that
    // doesn't exist yet. The raw ENOENT gave no recovery route (observed
    // live: llama3.2 looped edit→ENOENT→search for 24 iterations, never
    // discovering write_file). Name the fix explicitly.
    throw new Error(
      `Error: ${filePath} does not exist, so it cannot be edited. ` +
        `To CREATE a new file, call write_file(path="${filePath}", content="...") with the full desired content. ` +
        `Use edit_file only to change files that already exist.`,
    );
  }
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

  const resolved = await resolveEditedText({ filePath, text, search, replace, unreadPrefix, context });
  if (resolved.newText === null) return resolved.message;
  const newText = resolved.newText;

  const patch = computeLineDiff(text, newText, filePath);
  if (context?.onOutput && patch) context.onOutput(DIFF_PREFIX + patch);
  clearEditFailure(context, filePath);

  // Record to edit timeline before overwriting.
  // Skip when cwd is set (shadow workspace).
  if (context?.editTimeline && !context.cwd) {
    context.editTimeline.record(filePath, text, newText);
  }

  await workspace.fs.writeFile(fileUri, Buffer.from(newText, 'utf-8'));
  context?.workspaceIndex?.invalidateFile(filePath);
  // NO unreadPrefix on success. That prefix is corrective guidance for a FAILED
  // edit — "[You have not read this file… use the exact text from above as your
  // search string — it must match byte-for-byte]" — and gluing it onto a
  // successful edit reads as "something is wrong, fix your search string". Live
  // v0.119 dogfood: the rename landed on iteration 1, the success message
  // carried this preamble, and the model dutifully re-read the file and
  // re-issued the same edit. The edit worked; only the message said otherwise.
  //
  // OUTCOME-VISIBILITY (flagged, default off). "File edited: <path>" tells the
  // model nothing about WHAT changed, so it cannot tell a correct edit from a
  // wrong-but-applied one (gemma4 duplicated a function and read the same success
  // string as a model that did it right). Optionally append a BOUNDED diff so the
  // model can see — and self-verify — the outcome. Bounded because extra context
  // can overwhelm a weak model (LOCAL_MAX_SYSTEM_CHARS); the char cap is the config
  // value, and the A/B decides whether it helps or is just noise.
  const successLine = resolved.summary ?? `File edited: ${filePath}${partialReplaceWarning}`;
  return `${resolved.prefixNote}${successLine}${resolved.suffixNote}${editDiffSuffix(patch, context)}`;
}

/**
 * Outcome of resolving an edit against the current file text. `newText: null`
 * means the file is already in the requested state and nothing should be
 * written; otherwise `newText` is what the caller must persist.
 */
export type ResolvedEdit =
  | { newText: null; message: string }
  | { newText: string; summary?: string; prefixNote: string; suffixNote: string };

/**
 * The edit_file guard + repair core: given the CURRENT text of a file and a
 * search/replace pair, decide what the file should become. Every persistence
 * mode — disk, audit buffer, review-mode shadow store — routes through this, so
 * a guard added here protects all three. Historically each mode carried its own
 * `text.includes(search)` copy and the weaker copies silently corrupted files
 * (review mode's used the STRING form of String.replace, so a `$&` in the
 * replacement was interpreted as a regex reference).
 *
 * Throws the teaching errors. Returns `newText: null` when the file already
 * matches the requested outcome.
 */
export async function resolveEditedText(params: {
  filePath: string;
  text: string;
  search: string;
  replace: string;
  unreadPrefix?: string;
  context?: ToolExecutorContext;
}): Promise<ResolvedEdit> {
  const { filePath, text, search, replace, context } = params;
  const unreadPrefix = params.unreadPrefix ?? '';
  // Before matching: an empty search matches nothing, and the tolerance tiers
  // would report it as a plain miss. The model needs the directive error that
  // names insert_after / write_file instead.
  if (search === '') {
    throw new Error(`${unreadPrefix}${emptySearchError(filePath)}`);
  }
  // Byte-exact first, then the whitespace tiers (line endings, trailing
  // whitespace, indentation). They resolve to a real byte span, so every guard
  // below still runs against real file bytes — and they run BEFORE the
  // intent-based fuzzy recovery, which guesses at the region from word overlap
  // and is far less certain than "the same text with different line endings".
  const match = findEditMatch(text, search, replace);
  if (!match) {
    // Already applied? The rename the model is retrying may have LANDED on an
    // earlier iteration — the old tokens are gone, the new ones are present.
    // Saying "search string not found" there is true but useless, and it drove
    // a live edit loop until cycle detection bailed. Say what is actually true.
    if (isEditAlreadyApplied(text, search, replace)) {
      clearEditFailure(context, filePath);
      const applied =
        `No change needed: ${filePath} already contains the result of this edit. The text you searched for is ` +
        `gone and your replacement is already present — this change was applied earlier, so the file is ` +
        `already in the state you want.\n\nDo NOT repeat this edit. If the overall task is complete, say so ` +
        `and finish; if other files still need changing, move on to those.`;
      return { newText: null, message: applied };
    }

    // The model's `search` did not match. Two tiers, both measured against 1,700
    // real edits:
    //
    //   APPLY   — only when the match is UNAMBIGUOUS (beats the runner-up by
    //             APPLY_MARGIN distinctive words). Zero wrong regions at that bar.
    //   SUGGEST — otherwise, hand the candidate region to the model to copy into
    //             `search`, and write nothing. A wrong region that happens to
    //             parse is silent corruption the syntax guard cannot see, so a
    //             merely-plausible guess never touches disk.
    const applyTarget = findIntentTarget(text, replace, 0.4, APPLY_MARGIN);
    if (applyTarget && text.includes(applyTarget) && applyTarget !== replace) {
      // Splice by offset with the replacement in the file's line endings — the
      // string form of String.replace would expand `$&`/`$1` in model text, and
      // an LF replacement dropped into a CRLF file leaves mixed endings.
      const at = text.indexOf(applyTarget);
      const inferredText =
        text.slice(0, at) + applyEol(replace, detectEol(text).eol) + text.slice(at + applyTarget.length);
      const inferSyntax = await editWouldBreakSyntax(filePath, text, inferredText);
      if (!inferSyntax.refuse) {
        return {
          newText: inferredText,
          summary:
            `Applied inferred edit to ${filePath}: your 'search' text did not match, but exactly one region ` +
            `unambiguously corresponds to your replacement, so it was used.\n` +
            `Replaced:\n\`\`\`\n${applyTarget}\n\`\`\`\nWith:\n\`\`\`\n${replace}\n\`\`\`\n` +
            `Pass 'search' explicitly next time — it is the exact current text to replace.`,
          prefixNote: '',
          suffixNote: '',
        };
      }
    }

    const suggestTarget = findIntentTarget(text, replace, 0.4, SUGGEST_MARGIN);
    if (suggestTarget && text.includes(suggestTarget) && suggestTarget !== replace) {
      recordEditFailure(context, filePath, search, replace);
      throw new Error(
        `${unreadPrefix}` +
          suggestRegionError(filePath, suggestTarget, `your 'search' text does not appear in the file`),
      );
    }

    const failureCount = recordEditFailure(context, filePath, search, replace);
    // Third+ identical failure: findIntentTarget already ran above at the
    // default confidence and either found nothing or found `replace` itself
    // (a no-op) — both dead ends at that threshold. Retry looser rather than
    // just repeating the same hint a model has already ignored twice.
    if (failureCount >= 3) {
      // A LOW-confidence fuzzy match (0.2) writing to disk after repeated
      // failures was the weakest guess in the tool. The matcher is wrong
      // about the region 30% of the time it commits at ANY threshold, so
      // this now suggests the region instead of rewriting it.
      const looseTarget = findIntentTarget(text, replace, 0.2);
      if (looseTarget && text.includes(looseTarget) && looseTarget !== replace) {
        throw new Error(
          suggestRegionError(
            filePath,
            looseTarget,
            `your 'search' text still does not appear in the file after ${failureCount} attempts`,
          ),
        );
      }
    }

    const grepHint2 = buildGrepHint(text, search) ?? buildGrepHint(text, replace);
    const nearest = findNearestMatch(text, search);
    const hint = grepHint2
      ? `\n\n${grepHint2.replace('<file>', filePath)}`
      : nearest
        ? `\n\nNearest matching region in the file (use this as your search string):\n\`\`\`\n${nearest}\n\`\`\``
        : '\n\nCall read_file to see the exact current content.';
    if (failureCount >= 2) {
      throw new Error(
        `${unreadPrefix}Error: edit_file failed AGAIN — you resubmitted the EXACT SAME search and replace ` +
          `text as your last call to ${filePath}, which failed for the same reason. Repeating an identical call ` +
          `will never work. You MUST call read_file on ${filePath} right now and copy the CURRENT text VERBATIM ` +
          `into search.${hint}`,
      );
    }
    throw new Error(
      `${unreadPrefix}Error: edit_file failed — search string not found in ${filePath}. The file was NOT modified.${hint}`,
    );
  }
  if (match.count > 1) {
    // Ambiguity is counted at the tier that matched: if the search is unique
    // byte-for-byte it is unique, full stop, even when a laxer tier would have
    // found siblings. Only a search that NEEDED the tolerance is judged by it.
    const where = match.tier === 'exact' ? '' : ` (ignoring ${TIER_LABEL[match.tier]})`;
    throw new Error(
      `${unreadPrefix}Error: edit_file failed — search string appears ${match.count} times in ${filePath}${where}. The file was NOT modified. Add more surrounding context to your search string to make it unique, then retry.`,
    );
  }

  // Token-boundary guard. An exact substring match still corrupts the file when
  // the search string starts or ends in the MIDDLE of an identifier, because
  // the splice cuts a token in half. Live v0.119 dogfood corruption: the model
  // searched `greet(name: string): s` (ending inside `string`) and replaced it
  // with `welcome(name: string)`, leaving `export function welcome(name: string)tring): string {`.
  // Bracket balance was preserved, so the structural guard could not see it —
  // the defect is lexical, not structural. Requiring the match to align with
  // token boundaries also blocks the classic rename hazard (search `greet`
  // silently mangling `greeting`).
  const isWordChar = (c: string | undefined) => c !== undefined && /\w/.test(c);
  const matchStart = match.start;
  const matchEnd = match.end;
  const matchedText = text.slice(matchStart, matchEnd);
  const splitsStart = isWordChar(text[matchStart - 1]) && isWordChar(matchedText[0]);
  const splitsEnd = isWordChar(matchedText[matchedText.length - 1]) && isWordChar(text[matchEnd]);
  if (splitsStart || splitsEnd) {
    recordEditFailure(context, filePath, search, replace);
    const edge = splitsStart && splitsEnd ? 'starts and ends' : splitsStart ? 'starts' : 'ends';
    const context40 = text.slice(Math.max(0, matchStart - 20), Math.min(text.length, matchEnd + 20));
    throw new Error(
      `Error: edit_file refused this edit to ${filePath} — the search string ${edge} in the middle of a ` +
        `word, so replacing it would splice into a token and corrupt the file. The file was NOT modified.\n\n` +
        `Your search matched here:\n\`\`\`\n${context40}\n\`\`\`\n\n` +
        `Extend your search string to whole tokens (start and end at a word boundary — include the complete ` +
        `identifier, and ideally the full line or block you intend to change), then retry.`,
    );
  }

  // Splice by SPAN, never by String.replace: the span is what the tolerance
  // tiers resolved, and slicing keeps `$&`-style sequences in the replacement
  // as literal text.
  const splice = (withText: string) => text.slice(0, matchStart) + withText + text.slice(matchEnd);
  const replacement = match.replacement;
  const rawNewText = splice(replacement);

  // Syntax guard — the general invariant behind the structural and lexical
  // guards above: an edit must not make a parsing file stop parsing. Catches
  // what the cheaper rules cannot, e.g. a model sending regex-ESCAPED source
  // (`function welcome\(name: s\)`) — balanced, token-aligned, and complete
  // garbage (live v0.119 dogfood, llama3.2). Fails open when no grammar
  // applies, so unsupported languages behave exactly as before.
  let newText = rawNewText;
  let duplicateTrimNote = '';

  // DUPLICATED-TAIL REPAIR. A very common weak-model mistake: `search` names the
  // block HEADER but `replace` restates the whole block — header AND body —
  // because the model is thinking "here is what the code should look like".
  // Substituting then duplicates the body and the file stops parsing.
  //
  // Live v0.119, qwen2.5-coder adding a JSDoc comment:
  //   search  = "export function welcome(name: string): string {"
  //   replace = "/** … */\nexport function welcome(…): string {\n  return …;\n}"
  // The trailing part of `replace` after the search text is EXACTLY the text
  // that already follows the match in the file, so it is provably redundant.
  // Trim it and the edit is precisely what the model meant: an insertion.
  const searchIdxInReplace = replacement.indexOf(matchedText);
  if (searchIdxInReplace !== -1) {
    const trailing = replacement.slice(searchIdxInReplace + matchedText.length);
    const afterMatch = text.slice(matchEnd);
    if (trailing.length > 0 && afterMatch.startsWith(trailing)) {
      const trimmedReplace = replacement.slice(0, searchIdxInReplace + matchedText.length);
      const trimmedText = splice(trimmedReplace);
      const trimmedSyntax = await editWouldBreakSyntax(filePath, text, trimmedText);
      const originalSyntax = await editWouldBreakSyntax(filePath, text, rawNewText);
      // Only rewrite when the trim actually rescues the edit — never silently
      // change an edit that was already fine.
      if (originalSyntax.refuse && !trimmedSyntax.refuse) {
        newText = trimmedText;
        duplicateTrimNote =
          `[note: your 'replace' restated text that already follows the match (the block body), which would ` +
          `have duplicated it. The redundant tail was trimmed and the edit applied as an insertion. To ADD ` +
          `text, prefer edit_file(search=<anchor>, insert_before=<new text>).]\n`;
      }
    }
  }

  const syntax = await editWouldBreakSyntax(filePath, text, newText);
  let escapeRecoveryNote = '';
  if (syntax.refuse) {
    // Same code-as-text escape recovery as write_file — the replace text
    // arrived as an escaped string (`def multiply(a, b):\n    return a * b`
    // with literal backslash-n). Decode, and keep it only if the parse gate
    // proves the decode fixed the file.
    const recovered =
      context?.config?.codeAsTextRecoveryEnabled === true
        ? await tryLiteralEscapeRecovery(filePath, text, newText)
        : null;
    if (recovered === null) {
      recordEditFailure(context, filePath, search, replace);
      throw new Error(`${unreadPrefix}${syntax.message}`);
    }
    newText = recovered;
    escapeRecoveryNote =
      `\n[note: your replace text contained literal \\n escape sequences where line breaks belong. They were ` +
      `decoded to real newlines and the decoded file parses cleanly. Send replace text with real line breaks, ` +
      `not \\n escapes.]`;
  }

  return {
    newText,
    prefixNote: matchToleranceNote(match, filePath, text) + duplicateTrimNote,
    suffixNote: escapeRecoveryNote,
  };
}

/** How a tier's tolerance reads in an ambiguity error. */
const TIER_LABEL: Record<MatchTier, string> = {
  exact: '',
  eol: 'line-ending differences',
  'trailing-space': 'trailing whitespace',
  indent: 'indentation',
};

/**
 * A capped diff to append to a successful edit_file result, or '' when disabled.
 * Gated by `editFile.resultDiffChars` (0 = off) so the outcome-visibility change is
 * measurable as an A/B rather than shipped on a guess. Truncates on a line boundary
 * so the model never sees a half-line of diff.
 */
export function editDiffSuffix(patch: string | null, context?: ToolExecutorContext): string {
  const cap = context?.config?.editResultDiffChars ?? 0;
  if (cap <= 0 || !patch) return '';
  let shown = patch;
  if (patch.length > cap) {
    const cut = patch.lastIndexOf('\n', cap);
    shown = patch.slice(0, cut > 0 ? cut : cap) + '\n… (diff truncated)';
  }
  return `\nWhat changed (verify this is what you intended):\n${shown}`;
}

export async function deleteFile(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const filePath = input.path as string;
  const pathError = validateFilePath(filePath);
  if (pathError) throw new Error(pathError);
  const protectedError = isProtectedWritePath(filePath);
  if (protectedError) return protectedError;
  if (isSensitiveFile(filePath)) {
    throw new Error(
      `Error: "${filePath}" appears to contain secrets or credentials. The agent is not permitted to delete this file.`,
    );
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
    if (pathError) throw new Error(pathError);
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
