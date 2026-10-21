// Edit-time syntax validation — the general guard against agent-authored file
// corruption.
//
// The v0.119 dogfood pass produced three distinct corruptions of one 4-line
// file, each slipping the previous guard:
//   1. STRUCTURAL — an inferred edit replaced a block HEADER with a
//      self-contained one-liner, orphaning the body (delimiter-balance guard).
//   2. LEXICAL — an exact match ended mid-token (`…: s` inside `string`), so
//      the splice cut an identifier in half (token-boundary guard).
//   3. SEMANTIC — the model emitted regex-ESCAPED source as its replacement
//      (`function welcome\(name: s\)`). Balanced, token-aligned, and complete
//      garbage. No lexical or structural rule can see it.
//
// The invariant that subsumes all three: an edit must not make a file stop
// parsing. Verified against the shipped grammars — the clean fixture parses
// with 0 errors and all three corruptions are flagged.
//
// PERFORMANCE IS PART OF CORRECTNESS HERE. The first cut of this guard called
// `parsing/registry.getAnalyzer`, which builds the symbol-index analyzer by
// loading ALL 19 grammars serially: measured 3m20s cold in the extension host,
// stalling a single edit that long — and when the load failed it fell back to
// the regex analyzer, which exposes no parse tree, so the guard silently
// failed open and a corrupting edit landed anyway. This module therefore:
//   • loads exactly ONE grammar, for the language of the file being edited,
//   • caches parsers per language across calls,
//   • races every check against a hard timeout, and
//   • fails OPEN on timeout / missing grammar / any error.
// Fail-open is deliberate: blocking edits because a grammar is slow or absent
// would be worse than the corruption it prevents. But a guard that ALWAYS
// fails open is no guard, so the timeout is generous enough for a warm parser
// (which is the steady state) and the load is scoped to one language.

// LANGUAGE COVERAGE, honestly stated (verified against the shipped grammars):
//   • TypeScript / TSX / JS — full: structure, token splices, escaped source.
//   • Rust / Go / Java / others — structural breaks caught.
//   • Python — STRUCTURAL breaks caught (a missing colon), but tree-sitter does
//     NOT flag INDENTATION errors: an orphaned indented line and a mis-indented
//     block both parse clean. That gap is covered one layer up — the
//     completion-time syntax gate still runs `py_compile` on .py files, which
//     raises IndentationError. Edit-time catches structure; completion-time
//     catches indentation. See syntaxCheckLanguages.test.ts, which pins both.

import * as path from 'path';
import { getGrammarsPath } from '../../parsing/registry.js';
import { scanPythonIndent } from './pythonIndent.js';

/** File extension → tree-sitter grammar name. Mirrors the shipped wasm set. */
//
// Sibling extensions map to the same grammar (#157 ML-47). `.h` is read with
// the C++ grammar, which parses C too; the C grammar would count a C++
// header's classes as errors. Dart is NOT listed (ML-39): the shipped grammar
// is ABI 15 and the runtime reads 13-14, so it never loads -- listing it only
// made canParseSyntax claim a check that could not run. Re-add it with a
// runtime that loads it.
const EXT_TO_GRAMMAR: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  c: 'c',
  h: 'cpp',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hh: 'cpp',
  cs: 'c_sharp',
  php: 'php',
  lua: 'lua',
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  scala: 'scala',
};

/** Milliseconds a syntax check may take before the edit proceeds unchecked. */
const CHECK_TIMEOUT_MS = 10_000;

interface TsNode {
  type: string;
  isMissing?: boolean | (() => boolean);
  hasError?: boolean | (() => boolean);
  startPosition?: { row: number; column: number };
  childCount: number;
  child(i: number): TsNode | null;
}
interface TsParser {
  parse(content: string): { rootNode: TsNode; delete?(): void } | null;
}

const parserCache = new Map<string, TsParser | null>();

/**
 * Locate the grammar wasm directory when `setGrammarsPath` has NOT run — i.e.
 * outside the VS Code extension host: the eval harness, sub-agent sandboxes,
 * any headless driver.
 *
 * This is not a nicety. The guard fails open without a grammar, so before this
 * existed it was inert everywhere except the extension host — the eval harness
 * happily let a model write `@tsDocParam(` to a TypeScript file and reported
 * success, which is precisely the corruption the guard is meant to stop. A
 * guard that only works in one host is a guard you cannot regression-test.
 */
