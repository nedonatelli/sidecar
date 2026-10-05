import type { ToolDefinition } from '../../src/ollama/types.js';

/**
 * Tools the SWE harness removes from the agent's catalog, with why. Removed,
 * not discouraged: negative instructions do not hold at a 27K-token context
 * (the prompt said "NOT run_tests" and the model used it on the first task).
 * A tool that is not offered also cannot run -- the loop's catalog gate.
 */
export const SWE_EXCLUDED_TOOLS: ReadonlyMap<string, string> = new Map([
  [
    'run_tests',
    'Its runner auto-detection picked npm in repos that also ship a package.json: on django it ran ' +
      '`pretest > eslint ...` -- linting JavaScript, not running Python tests -- and reported ok.',
  ],
  [
    'web_search',
    'Contamination. Every task is a fixed, public upstream bug, so a search can find the fix itself: ' +
      '6 runs in the last two matrices searched, e.g. "sphinx autodoc annotation only member superclass ' +
      'undocumented fix". The benchmark measures solving from the repository, not finding the answer online.',
  ],
]);

/** The SWE agent's tool catalog: the product's, minus SWE_EXCLUDED_TOOLS. */
export function sweToolCatalog(defs: ToolDefinition[]): ToolDefinition[] {
  return defs.filter((t) => !SWE_EXCLUDED_TOOLS.has(t.name));
}
