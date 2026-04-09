/**
 * AST-based context selection for smarter code analysis
 * This module provides functionality to identify relevant code elements
 * (functions, classes, methods) based on query content.
 */

export interface CodeElement {
  type: 'function' | 'class' | 'method' | 'variable' | 'import' | 'export' | 'interface' | 'type' | 'enum';
  name: string;
  startLine: number;
  endLine: number;
  content: string;
  relevanceScore: number;
  /** Whether the symbol has an `export` modifier. */
  exported?: boolean;
  /** For imports: the named bindings imported (e.g. ['A', 'B'] from `import { A, B } from ...`). */
  bindings?: string[];
}

export interface ParsedFile {
  filePath: string;
  elements: CodeElement[];
  content: string;
}

/**
 * Simple code element extractor for common languages
 * This is a lightweight implementation that doesn't require heavy tree-sitter dependencies
 */
export class SimpleCodeAnalyzer {
  /**
   * Find the closing brace for a block that starts on `startLine`.
   * Counts `{` / `}` from the start line forward.  Returns the line
   * index of the matching `}`, or the last line of the file.
   */
  private static findBlockEnd(lines: string[], startLine: number): number {
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
  private static findIndentEnd(lines: string[], startLine: number): number {
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
  private static parseImport(
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
  static resolveImportPath(importerFile: string, moduleSpecifier: string): string | null {
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

  /**
   * Parse a file and extract code elements with their full bodies.
   */
  static parseFileContent(filePath: string, content: string): ParsedFile {
    const elements: CodeElement[] = [];
    const lines = content.split('\n');
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();

    // Determine language family once to avoid testing irrelevant patterns per line.
    const lang: 'js' | 'py' | 'rs' | 'go' | 'jvm' | 'other' = ['.js', '.ts', '.jsx', '.tsx'].includes(ext)
      ? 'js'
      : ext === '.py'
        ? 'py'
        : ext === '.rs'
          ? 'rs'
          : ext === '.go'
            ? 'go'
            : ['.java', '.kt'].includes(ext)
              ? 'jvm'
              : 'other';

    const usesBraces = lang !== 'py';
    const CONTROL_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch']);

    // Helper: build content string from line range (deferred to avoid O(n) per element during scan)
    const buildContent = (start: number, end: number) => lines.slice(start, end + 1).join('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // --- Language-specific function/method patterns ---
      if (lang === 'js') {
        const isExported = /^\s*export\s/.test(line);

        // Function declarations
        if (line.includes('function ') && !line.includes('function(')) {
          const match = line.match(/function\s+([a-zA-Z_$][\w$]*)/);
          if (match) {
            const endLine = this.findBlockEnd(lines, i);
            elements.push({
              type: 'function',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
              exported: isExported,
            });
          }
        }
        // Arrow / const function expressions
        const arrowMatch = line.match(
          /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\(|[a-zA-Z_$])/,
        );
        if (arrowMatch && (line.includes('=>') || lines[i + 1]?.includes('=>'))) {
          const endLine = line.includes('{') ? this.findBlockEnd(lines, i) : i;
          elements.push({
            type: 'function',
            name: arrowMatch[1],
            startLine: i,
            endLine,
            content: buildContent(i, endLine),
            relevanceScore: 0.8,
            exported: isExported,
          });
        }

        // Interface declarations (TypeScript)
        if (line.includes('interface ')) {
          const match = line.match(/interface\s+([a-zA-Z_$][\w$]*)/);
          if (match) {
            const endLine = this.findBlockEnd(lines, i);
            elements.push({
              type: 'interface',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.7,
              exported: isExported,
            });
          }
        }

        // Type alias declarations (TypeScript)
        if (line.includes('type ') && line.match(/^\s*(?:export\s+)?type\s+([a-zA-Z_$][\w$]*)\s*[=<]/)) {
          const match = line.match(/type\s+([a-zA-Z_$][\w$]*)/);
          if (match) {
            // Type aliases can be single-line or multi-line
            const endLine = line.includes('{') ? this.findBlockEnd(lines, i) : i;
            elements.push({
              type: 'type',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.6,
              exported: isExported,
            });
          }
        }

        // Enum declarations (TypeScript)
        if (line.includes('enum ')) {
          const match = line.match(/(?:const\s+)?enum\s+([a-zA-Z_$][\w$]*)/);
          if (match) {
            const endLine = this.findBlockEnd(lines, i);
            elements.push({
              type: 'enum',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.6,
              exported: isExported,
            });
          }
        }
      } else if (lang === 'py') {
        if (line.match(/^\s*(?:async\s+)?def\s/)) {
          const match = line.match(/def\s+([a-zA-Z_]\w*)/);
          if (match) {
            const endLine = this.findIndentEnd(lines, i);
            elements.push({
              type: 'function',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
      } else if (lang === 'rs') {
        if (line.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s/)) {
          const match = line.match(/fn\s+([a-zA-Z_]\w*)/);
          if (match) {
            const endLine = this.findBlockEnd(lines, i);
            elements.push({
              type: 'function',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
      } else if (lang === 'go') {
        if (line.match(/^func\s/)) {
          const match = line.match(/func\s+(?:\([^)]*\)\s+)?([a-zA-Z_]\w*)/);
          if (match) {
            const endLine = this.findBlockEnd(lines, i);
            elements.push({
              type: 'function',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
      } else if (lang === 'jvm') {
        if (line.match(/^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:fun\s|[\w<>\[\]]+\s+\w+\s*\()/)) {
          const match = line.match(/(?:fun\s+)?([a-zA-Z_]\w*)\s*\(/);
          if (match && !CONTROL_KEYWORDS.has(match[1])) {
            const endLine = this.findBlockEnd(lines, i);
            elements.push({
              type: 'method',
              name: match[1],
              startLine: i,
              endLine,
              content: buildContent(i, endLine),
              relevanceScore: 0.8,
            });
          }
        }
      }

      // --- Class definitions (most languages) ---
      if (line.match(/^\s*(?:export\s+)?class\s/)) {
        const match = line.match(/class\s+([a-zA-Z_$][\w$]*)/);
        if (match) {
          const isExportedClass = /^\s*export\s/.test(line);
          const endLine = usesBraces ? this.findBlockEnd(lines, i) : this.findIndentEnd(lines, i);
          elements.push({
            type: 'class',
            name: match[1],
            startLine: i,
            endLine,
            content: buildContent(i, endLine),
            relevanceScore: 0.9,
            exported: isExportedClass,
          });
        }
      }

      // --- Import statements with binding extraction ---
      if (line.includes('import') && line.match(/^\s*import\s/)) {
        const parsed = this.parseImport(line, lines, i);
        if (parsed) {
          elements.push({
            type: 'import',
            name: parsed.modulePath,
            startLine: i,
            endLine: parsed.endLine,
            content: buildContent(i, parsed.endLine),
            relevanceScore: 0.3,
            bindings: parsed.bindings,
          });
          // Skip past multi-line imports
          if (parsed.endLine > i) i = parsed.endLine;
        } else if (line.includes('from')) {
          // Fallback for unrecognized import patterns
          const match = line.match(/import\s+(?:.*\s+from\s+)?['"](.*?)['"]/);
          if (match) {
            elements.push({
              type: 'import',
              name: match[1],
              startLine: i,
              endLine: i,
              content: line,
              relevanceScore: 0.3,
            });
          }
        }
      }
      if (line.includes('export') && line.includes('from') && line.match(/^\s*export\s/)) {
        const match = line.match(/export\s+(?:.*\s+from\s+)?['"](.*?)['"]/);
        if (match) {
          elements.push({
            type: 'export',
            name: match[1],
            startLine: i,
            endLine: i,
            content: line,
            relevanceScore: 0.3,
          });
        }
      }
    }

    return {
      filePath,
      elements,
      content,
    };
  }

  /**
   * Find relevant code elements based on query terms
   */
  static findRelevantElements(parsedFile: ParsedFile, query: string): CodeElement[] {
    const relevantElements: CodeElement[] = [];
    const queryTerms = query
      .toLowerCase()
      .split(/\s+/)
      .filter((term) => term.length > 2);

    for (const element of parsedFile.elements) {
      let score = 0;

      // Check if element name matches query terms
      for (const term of queryTerms) {
        if (element.name.toLowerCase().includes(term)) {
          score += 0.5;
        }
      }

      // Check if element content matches query terms
      for (const term of queryTerms) {
        if (element.content.toLowerCase().includes(term)) {
          score += 0.3;
        }
      }

      // Boost based on element type
      if (element.type === 'function' || element.type === 'method') {
        score += 0.2;
      } else if (element.type === 'class') {
        score += 0.3;
      }

      if (score > 0.3) {
        relevantElements.push({ ...element, relevanceScore: score });
      }
    }

    // Sort by relevance score
    relevantElements.sort((a, b) => b.relevanceScore - a.relevanceScore);
    return relevantElements;
  }

  /**
   * Extract relevant portions of a file based on identified elements
   */
  static extractRelevantContent(parsedFile: ParsedFile, relevantElements: CodeElement[]): string {
    if (relevantElements.length === 0) {
      const lines = parsedFile.content.split('\n');
      return lines.slice(0, 20).join('\n') + (lines.length > 20 ? '\n...' : '');
    }

    const lines = parsedFile.content.split('\n');
    const relevantLines = new Set<number>();

    for (const element of relevantElements) {
      // Include 1 line of context before the element and the full body
      const start = Math.max(0, element.startLine - 1);
      const end = Math.min(element.endLine + 1, lines.length - 1);
      for (let i = start; i <= end; i++) {
        relevantLines.add(i);
      }
    }

    // Build output with `...` markers for skipped regions
    const sorted = Array.from(relevantLines).sort((a, b) => a - b);
    const parts: string[] = [];
    let prev = -2; // sentinel so first region doesn't get a gap marker

    for (const lineIdx of sorted) {
      if (lineIdx > prev + 1) {
        parts.push('...');
      }
      parts.push(lines[lineIdx]);
      prev = lineIdx;
    }

    // Trailing indicator if we didn't reach the end
    if (sorted[sorted.length - 1] < lines.length - 1) {
      parts.push('...');
    }

    return parts.join('\n');
  }
}
