/**
 * Pure analyzer for detecting stale code examples in README.md files.
 *
 * A "stale" example is a fenced code block call expression that references
 * an exported workspace function with the wrong number of arguments. Type
 * mismatches, reordered parameters, and import-path drift are out of scope
 * for the MVP — arity is the one thing we can check cheaply and accurately
 * without a real parser.
 *
 * The analyzer is deliberately conservative:
 *   - Only fenced blocks tagged ts / tsx / js / jsx / typescript / javascript.
 *   - Only single-line call expressions with no nested parens in their args
 *     (catches the 80% case — multi-line or nested calls are skipped, not
 *     diagnosed).
 *   - Only top-level exported functions / arrow consts. No class methods,
 *     no re-exports, no default exports.
 *   - Functions with destructured or rest params are never flagged because
 *     arg counting can't reason about them reliably.
 *
 * No VS Code imports — consumed by readmeSyncProvider, which wires these
 * findings into a DiagnosticCollection + CodeActionProvider.
 */

import { splitTopLevel, parseParamList, extractParenContent, matchFunctionDeclaration } from './jsDocSync.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A fenced code block extracted from markdown source. */
export interface CodeBlock {
  /** Lowercased fence language tag (ts, tsx, js, jsx, typescript, javascript). */
  lang: string;
  /** 0-based line in the markdown file where the first line of code sits (after the opening fence). */
  startLine: number;
  /** 0-based line in the markdown file of the last line of code (before the closing fence). */
  endLine: number;
  /** Lines of code inside the block, in file order. */
  codeLines: string[];
}

/** A single call expression located inside a fenced code block. */
export interface CallExpression {
  /** The function name being called. */
  name: string;
  /** How many comma-separated arguments were passed at the top level. */
  argCount: number;
  /**
   * The comma-separated arguments as they appear in source, trimmed. Parallel
   * to argCount — a call with argCount === 0 has an empty array. Used by the
   * provider's quick-fix to reconstruct a new argument list.
   */
  args: string[];
  /** 0-based line in the markdown file where this call starts. */
  line: number;
  /** 0-based column where the function name starts. */
  startCol: number;
  /** 0-based column one past the closing `)`. */
  endCol: number;
  /** The full matched source of the call, used for quick-fix edits. */
  raw: string;
}

/** An exported function or arrow const discovered in a source file. */
export interface ExportedFunction {
  /** Function name. */
  name: string;
  /** Parameter names in declaration order. */
  paramNames: string[];
  /** True if the parameter list contains a destructured or rest param. */
  hasDestructuredOrRest: boolean;
  /** 0-based line where the declaration starts, relative to the source file. */
  declLine: number;
}

/** A stale code example — a call whose argument count doesn't match its referent. */
export interface StaleReference {
  call: CallExpression;
  fn: ExportedFunction;
  /** Expected argument count (from the signature). */
  expected: number;
  /** Actual argument count (from the call). */
  actual: number;
}

// ---------------------------------------------------------------------------
// Code block extraction
// ---------------------------------------------------------------------------

const SUPPORTED_LANGS = new Set(['ts', 'tsx', 'js', 'jsx', 'typescript', 'javascript']);

/**
 * Extract fenced code blocks from markdown. Only blocks whose opening fence
 * declares a supported TypeScript / JavaScript language tag are returned.
 * Unterminated blocks (missing closing fence) are silently skipped.
 */
