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

import * as path from 'path';
import { getGrammarsPath } from '../../parsing/registry.js';

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

/** Load (and cache) a parser for one grammar. Null when unavailable. */
async function parserFor(grammar: string): Promise<TsParser | null> {
  const cached = parserCache.get(grammar);
  if (cached !== undefined) return cached;

  const wasmDir = getGrammarsPath();
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
  const first = errors[0]?.startPosition?.row;
  return {
    broken: errors.length > 0,
    errorCount: errors.length,
    ...(first !== undefined ? { firstErrorLine: first + 1 } : {}),
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
  if (!beforeCheck.checked || beforeCheck.broken) return { refuse: false };

  const where = afterCheck.firstErrorLine ? ` The first parse error is at line ${afterCheck.firstErrorLine}.` : '';
  return {
    refuse: true,
    message:
      `Error: edit_file refused this edit to ${filePath} — the file currently parses, but your edit would ` +
      `make it unparseable (${afterCheck.errorCount} syntax error${afterCheck.errorCount === 1 ? '' : 's'}).` +
      `${where} The file was NOT modified.\n\n` +
      `Common causes: the replacement text is escaped or quoted wrongly (e.g. \`\\(\` instead of \`(\`), a ` +
      `bracket or brace is unbalanced, or the replacement is only part of the construct it replaces.\n\n` +
      `Call read_file on ${filePath}, then send a replacement that is valid, complete source code — ` +
      `exactly what should appear in the file, with no escaping.`,
  };
}

/** Test seam: inject a parser (or null) for a grammar without touching disk. */
export function __setParserForTests(grammar: string, parser: TsParser | null): void {
  parserCache.set(grammar, parser);
}

/** Test seam: clear the parser cache. */
export function __resetParserCache(): void {
  parserCache.clear();
}
