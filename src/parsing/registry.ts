/**
 * Analyzer registry: returns the best available code analyzer for a given file extension.
 * Lazy-loads tree-sitter on first call. Falls back to regex on failure.
 */

import type { CodeAnalyzer, CodeElement, ParsedFile } from './types.js';
import { SimpleCodeAnalyzer } from '../astContext.js';

// File extensions the regex parser handles
const REGEX_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'java', 'kt']);

/**
 * Wraps SimpleCodeAnalyzer's static methods into the CodeAnalyzer interface.
 */
class RegexAnalyzer implements CodeAnalyzer {
  readonly supportedExtensions = REGEX_EXTENSIONS;

  parseFileContent(filePath: string, content: string): ParsedFile {
    return SimpleCodeAnalyzer.parseFileContent(filePath, content);
  }

  findRelevantElements(parsedFile: ParsedFile, query: string): CodeElement[] {
    return SimpleCodeAnalyzer.findRelevantElements(parsedFile, query);
  }

  extractRelevantContent(parsedFile: ParsedFile, relevantElements: CodeElement[]): string {
    return SimpleCodeAnalyzer.extractRelevantContent(parsedFile, relevantElements);
  }
}

const regexAnalyzer = new RegexAnalyzer();

let treeSitterAnalyzer: CodeAnalyzer | null = null;
let treeSitterLoadAttempted = false;
let extensionGrammarsPath: string | null = null;

/**
 * Set the path to the grammars directory (called from extension.ts on activation).
 */
export function setGrammarsPath(grammarsPath: string): void {
  extensionGrammarsPath = grammarsPath;
}

/**
 * Get the best available analyzer for a file extension.
 * Lazy-loads tree-sitter on first call. Falls back to regex on failure.
 */
export async function getAnalyzer(fileExtension: string): Promise<CodeAnalyzer> {
  if (!treeSitterLoadAttempted && extensionGrammarsPath) {
    treeSitterLoadAttempted = true;
    try {
      // Dynamic import with indirection to prevent tsc from resolving the module
      // statically. treeSitterAnalyzer.ts is optional — it only exists when
      // tree-sitter grammars are installed.
      const modulePath = './treeSitterAnalyzer.js';
      const mod = await import(modulePath).catch(() => null);
      if (mod?.createTreeSitterAnalyzer) {
        treeSitterAnalyzer = await mod.createTreeSitterAnalyzer(extensionGrammarsPath);
      }
    } catch (err) {
      console.warn('[SideCar] Tree-sitter unavailable, using regex parser:', err);
    }
  }

  if (treeSitterAnalyzer?.supportedExtensions.has(fileExtension)) {
    return treeSitterAnalyzer;
  }

  return regexAnalyzer;
}

/**
 * Synchronous fallback — always returns the regex analyzer.
 * Use when you cannot await (e.g., in synchronous hot paths).
 */
export function getRegexAnalyzer(): CodeAnalyzer {
  return regexAnalyzer;
}
