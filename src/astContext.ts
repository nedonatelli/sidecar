/**
 * AST-based context selection for smarter code analysis
 * This module provides functionality to identify relevant code elements
 * (functions, classes, methods) based on query content.
 */

export interface CodeElement {
  type: 'function' | 'class' | 'method' | 'variable' | 'import' | 'export';
  name: string;
  startLine: number;
  endLine: number;
  content: string;
  relevanceScore: number;
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
   * Parse a file and extract code elements with their full bodies.
   */
  static parseFileContent(filePath: string, content: string): ParsedFile {
    const elements: CodeElement[] = [];
    const lines = content.split('\n');
    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    const isPython = ext === '.py';

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // --- JS/TS: function declarations ---
      if (!isPython && line.includes('function ') && !line.includes('function(')) {
        const match = line.match(/function\s+([a-zA-Z_$][\w$]*)/);
        if (match && match[1]) {
          const endLine = this.findBlockEnd(lines, i);
          elements.push({
            type: 'function',
            name: match[1],
            startLine: i,
            endLine,
            content: lines.slice(i, endLine + 1).join('\n'),
            relevanceScore: 0.8,
          });
        }
      }

      // --- JS/TS: arrow / const function expressions ---
      if (!isPython) {
        const arrowMatch = line.match(
          /(?:export\s+)?(?:const|let|var)\s+([a-zA-Z_$][\w$]*)\s*=\s*(?:async\s+)?(?:\(|[a-zA-Z_$])/,
        );
        if (arrowMatch && arrowMatch[1] && (line.includes('=>') || lines[i + 1]?.includes('=>'))) {
          const endLine = line.includes('{') ? this.findBlockEnd(lines, i) : i;
          elements.push({
            type: 'function',
            name: arrowMatch[1],
            startLine: i,
            endLine,
            content: lines.slice(i, endLine + 1).join('\n'),
            relevanceScore: 0.8,
          });
        }
      }

      // --- JS/TS/Python: class definitions ---
      if (line.match(/^\s*(?:export\s+)?class\s/)) {
        const match = line.match(/class\s+([a-zA-Z_$][\w$]*)/);
        if (match && match[1]) {
          const endLine = isPython ? this.findIndentEnd(lines, i) : this.findBlockEnd(lines, i);
          elements.push({
            type: 'class',
            name: match[1],
            startLine: i,
            endLine,
            content: lines.slice(i, endLine + 1).join('\n'),
            relevanceScore: 0.9,
          });
        }
      }

      // --- Python: def / async def ---
      if (isPython && line.match(/^\s*(?:async\s+)?def\s/)) {
        const match = line.match(/def\s+([a-zA-Z_]\w*)/);
        if (match && match[1]) {
          const endLine = this.findIndentEnd(lines, i);
          elements.push({
            type: 'function',
            name: match[1],
            startLine: i,
            endLine,
            content: lines.slice(i, endLine + 1).join('\n'),
            relevanceScore: 0.8,
          });
        }
      }

      // --- Rust: fn ---
      if (ext === '.rs' && line.match(/^\s*(?:pub\s+)?(?:async\s+)?fn\s/)) {
        const match = line.match(/fn\s+([a-zA-Z_]\w*)/);
        if (match && match[1]) {
          const endLine = this.findBlockEnd(lines, i);
          elements.push({
            type: 'function',
            name: match[1],
            startLine: i,
            endLine,
            content: lines.slice(i, endLine + 1).join('\n'),
            relevanceScore: 0.8,
          });
        }
      }

      // --- Go: func ---
      if (ext === '.go' && line.match(/^func\s/)) {
        const match = line.match(/func\s+(?:\([^)]*\)\s+)?([a-zA-Z_]\w*)/);
        if (match && match[1]) {
          const endLine = this.findBlockEnd(lines, i);
          elements.push({
            type: 'function',
            name: match[1],
            startLine: i,
            endLine,
            content: lines.slice(i, endLine + 1).join('\n'),
            relevanceScore: 0.8,
          });
        }
      }

      // --- Java/Kotlin: method-level (simplified) ---
      if (
        (ext === '.java' || ext === '.kt') &&
        line.match(/^\s*(?:public|private|protected|internal)?\s*(?:static\s+)?(?:fun\s|[\w<>\[\]]+\s+\w+\s*\()/)
      ) {
        const match = line.match(/(?:fun\s+)?([a-zA-Z_]\w*)\s*\(/);
        if (match && match[1] && !['if', 'for', 'while', 'switch', 'catch'].includes(match[1])) {
          const endLine = this.findBlockEnd(lines, i);
          elements.push({
            type: 'method',
            name: match[1],
            startLine: i,
            endLine,
            content: lines.slice(i, endLine + 1).join('\n'),
            relevanceScore: 0.8,
          });
        }
      }

      // --- Import statements (all languages) ---
      if (line.match(/^\s*import\s/) && line.includes('from')) {
        const match = line.match(/import\s+(?:.*\s+from\s+)?['"](.*?)['"]/);
        if (match && match[1]) {
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

      // --- Export-from statements ---
      if (line.match(/^\s*export\s/) && line.includes('from')) {
        const match = line.match(/export\s+(?:.*\s+from\s+)?['"](.*?)['"]/);
        if (match && match[1]) {
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
