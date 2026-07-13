/**
 * Analyzer registry: returns the best available code analyzer for a given file extension.
 * Lazy-loads tree-sitter on first call. Falls back to regex on failure.
 */

import type { CodeAnalyzer, CodeElement, ParsedFile } from './types.js';
import { logger } from '../system/logger.js';
import { SimpleCodeAnalyzer } from '../astContext.js';

// File extensions the regex parser handles
const REGEX_EXTENSIONS = new Set([
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'kts',
  'cs',
  'rb',
  'swift',
  'c',
  'h',
  'cpp',
  'cc',
  'cxx',
  'hpp',
  'hh',
  'sh',
  'bash',
  'zsh',
  'php',
  'lua',
  'scala',
  'dart',
  'vue',
]);

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
 * Where the grammar wasm files live, or null before activation wires it.
 * The edit-time syntax guard (`agent/tools/syntaxCheck.ts`) needs this to load
 * ONE grammar for the file it is checking — going through `getAnalyzer` would
 * drag in all 19 grammars serially (measured: 3m20s cold in the extension
 * host, which stalled an edit that long before failing open).
 */
export function getGrammarsPath(): string | null {
  return extensionGrammarsPath;
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
      logger.warn('[SideCar] Tree-sitter unavailable, using regex parser:', err);
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
