/**
 * The one exclude glob every workspace-wide scan should use.
 *
 * Six separate `findFiles` call sites had grown six different exclude lists,
 * and the documentation indexer's was the shortest — just `node_modules`. On a
 * real activation that meant indexing 2.2 GB of `.vscode-test/`: three complete
 * VS Code app bundles, contributing a README for every extension Microsoft
 * ships, three times over. Those entries do not merely waste time; they compete
 * with the user's own documentation at retrieval.
 *
 * Every directory here is either a build output, a dependency tree, or a tool
 * artifact — never authored content. `.sidecar` is excluded because it holds
 * SideCar's own caches and logs; indexing them feeds the agent its own exhaust.
 */
export const INDEX_EXCLUDE_DIRS = [
  'node_modules',
  '.git',
  '.vscode-test',
  'out',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  'vendor',
  '.sidecar',
] as const;

/** VS Code `findFiles` exclude pattern covering all of {@link INDEX_EXCLUDE_DIRS}. */
export const INDEX_EXCLUDE_PATTERN = `**/{${INDEX_EXCLUDE_DIRS.join(',')}}/**`;