function resolveGrammarsDirOutsideExtensionHost(): string | null {
  const candidates = [
    process.env.SIDECAR_GRAMMARS_DIR,
    path.join(process.cwd(), 'grammars'),
    // dist/ and out/ builds sit one level below the repo root.
    path.join(process.cwd(), '..', 'grammars'),
  ].filter((p): p is string => Boolean(p));

  for (const dir of candidates) {
    try {
      const fs = require('fs') as typeof import('fs');
      if (fs.existsSync(path.join(dir, 'tree-sitter.wasm'))) return dir;
    } catch {
      // fall through to the next candidate
    }
  }
  return null;
}

/** Load (and cache) a parser for one grammar. Null when unavailable. */
async function parserFor(grammar: string): Promise<TsParser | null> {
  const cached = parserCache.get(grammar);
  if (cached !== undefined) return cached;

  const wasmDir = getGrammarsPath() ?? resolveGrammarsDirOutsideExtensionHost();
  if (!wasmDir) {
    parserCache.set(grammar, null);
    return null;
  }
  try {
    const { createParser } = await import('../../parsing/treeSitterLoader.js');
    const parser = (await createParser(wasmDir, grammar)) as unknown as TsParser;
    parserCache.set(grammar, parser);
    return parser;
  } catch {
    parserCache.set(grammar, null); // don't retry a failing grammar on every edit
    return null;
  }
}

export interface SyntaxCheckResult {
  /** True only when the check RAN and found the content unparseable. */
  broken: boolean;
  errorCount: number;
  /**
   * The count hit the collection cap, so it is a floor, not the real number.
   * Two capped counts cannot be compared.
   */
  saturated?: boolean;
  firstErrorLine?: number;
  /** False when the check could not run — the edit is unverified, not unsafe. */
  checked: boolean;
}

const UNCHECKED: SyntaxCheckResult = { broken: false, errorCount: 0, checked: false };

const asBool = (v: boolean | (() => boolean) | undefined): boolean => (typeof v === 'function' ? v() : v === true);

/**
 * How many parse errors are counted before giving up. The guard compares
 * counts before and after an edit, so the cap must sit far above the phantom
 * errors a grammar gap leaves in valid files: at the old cap of 20, a file
 * with 20 of them read 20 before and 20 after ANY edit, and the guard let
 * everything through as "not worse".
 */
const MAX_COUNTED_ERRORS = 1000;

