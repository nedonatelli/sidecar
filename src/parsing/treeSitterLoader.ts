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

/**
 * The runtime state, shared by every copy of this module in the process.
 *
 * web-tree-sitter is one Emscripten runtime per process, and `Language.load`
 * mutates it: two loads in flight at once corrupt each other ("memory access
 * out of bounds", "table index is out of bounds"). Module-level state only
 * serialized loads within ONE copy of this module, and the extension bundle
 * and anything importing the compiled sources (the integration tests) are two
 * copies -- each called `init` and loaded every grammar alongside the other,
 * and every grammar failed in both.
 */
interface SharedTreeSitterState {
  init: Promise<Awaited<TreeSitterModule>> | null;
  languages: Map<string, Promise<Language>>;
  /** Tail of the queue every `Language.load` runs through, one at a time. */
  loadChain: Promise<unknown>;
}

const SHARED_KEY = Symbol.for('sidecar.webTreeSitter.state');

function shared(): SharedTreeSitterState {
  const g = globalThis as unknown as Record<symbol, SharedTreeSitterState | undefined>;
  return (g[SHARED_KEY] ??= { init: null, languages: new Map(), loadChain: Promise.resolve() });
}

/**
 * Initialize the web-tree-sitter WASM runtime. Called once per process;
 * subsequent calls return the cached module.
 */
export async function initTreeSitter(wasmDir: string): Promise<Awaited<TreeSitterModule>> {
  const state = shared();
  state.init ??= (async () => {
    const TreeSitter = (await import('web-tree-sitter')).default;
    await TreeSitter.init({
      locateFile: () => path.join(wasmDir, 'tree-sitter.wasm'),
    });
    return TreeSitter;
  })().catch((err: unknown) => {
    state.init = null; // a failed init may be retried
    throw err;
  });
  return state.init;
}

/**
 * Grammars that are never loaded, and why.
 *
 * A grammar's external scanner is C compiled to WASM, and the functions it
 * imports must be exported by web-tree-sitter's runtime. bash's scanner calls
 * `isalpha`, which web-tree-sitter 0.24 does not export: scanning ordinary
 * shell (3 of this repo's 7 scripts) throws "resolved is not a function" from
 * inside a parse. An exception unwound through the runtime leaves it corrupt,
 * and in the extension host every later parse, in every language, then failed
 * with "memory access out of bounds" -- 102 of 3,449 files went missing from
 * the symbol graph, silently. Shell files fall back to the regex analyzer.
 *
 * Other grammars import only `__assert_fail` / `abort`, reached only when a
 * scanner's own assertion fails; a parse that throws disables its language
 * (see TreeSitterCodeAnalyzer.parseFileContent).
 */
export const DISABLED_GRAMMARS: ReadonlyMap<string, string> = new Map([
  ['bash', "its scanner imports isalpha, which web-tree-sitter's runtime does not export"],
]);

/**
 * Load a language grammar WASM file. Cached per language name, and loaded
 * one at a time across the whole process.
 */
export async function loadLanguage(wasmDir: string, languageName: string): Promise<Language> {
  const disabled = DISABLED_GRAMMARS.get(languageName);
  if (disabled) throw new Error(`tree-sitter grammar '${languageName}' is disabled: ${disabled}`);
  const state = shared();
  const cached = state.languages.get(languageName);
  if (cached) return cached;

  const load = state.loadChain.then(async () => {
    const TreeSitter = await initTreeSitter(wasmDir);
    return TreeSitter.Language.load(path.join(wasmDir, `tree-sitter-${languageName}.wasm`));
  });
  state.loadChain = load.catch(() => undefined);
  state.languages.set(languageName, load);
  load.catch(() => state.languages.delete(languageName)); // a failed load may be retried
  return load;
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
