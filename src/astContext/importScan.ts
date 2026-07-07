/**
 * Line-scanning + import-parsing primitives for the lightweight code analyzer.
 * Pure string helpers — no tree-sitter, no VS Code — shared by
 * SimpleCodeAnalyzer.parseFileContent.
 */

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