/** Depth-first collect of ERROR / MISSING nodes, bounded so a huge tree can't stall an edit. */
function collectErrors(root: TsNode, limit = MAX_COUNTED_ERRORS): { found: TsNode[]; complete: boolean } {
  const found: TsNode[] = [];
  const stack: TsNode[] = [root];
  let visited = 0;
  while (stack.length > 0 && found.length < limit && visited < 200_000) {
    const node = stack.pop()!;
    visited++;
    if (node.type === 'ERROR' || asBool(node.isMissing)) {
      found.push(node);
      continue; // a broken subtree's children are noise
    }
    if (node.hasError !== undefined && !asBool(node.hasError)) continue; // prune clean subtrees
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
  return { found, complete: stack.length === 0 };
}

async function checkSyntaxUnbounded(filePath: string, content: string): Promise<SyntaxCheckResult> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const grammar = EXT_TO_GRAMMAR[ext];
  if (!grammar) return UNCHECKED;

  const parser = await parserFor(grammar);
  if (!parser) return UNCHECKED;

  const tree = parser.parse(content);
  if (!tree?.rootNode) {
    tree?.delete?.();
    return UNCHECKED;
  }

  // Everything read from the tree is read before it is freed: its nodes point
  // into WASM memory.
  let count: number;
  let complete: boolean;
  let rootHasError: boolean;
  let rows: number[];
  try {
    const collected = collectErrors(tree.rootNode);
    count = collected.found.length;
    complete = collected.complete;
    rootHasError = asBool(tree.rootNode.hasError);
    // The walk pops a stack, so `found` is not in document order: found[0]
    // was the LAST error, reported as "the first parse error" (ML-49).
    rows = collected.found.map((e) => e.startPosition?.row).filter((r): r is number => r !== undefined);
  } finally {
    // Trees live on the WASM heap, not the JS one, and are never collected
    // (#157 ML-30): without this the heap filled after ~1,400-2,800 checks in
    // one process, every later parse failed, and the guard -- which fails open
    // -- allowed every edit in every language from then on.
    tree.delete?.();
  }
  let firstLine = rows.length > 0 ? Math.min(...rows) + 1 : undefined;
  // A MISSING token can sit where the walk cannot reach it, leaving a tree
  // that says it has an error with none found (ML-45): count it as one.
  if (count === 0 && rootHasError) count = 1;

  // PYTHON: tree-sitter catches structure (a missing colon) but NOT indentation
  // — verified against the shipped grammar, it parses an orphaned indented line
  // and a mis-indented block as clean. In Python the corruption class this guard
  // exists for (replacing a block header with a one-liner, orphaning the body)
  // IS an indentation error, so tree-sitter alone would let it through.
  // findPythonIndentErrors closes that gap; it is validated against 4,001
  // CPython-accepted files with zero false positives and fails open on anything
  // it cannot read confidently. See pythonIndent.ts / pythonIndentCorpus.test.ts.
  let indentSaturated = false;
  if (grammar === 'python') {
    const indent = scanPythonIndent(content);
    const indentErrors = indent.errors;
    indentSaturated = indent.saturated;
    if (indentErrors.length > 0) {
      count += indentErrors.length;
      if (firstLine === undefined || indentErrors[0].line < firstLine) firstLine = indentErrors[0].line;
    }
  }

  return {
    broken: count > 0,
    errorCount: count,
    // Either half can hit its cap: the tree walk, or the indent scan's 10 (ML-50).
    ...(complete && !indentSaturated ? {} : { saturated: true }),
    ...(firstLine !== undefined ? { firstErrorLine: firstLine } : {}),
    checked: true,
  };
}

/** Parse-check `content`. Never throws, never hangs — resolves UNCHECKED on any failure or timeout. */
export async function checkSyntax(filePath: string, content: string): Promise<SyntaxCheckResult> {
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<SyntaxCheckResult>((resolve) => {
      timer = setTimeout(() => resolve(UNCHECKED), CHECK_TIMEOUT_MS);
    });
    const result = await Promise.race([checkSyntaxUnbounded(filePath, content), timeout]);
    if (timer) clearTimeout(timer);
    return result;
  } catch {
    return UNCHECKED;
  }
}

/**
 * Refuse an edit only when it makes a file that PARSED CLEANLY stop parsing.
 * A file that was already broken stays editable — repairs must never be trapped.
 */
/**
 * What the parse gate actually determined, as distinct from whether it refused.
 *
 *   ok          the result parses cleanly.
 *   unchecked   no grammar for this language, or no parseable baseline — the
 *               gate allowed the edit without ever checking it.
 *   not-worse   the result has parse errors, but no more than the file already
 *               had, so the gate allowed it.
 *
 * `refuse: false` collapses all three, which is right for the gate and wrong
 * for anything reporting an outcome: "we did not refuse" is not "this parses".
 */
export type SyntaxVerdict = 'ok' | 'unchecked' | 'not-worse';

