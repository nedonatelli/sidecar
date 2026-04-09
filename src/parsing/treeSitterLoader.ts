/**
 * Lazy-loads the web-tree-sitter WASM runtime and language grammars.
 * Grammars are cached after first load.
 */

import * as path from 'path';

// web-tree-sitter types
type TreeSitterModule = typeof import('web-tree-sitter');
type Parser = InstanceType<Awaited<TreeSitterModule>>;
type Language = Awaited<ReturnType<Awaited<TreeSitterModule>['Language']['load']>>;

export type { Parser, Language };

let parserClass: Awaited<TreeSitterModule> | null = null;
let initPromise: Promise<Awaited<TreeSitterModule>> | null = null;
const loadedLanguages = new Map<string, Language>();

/**
 * Initialize the web-tree-sitter WASM runtime. Called once; subsequent calls
 * return the cached module.
 */
export async function initTreeSitter(wasmDir: string): Promise<Awaited<TreeSitterModule>> {
  if (parserClass) return parserClass;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    const TreeSitter = (await import('web-tree-sitter')).default;
    await TreeSitter.init({
      locateFile: () => path.join(wasmDir, 'tree-sitter.wasm'),
    });
    parserClass = TreeSitter;
    return TreeSitter;
  })();

  return initPromise;
}

/**
 * Load a language grammar WASM file. Cached per language name.
 */
export async function loadLanguage(wasmDir: string, languageName: string): Promise<Language> {
  const cached = loadedLanguages.get(languageName);
  if (cached) return cached;

  const TreeSitter = await initTreeSitter(wasmDir);
  const wasmPath = path.join(wasmDir, `tree-sitter-${languageName}.wasm`);
  const lang = await TreeSitter.Language.load(wasmPath);
  loadedLanguages.set(languageName, lang);
  return lang;
}

/**
 * Create a new Parser instance with the given language.
 */
export async function createParser(wasmDir: string, languageName: string): Promise<Parser> {
  const TreeSitter = await initTreeSitter(wasmDir);
  const lang = await loadLanguage(wasmDir, languageName);
  const parser = new TreeSitter();
  parser.setLanguage(lang);
  return parser;
}