export function extractCodeBlocks(markdown: string): CodeBlock[] {
  const lines = markdown.split('\n');
  const blocks: CodeBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const openMatch = lines[i].match(/^```(\w+)\s*$/);
    if (!openMatch) {
      i++;
      continue;
    }
    const lang = openMatch[1].toLowerCase();
    const codeStart = i + 1;
    let j = codeStart;
    while (j < lines.length && !/^```\s*$/.test(lines[j])) j++;
    if (j >= lines.length) {
      // Unterminated block — bail out rather than consuming the rest of the file.
      i++;
      continue;
    }
    if (SUPPORTED_LANGS.has(lang)) {
      blocks.push({
        lang,
        startLine: codeStart,
        endLine: j - 1,
        codeLines: lines.slice(codeStart, j),
      });
    }
    i = j + 1;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Call expression extraction
// ---------------------------------------------------------------------------

/**
 * Control-flow keywords that syntactically look like function calls (`if (x)`,
 * `while (y)`) but shouldn't be reported as stale references. Skipping them
 * avoids whole classes of false positives.
 */
const CONTROL_FLOW_KEYWORDS = new Set([
  'if',
  'else',
  'while',
  'for',
  'switch',
  'catch',
  'return',
  'typeof',
  'throw',
  'await',
  'yield',
  'void',
  'delete',
  'new',
  'function',
  'do',
]);

/**
 * Regex for a single-line call expression. Matches `name(args)` where args
 * contains no nested parens (the simple case). Nested or multi-line calls
 * are intentionally skipped — false negatives are cheaper than false positives
 * for a tool that produces diagnostics in user-facing markdown.
 */
const CALL_REGEX = /([a-zA-Z_$][\w$]*)\s*\(([^()]*)\)/g;

/**
 * Walk a code block and return every top-level call expression it contains.
 * Method calls (`obj.foo(...)`) and constructor calls (`new Foo(...)`) are
 * excluded because neither represents a direct call to a workspace export.
 */
export function extractCalls(block: CodeBlock): CallExpression[] {
  const calls: CallExpression[] = [];
  for (let rel = 0; rel < block.codeLines.length; rel++) {
    const line = block.codeLines[rel];
    CALL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = CALL_REGEX.exec(line)) !== null) {
      const name = match[1];
      const argsText = match[2];
      const startCol = match.index;
      const endCol = match.index + match[0].length;

      // Skip `obj.foo(...)` — only flag direct calls to a workspace export.
      const before = line.slice(0, startCol);
      if (/[.\w$]$/.test(before)) continue;
      // Skip `new Foo(...)`.
      if (/\bnew\s+$/.test(before)) continue;
      // Skip control-flow keywords that syntactically resemble calls.
      if (CONTROL_FLOW_KEYWORDS.has(name)) continue;

      const parsedArgs = parseTopLevelArgs(argsText);
      calls.push({
        name,
        argCount: parsedArgs.length,
        args: parsedArgs,
        line: block.startLine + rel,
        startCol,
        endCol,
        raw: match[0],
      });
    }
  }
  return calls;
}

/**
 * Parse a parenthesized argument list into its top-level comma-separated
 * entries, trimmed. Uses splitTopLevel so that commas inside generic
 * arguments, array literals, or object literals don't fragment an arg.
 */
export function parseTopLevelArgs(argsText: string): string[] {
  const trimmed = argsText.trim();
  if (trimmed === '') return [];
  return splitTopLevel(trimmed, ',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Convenience: how many top-level arguments are in an argument list?
 * Thin wrapper around parseTopLevelArgs for callers that only need the count.
 */
export function countTopLevelArgs(argsText: string): number {
  return parseTopLevelArgs(argsText).length;
}

// ---------------------------------------------------------------------------
// Exported function discovery
// ---------------------------------------------------------------------------

/**
 * Walk a single source file and return every top-level exported function
 * or arrow const. Non-exported declarations, class methods, object-literal
 * methods, and default exports are all skipped.
 */
export function findExportedFunctions(source: string): ExportedFunction[] {
  const lines = source.split('\n');
  const out: ExportedFunction[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*export\s/.test(line)) continue;
    // The matchFunctionDeclaration helper in jsDocSync already handles
    // optional `export` prefixes, so it returns the name + paren column
    // for both `export function` and `export const name = (...)` shapes.
    const decl = matchFunctionDeclaration(lines, i);
    if (!decl) continue;

    const paren = extractParenContent(lines, i, decl.parenCol);
    if (!paren) continue;

    const { names, hasDestructuredOrRest } = parseParamList(paren.content);
    out.push({
      name: decl.name,
      paramNames: names,
      hasDestructuredOrRest,
      declLine: i,
    });
  }

  return out;
}

// ---------------------------------------------------------------------------
// Staleness detection
// ---------------------------------------------------------------------------

/**
 * Detect stale references in a markdown file. A call is stale when it names
 * a known exported function but passes the wrong number of arguments.
 * Unknown names and functions with destructured / rest params are skipped.
 */
export function detectStaleReferences(
  markdown: string,
  exportsByName: Map<string, ExportedFunction>,
): StaleReference[] {
  const results: StaleReference[] = [];
  const blocks = extractCodeBlocks(markdown);
  for (const block of blocks) {
    for (const call of extractCalls(block)) {
      const fn = exportsByName.get(call.name);
      if (!fn) continue;
      if (fn.hasDestructuredOrRest) continue;
      if (call.argCount !== fn.paramNames.length) {
        results.push({
          call,
          fn,
          expected: fn.paramNames.length,
          actual: call.argCount,
        });
      }
    }
  }
  return results;
}

/**
 * Convenience wrapper: parse markdown, detect stale references, return them.
 * The caller supplies the exported-function index as a prebuilt map so the
 * expensive source scan isn't repeated on every markdown save.
 */
export function analyzeReadme(markdown: string, exportsByName: Map<string, ExportedFunction>): StaleReference[] {
  return detectStaleReferences(markdown, exportsByName);
}