export async function editWouldBreakSyntax(
  filePath: string,
  before: string,
  after: string,
): Promise<{ refuse: boolean; message?: string; verdict?: SyntaxVerdict }> {
  const afterCheck = await checkSyntax(filePath, after);
  if (!afterCheck.checked) return { refuse: false, verdict: 'unchecked' };
  if (!afterCheck.broken) return { refuse: false, verdict: 'ok' };

  const beforeCheck = await checkSyntax(filePath, before);
  if (!beforeCheck.checked) return { refuse: false, verdict: 'unchecked' };

  // Compare error COUNTS — do not treat "the file already has an error" as a
  // blank cheque.
  //
  // The old rule (before.broken → allow anything) silently disabled the guard
  // for any file the grammar mis-parses. That is not hypothetical: the shipped
  // tree-sitter TypeScript grammar cannot parse `import('vscode').Disposable`
  // type-imports or `accessor` fields, so 16 of SideCar's own 475 valid source
  // files (3.4%) register a phantom error — including loop.ts (15) and
  // settings.ts (11). The guard was OFF for every one of them, and the edit
  // oracle caught it: deleting a closing brace from workspaceIndexer.ts was
  // APPLIED because the file "was already broken".
  //
  // Counting instead survives grammar gaps: a phantom error is present before
  // AND after, so it cancels. Only an edit that makes things WORSE is refused,
  // and a model repairing a genuinely broken file (count falling) is still free
  // to work. Grammars will always lag the language; the rule must not.
  // Not refused, but NOT clean either: the file parses no worse than it did.
  // Reporting this as 'ok' would claim a guarantee the gate did not make.
  // Both counts capped: neither number is real, so there is nothing to
  // compare. Allowed, and reported as unchecked rather than "not worse".
  if (afterCheck.saturated && beforeCheck.saturated) return { refuse: false, verdict: 'unchecked' };
  if (afterCheck.errorCount <= beforeCheck.errorCount) return { refuse: false, verdict: 'not-worse' };

  const introduced = afterCheck.errorCount - beforeCheck.errorCount;
  const where = afterCheck.firstErrorLine ? ` The first parse error is at line ${afterCheck.firstErrorLine}.` : '';
  const already = beforeCheck.broken ? ' (the file had pre-existing parse errors; your edit added more)' : '';
  return {
    refuse: true,
    message:
      `Error: edit_file refused this edit to ${filePath} — it would introduce ${introduced} new syntax ` +
      `error${introduced === 1 ? '' : 's'}${already}.` +
      `${where} The file was NOT modified.\n\n` +
      `Common causes: the replacement text is escaped or quoted wrongly (e.g. \`\\(\` instead of \`(\`), a ` +
      `bracket or brace is unbalanced, or the replacement is only part of the construct it replaces.\n\n` +
      `Call read_file on ${filePath}, then send a replacement that is valid, complete source code — ` +
      `exactly what should appear in the file, with no escaping.`,
  };
}

/**
 * Escape-contamination recovery (code-as-text package): when proposed content
 * contains literal `\n` / `\t` two-char sequences and fails the syntax guard,
 * try the variant with those escapes decoded to real whitespace. Returns the
 * normalized content ONLY when the parse gate proves the decode fixed it —
 * normalized parses with no more errors than the file had before — else null.
 *
 * The failure this targets (llama3.2, lh-calculator-session, steer A/B r1):
 * every write_file/edit_file carried content like `import math\n\ndef add…`
 * with LITERAL backslash-n between statements — the model serialized its code
 * as an escaped string. Every attempt was correctly refused by the guard and
 * the run died with the model's code complete but undeliverable.
 *
 * Only escapes OUTSIDE string literals are decoded (#158). The parse gate was
 * once thought to make blanket decoding safe -- a real newline inside a "..."
 * literal "fails to parse" -- but tree-sitter's Python grammar accepts it while
 * CPython rejects it, so a legitimate `print("\nUsage")` was decoded into a
 * file CPython will not compile (ML-29). An escape inside a string is a real
 * escape, and an escaped backslash (`"\\n"`) is not an escape at all (ML-17).
 * Decoded line breaks use the file's own line ending: a CRLF file got bare
 * LFs (ML-35). No positive parse, no rescue; unchecked grammars never rescue.
 */
