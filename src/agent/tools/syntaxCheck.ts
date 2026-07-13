// Edit-time syntax validation — the general guard against agent-authored file
// corruption.
//
// The v0.119 dogfood pass produced three distinct corruptions of one 4-line
// file, each slipping the previous guard:
//   1. STRUCTURAL — an inferred edit replaced a block HEADER with a
//      self-contained one-liner, orphaning the body (caught by the delimiter
//      balance invariant).
//   2. LEXICAL — an exact match ended mid-token (`…: s` inside `string`), so
//      the splice cut an identifier in half (caught by the token-boundary
//      invariant).
//   3. SEMANTIC — the model emitted regex-ESCAPED source as its replacement
//      (`function welcome\(name: s\)`). Balanced, token-aligned, and complete
//      garbage. No lexical or structural rule can see it.
//
// The invariant that subsumes all three: an edit must not make a file stop
// parsing. Tree-sitter grammars already ship with the extension (used by the
// symbol index), so this is a cheap in-process check — no shell, no tsc, and
// it covers TypeScript, which the completion-time syntax gate deliberately
// skips ("no cheap per-file TS syntax check").
//
// Fail-open by design: when no grammar is available for the extension, or the
// parser cannot load, the edit proceeds. A guard that blocks edits because a
// grammar is missing would be worse than the corruption it prevents.

import * as path from 'path';
import { getAnalyzer } from '../../parsing/registry.js';

/** Extensions we can parse-check. Mirrors the tree-sitter grammar set. */
const CHECKABLE = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'rs',
  'go',
  'java',
  'rb',
  'c',
  'cpp',
  'cs',
  'php',
  'lua',
  'swift',
  'kt',
  'scala',
  'dart',
]);

export interface SyntaxCheckResult {
  /** True when the check ran and found the content unparseable. */
  broken: boolean;
  /** Number of ERROR/MISSING nodes; 0 when clean or unchecked. */
  errorCount: number;
  /** First error's 1-based line, when known. */
  firstErrorLine?: number;
  /** False when no grammar applies — caller must treat the edit as unverified, not unsafe. */
  checked: boolean;
}

const UNCHECKED: SyntaxCheckResult = { broken: false, errorCount: 0, checked: false };

/**
 * Count parse errors in `content` for the language implied by `filePath`.
 * Never throws — any failure resolves to "unchecked".
 */
export async function checkSyntax(filePath: string, content: string): Promise<SyntaxCheckResult> {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!CHECKABLE.has(ext)) return UNCHECKED;

  try {
    const analyzer = await getAnalyzer(ext);
    // The regex fallback cannot detect syntax errors — only the tree-sitter
    // analyzer exposes a parse tree. `parseTree` is optional on the interface,
    // so its absence means "no grammar loaded" → unchecked, never "broken".
    const parseTree = (analyzer as { parseTree?: (p: string, c: string) => { rootNode: unknown } | null }).parseTree;
    if (typeof parseTree !== 'function') return UNCHECKED;

    const tree = parseTree.call(analyzer, filePath, content);
    if (!tree?.rootNode) return UNCHECKED;

    const errors = collectErrorNodes(tree.rootNode as TsNode);
    return {
      broken: errors.length > 0,
      errorCount: errors.length,
      firstErrorLine: errors[0]?.startPosition ? errors[0].startPosition.row + 1 : undefined,
      checked: true,
    };
  } catch {
    return UNCHECKED;
  }
}

interface TsNode {
  type: string;
  isError?: boolean;
  isMissing?: boolean;
  hasError?: boolean;
  startPosition?: { row: number; column: number };
  childCount: number;
  child(i: number): TsNode | null;
}

/** Depth-first collect of ERROR / MISSING nodes, bounded so a pathological tree can't stall an edit. */
function collectErrorNodes(root: TsNode, limit = 20): TsNode[] {
  const found: TsNode[] = [];
  const stack: TsNode[] = [root];
  let visited = 0;
  while (stack.length > 0 && found.length < limit && visited < 20_000) {
    const node = stack.pop()!;
    visited++;
    if (node.type === 'ERROR' || node.isError === true || node.isMissing === true) {
      found.push(node);
      continue; // don't descend into a broken subtree — its children are noise
    }
    // Prune: a subtree with no error anywhere can be skipped wholesale.
    if (node.hasError === false) continue;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) stack.push(child);
    }
  }
  return found;
}

/**
 * Decide whether an edit may be written. An edit is refused only when it makes
 * a file that PARSED CLEANLY stop parsing — never when the file was already
 * broken (the model may be repairing it), and never when the language has no
 * grammar.
 */
export async function editWouldBreakSyntax(
  filePath: string,
  before: string,
  after: string,
): Promise<{ refuse: boolean; message?: string }> {
  const afterCheck = await checkSyntax(filePath, after);
  if (!afterCheck.checked || !afterCheck.broken) return { refuse: false };

  const beforeCheck = await checkSyntax(filePath, before);
  // Already broken → the model is allowed to try to fix it (and must not be
  // trapped in a state where every repair attempt is refused).
  if (beforeCheck.broken && beforeCheck.errorCount <= afterCheck.errorCount) {
    return { refuse: false };
  }
  if (beforeCheck.broken) return { refuse: false };

  const where = afterCheck.firstErrorLine ? ` The first parse error is at line ${afterCheck.firstErrorLine}.` : '';
  return {
    refuse: true,
    message:
      `Error: edit_file refused this edit to ${filePath} — the file currently parses, but your edit would ` +
      `make it unparseable (${afterCheck.errorCount} syntax error${afterCheck.errorCount === 1 ? '' : 's'}).` +
      `${where} The file was NOT modified.\n\n` +
      `Common causes: the replacement text is escaped or quoted wrongly (e.g. \`\\(\` instead of \`(\`), a ` +
      `bracket or brace is unbalanced, or the replacement is only part of the construct it replaces.\n\n` +
      `Call read_file on ${filePath}, then send a replacement that is valid, complete source code.`,
  };
}
