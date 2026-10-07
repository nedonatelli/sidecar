/**
 * Library names that look like file names. "Node.js", "Vue.js" and "Chart.js"
 * match every file-reference regex in the agent, so "explain how Node.js
 * streams work" read as a request about a workspace file: the read gate asked
 * for a read of a file that doesn't exist, and fence-write coercion could write
 * a file literally named `Node.js`.
 */
const JS_LIBRARIES = new Set([
  'alpine',
  'angular',
  'backbone',
  'chart',
  'd3',
  'deno',
  'ember',
  'express',
  'knockout',
  'meteor',
  'nest',
  'next',
  'node',
  'nuxt',
  'preact',
  'react',
  'solid',
  'svelte',
  'three',
  'vue',
]);

/**
 * True when `ref` names a library, not a file: a bare (no directory) known
 * name with a `.js` suffix, written the way the project spells it, capitalized
 * ("Node.js", "D3.js"). A lowercase `chart.js`, or one under a directory, is
 * still a file, and `App.js` is not in the list.
 */
export function isLibraryName(ref: string): boolean {
  const m = /^([A-Za-z0-9]+)\.js$/.exec(ref);
  if (!m) return false;
  return /^[A-Z0-9]/.test(m[1]) && JS_LIBRARIES.has(m[1].toLowerCase());
}