export async function tryLiteralEscapeRecovery(
  filePath: string,
  before: string,
  after: string,
): Promise<string | null> {
  // Decode only the text the edit changed: the span between the prefix and the
  // suffix `before` and `after` share. Decoding the whole file also rewrote
  // escapes that were already there, and some of those still parse once
  // decoded -- Python's `"\\n".join(...)` becomes a backslash-newline line
  // continuation -- so an unrelated string literal changed silently.
  let pre = 0;
  while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++;
  let suf = 0;
  while (
    suf < before.length - pre &&
    suf < after.length - pre &&
    before[before.length - 1 - suf] === after[after.length - 1 - suf]
  ) {
    suf++;
  }
  const changed = after.slice(pre, after.length - suf);
  if (!/\\[nt]/.test(changed)) return null;
  const eol = /\r\n/.test(before) && !/(?<!\r)\n/.test(before) ? '\r\n' : '\n';
  // Lex from the start of the line the change begins on, so a string the edit
  // starts inside of is seen as a string.
  const lineStart = after.lastIndexOf('\n', pre - 1) + 1;
  const decoded = decodeEscapesOutsideStrings(
    after.slice(lineStart, after.length - suf),
    eol,
    commentTokenFor(filePath),
    pre - lineStart, // the unchanged start of the line is lexed, not decoded
  );
  const normalized = after.slice(0, lineStart) + decoded + after.slice(after.length - suf);
  if (normalized === after) return null;
  // The decode must not UNDO the edit. When an edit's whole purpose is to put a
  // literal `\n` into source — code that manipulates escape sequences, which is
  // exactly the code most likely to trip this recovery — decoding turns the new
  // text back into what was already there. The file then parses (it is the
  // original), the caller writes it, and the tool reports "File edited" over a
  // change that did not happen.
  //
  // Live, sphinx-doc__sphinx-8474 (2026-09-15): the model sent the same edit
  // SIX times, each reporting success, because every decode reproduced the
  // original file and its search text kept matching. The run burned to the
  // 50-turn cap. edit_file already refuses `search === replace` up front; this
  // is the same no-op arriving by a path that bypassed that check, so it gets
  // the same answer — decline, and let the caller surface the real error.
  if (normalized === before) return null;
  const normCheck = await checkSyntax(filePath, normalized);
  if (!normCheck.checked) return null;
  const beforeCheck = await checkSyntax(filePath, before);
  if (!beforeCheck.checked) return null;
  return normCheck.errorCount <= beforeCheck.errorCount ? normalized : null;
}

/** The line-comment introducer for a file, for the escape decoder's lexer. */
function commentTokenFor(filePath: string): string {
  return /\.(py|pyi|rb|sh|bash|zsh|r|pl|yaml|yml|toml)$/i.test(filePath) ? '#' : '//';
}

/**
 * Decode literal `\n` / `\t` escapes that sit OUTSIDE string literals into a
 * real line break (`eol`) / tab. Inside "...", '...', `...` and triple-quoted
 * strings an escape is left exactly as written; `\\` is consumed as a pair so
 * an escaped backslash never starts an escape. Comments are tracked so an
 * apostrophe in `# don't` does not open a string; a `\n` inside a comment ends
 * it -- that is the line break the contaminated text lost. Escapes before
 * `decodeFrom` are read for lexer state only and kept as written.
 */
export function decodeEscapesOutsideStrings(text: string, eol: string, commentToken: string, decodeFrom = 0): string {
  let out = '';
  let quote: string | null = null; // the delimiter of the string we are in: ", ', `, """ or '''
  let inComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\n') {
      out += c;
      inComment = false;
      if (quote !== null && quote.length === 1 && quote !== '`') quote = null; // single-line strings end here
      continue;
    }
    if (c === '\\') {
      const next = text[i + 1];
      if (quote === null && i >= decodeFrom && (next === 'n' || next === 't')) {
        out += next === 'n' ? eol : '\t';
        if (next === 'n') inComment = false;
        i++;
        continue;
      }
      // Inside a string, or any other escape: keep the pair as written, so `\\`
      // and `\"` never start or end anything.
      out += c + (next ?? '');
      i++;
      continue;
    }
    out += c;
    if (inComment) continue;
    if (quote !== null) {
      if (text.startsWith(quote, i)) {
        out += quote.slice(1);
        i += quote.length - 1;
        quote = null;
      }
      continue;
    }
    if (text.startsWith(commentToken, i)) {
      inComment = true;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const triple = c !== '`' && text.startsWith(c.repeat(3), i);
      quote = triple ? c.repeat(3) : c;
      if (triple) {
        out += c.repeat(2);
        i += 2;
      }
    }
  }
  return out;
}

/** Test seam: inject a parser (or null) for a grammar without touching disk. */
export function __setParserForTests(grammar: string, parser: TsParser | null): void {
  parserCache.set(grammar, parser);
}

/** Test seam: clear the parser cache. */
export function __resetParserCache(): void {
  parserCache.clear();
}

/** True when a grammar exists for this file and has not failed to load — i.e. the parse guard can actually run. */
export function canParseSyntax(filePath: string): boolean {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const grammar = EXT_TO_GRAMMAR[ext];
  return grammar !== undefined && parserCache.get(grammar) !== null;
}
