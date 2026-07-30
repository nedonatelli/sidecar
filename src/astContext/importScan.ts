/**
 * Line-scanning + import-parsing primitives for the lightweight code analyzer.
 * Pure string helpers — no tree-sitter, no VS Code — shared by
 * SimpleCodeAnalyzer.parseFileContent.
 */

/** One position in a declaration scan: the character, and the state it sits in. */
interface ScanStep {
  ch: string;
  /** Bracket nesting depth, counting `()`, `[]` and `{}` together. */
  depth: number;
  /** Index within the string passed to the scanner. */
  index: number;
}

/** Characters after which a `/` opens a regex literal rather than dividing. */
const REGEX_PRECEDERS = new Set(['=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '~', '^']);

/**
 * Walk declaration text, yielding only the characters that are actually code.
 *
 * Everything that can hide a bracket or a comma is consumed here rather than by
 * each caller: string and template literals, line and block comments, and regex
 * literals. The last one is why this is shared — `const P = /^\s*\(/;` has an
 * unbalanced `(` that a naive scan follows to the end of the file, and the
 * declarations this code exists to index include a whole category of exported
 * regexes.
 *
 * Newlines are yielded so line-oriented callers can track them; the scanner
 * itself is position-based and knows nothing about lines.
 */
function* scanCode(text: string): Generator<ScanStep> {
  let depth = 0;
  let i = 0;
  let prevSignificant = '';
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '/' && next === '/') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return;
      i = nl;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === '/' && (prevSignificant === '' || REGEX_PRECEDERS.has(prevSignificant))) {
      // Regex literal: skip to the unescaped closing `/`, staying out of `[...]`
      // classes where a `/` does not terminate it.
      let j = i + 1;
      let inClass = false;
      while (j < text.length) {
        const c = text[j];
        if (c === '\\') j += 2;
        else if (c === '\n') break;
        else if (c === '[') ((inClass = true), j++);
        else if (c === ']') ((inClass = false), j++);
        else if (c === '/' && !inClass) break;
        else j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === '\\') j += 2;
        else if (text[j] === ch) break;
        else j++;
      }
      i = j + 1;
      prevSignificant = ch;
      continue;
    }

    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;

    yield { ch, depth, index: i };
    if (ch.trim()) prevSignificant = ch;
    i++;
  }
}

/**
 * Find the last line of a variable declaration starting on `startLine`.
 *
 * Distinct from `findBlockEnd`, which balances only `{}` and therefore runs to
 * the end of the file for `const A = 1;` (never opens a brace) and for array
 * initializers (opens `[`). A declaration ends on the first newline at which
 * every bracket it opened is closed.
 */
export function findDeclarationEnd(lines: string[], startLine: number): number {
  const text = lines.slice(startLine).join('\n');
  // Lines are counted from the character index rather than from the newlines
  // the scanner yields: a template literal or block comment is consumed whole,
  // so the newlines inside it never surface as steps.
  let counted = 0;
  let newlines = 0;
  const lineAt = (index: number): number => {
    for (; counted < index; counted++) if (text[counted] === '\n') newlines++;
    return startLine + newlines;
  };

  let depth = 0;
  for (const step of scanCode(text)) {
    if (step.ch === '\n' && depth <= 0) return lineAt(step.index);
    depth = step.depth;
  }
  return lines.length - 1;
}

/**
 * Names bound by a variable declaration, in source order.
 *
 * One statement can bind several — `const A = 1, B = 2` — so commas separate
 * declarators only at bracket depth zero. Destructuring patterns bind names
 * without a declarator identifier and are deliberately skipped rather than
 * guessed at.
 */
export function declaredNames(declaration: string): string[] {
  const body = declaration.replace(/^\s*(?:export\s+)?(?:const|let|var)\s+/, '');
  const names: string[] = [];
  // A declarator name is followed by `=`, a `:` type annotation, a `;`, or the
  // end of the statement. Requiring that rejects the fragments produced by
  // commas this scanner cannot see past — `Record<string, unknown>` splits into
  // `… Record<string` and `unknown> = …`, and `unknown` is a perfectly valid
  // identifier, so the name alone cannot tell them apart. Angle brackets are
  // not tracked as depth because `<` is also a comparison operator.
  const take = (part: string) => {
    const m = part.match(/^\s*([a-zA-Z_$][\w$]*)\s*(.?)/);
    if (m && (m[2] === '' || m[2] === '=' || m[2] === ':' || m[2] === ';')) names.push(m[1]);
  };
  let start = 0;
  let end = 0;
  for (const step of scanCode(body)) {
    end = step.index + 1;
    if (step.ch === ',' && step.depth === 0) {
      take(body.slice(start, step.index));
      start = step.index + 1;
    }
  }
  take(body.slice(start, Math.max(start, end)));
  return names;
}

