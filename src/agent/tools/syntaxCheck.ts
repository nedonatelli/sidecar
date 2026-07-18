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
import { findPythonIndentErrors } from './pythonIndent.js';

/** File extension → tree-sitter grammar name. Mirrors the shipped wasm set. */
const EXT_TO_GRAMMAR: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  rb: 'ruby',
  c: 'c',
  cpp: 'cpp',
  cs: 'c_sharp',
  php: 'php',
  lua: 'lua',
  swift: 'swift',
  kt: 'kotlin',
  scala: 'scala',
  dart: 'dart',
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
  parse(content: string): { rootNode: TsNode } | null;
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
  firstErrorLine?: number;
  /** False when the check could not run — the edit is unverified, not unsafe. */
  checked: boolean;
}

const UNCHECKED: SyntaxCheckResult = { broken: false, errorCount: 0, checked: false };

const asBool = (v: boolean | (() => boolean) | undefined): boolean => (typeof v === 'function' ? v() : v === true);

/** Depth-first collect of ERROR / MISSING nodes, bounded so a huge tree can't stall an edit. */
function collectErrors(root: TsNode, limit = 20): TsNode[] {
  const found: TsNode[] = [];
  const stack: TsNode[] = [root];
  let visited = 0;
  while (stack.length > 0 && found.length < limit && visited < 50_000) {
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
  return found;
}

async function checkSyntaxUnbounded(filePath: string, content: string): Promise<SyntaxCheckResult> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const grammar = EXT_TO_GRAMMAR[ext];
  if (!grammar) return UNCHECKED;

  const parser = await parserFor(grammar);
  if (!parser) return UNCHECKED;

  const tree = parser.parse(content);
  if (!tree?.rootNode) return UNCHECKED;

  const errors = collectErrors(tree.rootNode);
  let count = errors.length;
  let firstLine = errors[0]?.startPosition?.row !== undefined ? errors[0].startPosition!.row + 1 : undefined;

  // PYTHON: tree-sitter catches structure (a missing colon) but NOT indentation
  // — verified against the shipped grammar, it parses an orphaned indented line
  // and a mis-indented block as clean. In Python the corruption class this guard
  // exists for (replacing a block header with a one-liner, orphaning the body)
  // IS an indentation error, so tree-sitter alone would let it through.
  // findPythonIndentErrors closes that gap; it is validated against 4,001
  // CPython-accepted files with zero false positives and fails open on anything
  // it cannot read confidently. See pythonIndent.ts / pythonIndentCorpus.test.ts.
  if (grammar === 'python') {
    const indentErrors = findPythonIndentErrors(content);
    if (indentErrors.length > 0) {
      count += indentErrors.length;
      if (firstLine === undefined || indentErrors[0].line < firstLine) firstLine = indentErrors[0].line;
    }
  }

  return {
    broken: count > 0,
    errorCount: count,
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
export async function editWouldBreakSyntax(
  filePath: string,
  before: string,
  after: string,
): Promise<{ refuse: boolean; message?: string }> {
  const afterCheck = await checkSyntax(filePath, after);
  if (!afterCheck.checked || !afterCheck.broken) return { refuse: false };

  const beforeCheck = await checkSyntax(filePath, before);
  if (!beforeCheck.checked) return { refuse: false };

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
  if (afterCheck.errorCount <= beforeCheck.errorCount) return { refuse: false };

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
 * The parse gate is what makes blanket decoding safe: decoding a legitimate
 * in-string `"a\nb"` escape puts a real newline inside a quoted literal, which
 * fails to parse in Python/JS strings — so a harmful decode rejects itself.
 * (Triple-quoted / template literals accept the newline but render the same
 * string, so the survivors are semantics-preserving.) No positive parse, no
 * rescue; unchecked grammars never rescue.
 */
export async function tryLiteralEscapeRecovery(
  filePath: string,
  before: string,
  after: string,
): Promise<string | null> {
  if (!/\\[nt]/.test(after)) return null;
  const normalized = after.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
  if (normalized === after) return null;
  const normCheck = await checkSyntax(filePath, normalized);
  if (!normCheck.checked) return null;
  const beforeCheck = await checkSyntax(filePath, before);
  if (!beforeCheck.checked) return null;
  return normCheck.errorCount <= beforeCheck.errorCount ? normalized : null;
}

/** Test seam: inject a parser (or null) for a grammar without touching disk. */
export function __setParserForTests(grammar: string, parser: TsParser | null): void {
  parserCache.set(grammar, parser);
}

/** Test seam: clear the parser cache. */
export function __resetParserCache(): void {
  parserCache.clear();
}

/** True when a grammar exists for this file — i.e. the parse guard can actually run. */
export function canParseSyntax(filePath: string): boolean {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return EXT_TO_GRAMMAR[ext] !== undefined;
}
