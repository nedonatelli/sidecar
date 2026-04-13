/**
 * Pure analyzer for detecting stale JSDoc parameter tags in TypeScript / JavaScript
 * source files. No VS Code imports — consumed by jsDocSyncProvider, which wires
 * these findings into a DiagnosticCollection + CodeActionProvider.
 *
 * Scope (deliberately conservative for the MVP):
 *   - Top-level functions:   function foo(...), async function foo(...)
 *   - const/let/var arrows:  const foo = (...) =>, const foo = async (...) =>
 *   - Optional `export` prefix on any of the above.
 *   - Skips class methods, getters/setters, object-literal methods, and
 *     functions whose parameter list includes destructured or rest params —
 *     those either need an AST to detect reliably or have no obvious JSDoc
 *     rename semantics.
 */

/** One detected function + its leading JSDoc block (if any). */
export interface DocumentedFunction {
  /** Function name as declared in source. */
  name: string;
  /** 0-based line index where the declaration starts. */
  declLine: number;
  /** Parameter names in declaration order. Empty if no params. */
  paramNames: string[];
  /** True if the parameter list contained a destructured or rest param. */
  hasDestructuredOrRest: boolean;
  /** Start line of the `/**` opener, or null if no JSDoc precedes the function. */
  jsDocStartLine: number | null;
  /** Line containing the `*\/` closer, or null if no JSDoc. */
  jsDocEndLine: number | null;
  /** Parameter-tag names inside the JSDoc, in source order. */
  jsDocParamNames: string[];
  /**
   * For each JSDoc parameter-tag entry, the 0-based source line that contains it.
   * Parallel array to `jsDocParamNames`. Used when generating quick-fix edits.
   */
  jsDocParamLines: number[];
}

/** A staleness finding for a single function. */
export interface StaleTagFinding {
  fn: DocumentedFunction;
  /** Tag names present in the JSDoc but missing from the signature. */
  orphanTags: string[];
  /** Signature parameters that have no matching JSDoc tag. */
  missingTags: string[];
}

// ---------------------------------------------------------------------------
// Parameter list parsing
// ---------------------------------------------------------------------------

/**
 * Split a string on top-level instances of `sep`, ignoring occurrences inside
 * balanced brackets (`()`, `[]`, `{}`, `<>`). Used to walk a parenthesized
 * parameter list where commas inside generic arguments or object types must
 * not split an entry.
 */
export function splitTopLevel(input: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let buf = '';
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '(' || ch === '[' || ch === '{' || ch === '<') depth++;
    else if (ch === ')' || ch === ']' || ch === '}' || ch === '>') depth--;
    if (ch === sep && depth === 0) {
      parts.push(buf);
      buf = '';
    } else {
      buf += ch;
    }
  }
  if (buf.length > 0 || parts.length > 0) parts.push(buf);
  return parts;
}

/**
 * Parse the contents of a `(...)` parameter list. Returns the simple named
 * parameters in order, and flags whether any destructured or rest parameter
 * was encountered (in which case the caller should skip diagnosing that
 * function — we can't confidently map destructured shapes onto JSDoc tags).
 */