/**
 * Find the closing brace for a block that starts on `startLine`.
 * Counts `{` / `}` from the start line forward. Returns the line
 * index of the matching `}`, or the last line of the file.
 */
export function findBlockEnd(lines: string[], startLine: number): number {
  let depth = 0;
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }
  }
  return lines.length - 1;
}

/**
 * Find the end of a Python-style indented block starting after `startLine`.
 * Returns the last line that is either blank or indented deeper than the
 * definition line.
 */
export function findIndentEnd(lines: string[], startLine: number): number {
  const defIndent = lines[startLine].search(/\S/);
  let last = startLine;
  for (let i = startLine + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') {
      // Blank lines inside a block are part of it
      continue;
    }
    const indent = line.search(/\S/);
    if (indent <= defIndent) break;
    last = i;
  }
  return last;
}

/**
 * Parse an import statement, handling multi-line imports.
 * Returns the module path, named bindings, and end line.
 */
export function parseImport(
  line: string,
  lines: string[],
  startLine: number,
): { modulePath: string; bindings: string[]; endLine: number } | null {
  // Named imports: import { A, B } from '...'
  const namedMatch = line.match(/import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/);
  if (namedMatch) {
    const bindings = namedMatch[1]
      .split(',')
      .map((b) =>
        b
          .trim()
          .split(/\s+as\s+/)[0]
          .trim(),
      )
      .filter(Boolean);
    return { modulePath: namedMatch[2], bindings, endLine: startLine };
  }

  // Multi-line named imports: import {\n  A,\n  B\n} from '...'
  if (line.match(/import\s+\{/) && !line.includes('}')) {
    let endLine = startLine;
    let accumulated = line;
    for (let j = startLine + 1; j < lines.length && j < startLine + 20; j++) {
      accumulated += ' ' + lines[j];
      if (lines[j].includes('}')) {
        endLine = j;
        break;
      }
    }
    const multiMatch = accumulated.match(/import\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/);
    if (multiMatch) {
      const bindings = multiMatch[1]
        .split(',')
        .map((b) =>
          b
            .trim()
            .split(/\s+as\s+/)[0]
            .trim(),
        )
        .filter(Boolean);
      return { modulePath: multiMatch[2], bindings, endLine };
    }
  }

  // Default import: import Foo from '...'
  const defaultMatch = line.match(/import\s+([a-zA-Z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/);
  if (defaultMatch) {
    return { modulePath: defaultMatch[2], bindings: ['default'], endLine: startLine };
  }

  // Star import: import * as Foo from '...'
  const starMatch = line.match(/import\s+\*\s+as\s+([a-zA-Z_$][\w$]*)\s+from\s+['"]([^'"]+)['"]/);
  if (starMatch) {
    return { modulePath: starMatch[2], bindings: ['*'], endLine: startLine };
  }

  // Side-effect import: import '...'
  const sideEffectMatch = line.match(/import\s+['"]([^'"]+)['"]/);
  if (sideEffectMatch) {
    return { modulePath: sideEffectMatch[1], bindings: [], endLine: startLine };
  }

  return null;
}

/**
 * Best-effort resolution of a relative import path to a file path.
 * Tries common extensions (.ts, .tsx, .js, .jsx) and index files.
 */
export function resolveImportPath(importerFile: string, moduleSpecifier: string): string | null {
  // Only resolve relative imports
  if (!moduleSpecifier.startsWith('.')) return null;

  const importerDir = importerFile.substring(0, importerFile.lastIndexOf('/'));
  const segments = moduleSpecifier.split('/');
  const resolved: string[] = importerDir ? importerDir.split('/') : [];

  for (const seg of segments) {
    if (seg === '.') continue;
    if (seg === '..') {
      resolved.pop();
    } else {
      resolved.push(seg);
    }
  }

  return resolved.join('/');
}
