/**
 * AST-based context selection for smarter code analysis
 * This module provides functionality to identify relevant code elements
 * (functions, classes, methods) based on query content.
 */

import { workspace, Uri } from 'vscode';
import { LimitedCache } from './agent/memoryManager.js';

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
   * Parse a file and extract code elements
   */
  static parseFileContent(filePath: string, content: string): ParsedFile {
    const elements: CodeElement[] = [];
    const lines = content.split('\n');

    // Simple approach: look for function/class definitions
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Look for function definitions
      if (line.includes('function ') && !line.includes('function(')) {
        const match = line.match(/function\s+([a-zA-Z_$][\w$]*)/);
        if (match && match[1]) {
          elements.push({
            type: 'function',
            name: match[1],
            startLine: i,
            endLine: i,
            content: line,
            relevanceScore: 0.8,
          });
        }
      }

      // Look for class definitions
      if (line.includes('class ')) {
        const match = line.match(/class\s+([a-zA-Z_$][\w$]*)/);
        if (match && match[1]) {
          elements.push({
            type: 'class',
            name: match[1],
            startLine: i,
            endLine: i,
            content: line,
            relevanceScore: 0.9,
          });
        }
      }

      // Look for import statements
      if (line.includes('import ') && line.includes('from')) {
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

      // Look for export statements
      if (line.includes('export ') && line.includes('from')) {
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

      element.relevanceScore = score;

      if (score > 0.3) {
        relevantElements.push(element);
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
      // Return a snippet of the file if no elements found
      const lines = parsedFile.content.split('\n');
      return lines.slice(0, 20).join('\n') + (lines.length > 20 ? '\n...' : '');
    }

    // Get the lines that contain relevant elements
    const relevantLines = new Set<number>();

    const lines = parsedFile.content.split('\n');

    for (const element of relevantElements) {
      // Include a few lines before and after the element
      for (let i = Math.max(0, element.startLine - 2); i <= Math.min(element.endLine + 2, lines.length - 1); i++) {
        relevantLines.add(i);
      }
    }
    const relevantContent = Array.from(relevantLines)
      .sort((a, b) => a - b)
      .map((lineIndex) => lines[lineIndex])
      .join('\n');

    return relevantContent;
  }
}

/**
 * Enhanced workspace index with smart context selection
 */
export class SmartWorkspaceIndex {
  private parsedFiles = new LimitedCache<string, ParsedFile>(50, 300000); // 50 items, 5 minute TTL
  private maxContextChars: number;

  constructor(maxContextChars = 20_000) {
    this.maxContextChars = maxContextChars;
  }

  /**
   * Parse a file and cache its parsed content
   */
  async parseFile(filePath: string): Promise<ParsedFile> {
    const folders = workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return { filePath, elements: [], content: '' };
    }

    const rootUri = folders[0].uri;
    const fileUri = Uri.joinPath(rootUri, filePath);

    try {
      const bytes = await workspace.fs.readFile(fileUri);
      const content = Buffer.from(bytes).toString('utf-8');
      const parsed = SimpleCodeAnalyzer.parseFileContent(filePath, content);
      this.parsedFiles.set(filePath, parsed);
      return parsed;
    } catch (error) {
      console.error(`Failed to parse file ${filePath}:`, error);
      return { filePath, elements: [], content: '' };
    }
  }

  /**
   * Get relevant context with smart code element selection
   */
  async getSmartContext(query: string, activeFilePath?: string, _maxElementsPerFile = 3): Promise<string> {
    // TODO: Integrate with WorkspaceIndex to provide AST-aware context selection.
    // This should replace full-file inclusion with targeted function/class extraction.
    return '';
  }

  /**
   * Get the parsed file content (for testing/debugging)
   */
  getParsedFile(filePath: string): ParsedFile | undefined {
    return this.parsedFiles.get(filePath);
  }
}