export function parseParamList(paramList: string): { names: string[]; hasDestructuredOrRest: boolean } {
  const trimmed = paramList.trim();
  if (trimmed === '') return { names: [], hasDestructuredOrRest: false };

  const parts = splitTopLevel(trimmed, ',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const names: string[] = [];
  let hasDestructuredOrRest = false;

  for (const part of parts) {
    if (part.startsWith('...')) {
      hasDestructuredOrRest = true;
      continue;
    }
    if (part.startsWith('{') || part.startsWith('[')) {
      hasDestructuredOrRest = true;
      continue;
    }
    // Strip leading `this:` parameter (TS self-typing) so it isn't mistaken for a real param.
    if (/^this\s*:/.test(part)) continue;
    const m = part.match(/^(\w+)/);
    if (m) names.push(m[1]);
  }

  return { names, hasDestructuredOrRest };
}

// ---------------------------------------------------------------------------
// Paren-balanced content extraction
// ---------------------------------------------------------------------------

/**
 * Starting at `startLine` and column `startCol` (the position of the opening
 * `(` of a parameter list), return the text between the opener and its
 * matching closer, which may span multiple lines. Returns null if the parens
 * are unbalanced (malformed source).
 */
export function extractParenContent(
  lines: string[],
  startLine: number,
  startCol: number,
): { content: string; endLine: number } | null {
  let depth = 0;
  let content = '';
  let started = false;
  for (let line = startLine; line < lines.length; line++) {
    const text = line === startLine ? lines[line].slice(startCol) : lines[line];
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(') {
        if (started) content += ch;
        depth++;
        started = true;
      } else if (ch === ')') {
        depth--;
        if (depth === 0) return { content, endLine: line };
        content += ch;
      } else if (started) {
        content += ch;
      }
    }
    if (started && depth > 0) content += '\n';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Function declaration detection
// ---------------------------------------------------------------------------

/** Regex for the supported function declaration shapes. */
const FN_DECL_REGEX = /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(?:<[^>]*>)?\s*\(/;
const ARROW_DECL_REGEX = /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\(/;

/**
 * Try to recognize a supported function declaration starting at `startLine`.
 * Returns the function name and the absolute column position of the opening
 * `(` of its parameter list, or null if the line is not a recognized shape.
 */
export function matchFunctionDeclaration(
  lines: string[],
  startLine: number,
): { name: string; parenCol: number } | null {
  const line = lines[startLine];

  const fnMatch = line.match(FN_DECL_REGEX);
  if (fnMatch) {
    const parenCol = line.indexOf('(', fnMatch.index! + fnMatch[0].length - 1);
    if (parenCol >= 0) return { name: fnMatch[1], parenCol };
  }

  const arrowMatch = line.match(ARROW_DECL_REGEX);
  if (arrowMatch) {
    const parenCol = line.indexOf('(', arrowMatch.index! + arrowMatch[0].length - 1);
    if (parenCol >= 0) return { name: arrowMatch[1], parenCol };
  }

  return null;
}

// ---------------------------------------------------------------------------
// JSDoc block parsing
// ---------------------------------------------------------------------------

/**
 * Extract param tag entries from a JSDoc block. Handles both typed
 * (with a brace-wrapped type) and untyped forms. Returns each param name
 * with the 0-based source line (relative to the full file, not the JSDoc
 * block) where the tag appears — used to generate quick-fix text edits later.
 *
 * The regex deliberately requires the tag to appear at the start of a JSDoc
 * line (after optional indentation and the leading `*`). Mid-sentence
 * occurrences inside a descriptive comment are ignored — otherwise a docstring
 * that *mentions* the tag format as prose would get misparsed as a real tag.
 */
export function extractJsDocParams(
  lines: string[],
  jsDocStartLine: number,
  jsDocEndLine: number,
): { names: string[]; lineByName: number[] } {
  const names: string[] = [];
  const lineByName: number[] = [];
  const paramRegex = /^\s*\*\s*@param\s+(?:\{[^}]*\}\s+)?([\w$]+)/;
  for (let i = jsDocStartLine; i <= jsDocEndLine; i++) {
    const m = lines[i].match(paramRegex);
    if (m) {
      names.push(m[1]);
      lineByName.push(i);
    }
  }
  return { names, lineByName };
}

// ---------------------------------------------------------------------------
// Main analyzer
// ---------------------------------------------------------------------------

/**
 * Walk the source file and return every function preceded by a JSDoc block
 * that the MVP knows how to reason about. Functions without a leading JSDoc
 * are skipped — we don't diagnose missing docs, only stale ones.
 */
export function findDocumentedFunctions(source: string): DocumentedFunction[] {
  const lines = source.split('\n');
  const out: DocumentedFunction[] = [];

  let i = 0;
  while (i < lines.length) {
    const trimmed = lines[i].trimStart();
    if (!trimmed.startsWith('/**')) {
      i++;
      continue;
    }

    // Find the end of the JSDoc block.
    const jsDocStart = i;
    let jsDocEnd = i;
    if (trimmed.includes('*/')) {
      // Single-line JSDoc like /** ... */ — no @param possible, but we still
      // treat it as a JSDoc block so the downstream logic stays uniform.
      jsDocEnd = i;
    } else {
      let j = i + 1;
      while (j < lines.length && !lines[j].includes('*/')) j++;
      if (j >= lines.length) {
        i++;
        continue; // unterminated, skip
      }
      jsDocEnd = j;
    }

    // Find the next meaningful line (skip blanks and nested comments).
    let declLine = jsDocEnd + 1;
    while (declLine < lines.length && lines[declLine].trim() === '') declLine++;
    if (declLine >= lines.length) {
      i = jsDocEnd + 1;
      continue;
    }

    const decl = matchFunctionDeclaration(lines, declLine);
    if (!decl) {
      i = jsDocEnd + 1;
      continue;
    }

    const paren = extractParenContent(lines, declLine, decl.parenCol);
    if (!paren) {
      i = jsDocEnd + 1;
      continue;
    }

    const { names: paramNames, hasDestructuredOrRest } = parseParamList(paren.content);
    const { names: jsDocParamNames, lineByName: jsDocParamLines } = extractJsDocParams(lines, jsDocStart, jsDocEnd);

    out.push({
      name: decl.name,
      declLine,
      paramNames,
      hasDestructuredOrRest,
      jsDocStartLine: jsDocStart,
      jsDocEndLine: jsDocEnd,
      jsDocParamNames,
      jsDocParamLines,
    });

    i = paren.endLine + 1;
  }

  return out;
}

/**
 * For every documented function, compute the set difference between the
 * signature parameters and the JSDoc parameter tags. Returns only functions
 * that have at least one orphan or missing tag — clean functions are
 * excluded so callers can iterate directly to produce diagnostics.
 *
 * Functions with destructured or rest parameters are skipped entirely.
 */
export function detectStaleTags(fns: DocumentedFunction[]): StaleTagFinding[] {
  const findings: StaleTagFinding[] = [];
  for (const fn of fns) {
    if (fn.hasDestructuredOrRest) continue;
    if (fn.jsDocStartLine === null) continue;
    if (fn.jsDocParamNames.length === 0 && fn.paramNames.length === 0) continue;

    const sigSet = new Set(fn.paramNames);
    const docSet = new Set(fn.jsDocParamNames);

    const orphanTags = fn.jsDocParamNames.filter((n) => !sigSet.has(n));
    const missingTags = fn.paramNames.filter((n) => !docSet.has(n));

    // Only report if the doc block has at least one @param entry — otherwise
    // the dev may have intentionally omitted param docs and we shouldn't
    // pester them about adding tags from scratch.
    if (fn.jsDocParamNames.length === 0) continue;

    if (orphanTags.length === 0 && missingTags.length === 0) continue;
    findings.push({ fn, orphanTags, missingTags });
  }
  return findings;
}

/**
 * Top-level convenience: parse source, find documented functions, and return
 * staleness findings in a single call. Used by the VS Code provider on every
 * save of a TS / JS file.
 */
export function analyzeSource(source: string): StaleTagFinding[] {
  return detectStaleTags(findDocumentedFunctions(source));
}
