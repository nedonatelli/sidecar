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
// The in-flight load, memoized. A boolean `attempted` flag here was a race: it
// flipped the instant the first caller arrived, while the analyzer it gates on
// is not assigned until grammar loading finishes ~seconds later. The symbol
// indexer calls getAnalyzer CONCURRENTLY for every file in the workspace via
// Promise.allSettled, so all but the first saw the flag already set, skipped
// the load block, found treeSitterAnalyzer still null and took the regex
// fallback. The grammars loaded fine — into a variable nobody was waiting on.
// Holding the promise makes every concurrent caller await the same load.
let treeSitterLoad: Promise<void> | null = null;
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
  if (!treeSitterLoad && extensionGrammarsPath) {
    const grammarsPath = extensionGrammarsPath;
    treeSitterLoad = (async () => {
      try {
        // A LITERAL specifier, deliberately. This used to route through a
        // `const modulePath = './treeSitterAnalyzer.js'` indirection whose
        // comment said the module was optional — it is tracked in git and
        // always present, so that was stale. What the indirection still did was
        // stop esbuild resolving it, leaving a runtime import in the bundle
        // pointing at a file `dist/` does not contain, so every packaged
        // install threw ERR_MODULE_NOT_FOUND here (#47).
        const mod = await import('./treeSitterAnalyzer.js');
        treeSitterAnalyzer = await mod.createTreeSitterAnalyzer(grammarsPath);
      } catch (err) {
        // NOT swallowed. A `.catch(() => null)` used to sit inside this try and
        // absorb exactly the failure above, so a silently degraded parser
        // looked identical to a working one.
        logger.warn(
          '[SideCar] Tree-sitter failed to load — falling back to the regex parser. ' +
            'Symbol extraction will be less precise (find_references, analyze_impact, PKI retrieval).',
          err,
        );
      }
    })();
  }
  // Await the shared load. Individual grammars that fail (an ABI mismatch on
  // one language, say) are handled inside createTreeSitterAnalyzer and do not
  // deny the rest — only a total failure lands in the catch above.
  if (treeSitterLoad) await treeSitterLoad;

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
