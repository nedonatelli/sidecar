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
  // Any Python environment, whatever its directory is called. `.venv`/`venv`
  // above only catch the two conventional names — a `.graphify-venv` created
  // for the code-graph differential put 23,284 symbols across 1,348
  // site-packages files into the symbol graph, 76% of its entire contents.
  // Every virtualenv layout puts its packages under `site-packages`, so
  // excluding that catches the class rather than the instance.
  'site-packages',
  // Debian and Ubuntu system Python install to `dist-packages` instead, so
  // `site-packages` alone fixes this on macOS and leaves it on the platform
  // where a system interpreter is most likely to be on the workspace path.
  'dist-packages',
  '__pycache__',
  'target',
  'vendor',
  '.sidecar',
  '.turbo',
  '.cache',
  // Deliberately malformed byte fixtures — BOM variants, CR/CRLF/mixed line
  // endings, NBSP, trailing whitespace, no-final-newline — used to test file
  // handling. Not source, and 23 of their symbols were reaching the graph,
  // where they compete at retrieval with the code that handles those cases.
  // `scripts/graph-differential.mjs` already listed this directory as a
  // legitimate miss, so the indexer and the check disagreed about what counts
  // as source; this makes reality match the check.
  //
  // The sibling `__fixtures__` needs no entry: its files are all `.py.txt`, so
  // no code extension matches and nothing indexes them. Adding it would be a
  // guess dressed as symmetry.
  '__corpus__',
  // Stryker copies the entire repo into a sandbox per mutation run.
  '.stryker-tmp',
  // graphify writes its ~7 MB graph into the directory it scans.
  'graphify-out',
] as const;

/** VS Code `findFiles` exclude pattern covering all of {@link INDEX_EXCLUDE_DIRS}. */
export const INDEX_EXCLUDE_PATTERN = `**/{${INDEX_EXCLUDE_DIRS.join(',')}}/**`;

/**
 * `maxResults` for a whole-workspace index scan.
 *
 * `workspace.findFiles` truncates at `maxResults` and says nothing about it —
 * the caller receives a short array indistinguishable from a small workspace.
 * The symbol indexer passed 1000 while this repo has 1035 `.ts` files, so every
 * index run silently dropped ~35 of them, a different ~35 each time depending
 * on walk order. 30 of `src/config`'s 64 files were missing on the run that
 * produced the cached graph, taking ~72 exported symbols out of
 * `find_references`, `analyze_impact` and PKI retrieval with them.
 *
 * A cap is still wanted — an unbounded scan of a huge monorepo is its own
 * failure — but it has to be high enough that reaching it is genuinely
 * exceptional, and reaching it has to be audible. See
 * {@link indexScanTruncated}.
 */
export const INDEX_MAX_FILES_PER_PATTERN = 10_000;

/**
 * Warning text for a scan that came back at its limit, or null when it did not.
 *
 * Split out as a pure function so the condition can be tested without a
 * workspace: this is the check that turns a silent wrong answer into a loud
 * one, and it fires only on workspaces larger than any fixture.
 */
export function indexScanTruncated(scanner: string, pattern: string, returned: number): string | null {
  if (returned < INDEX_MAX_FILES_PER_PATTERN) return null;
  return (
    `[${scanner}] "${pattern}" returned ${returned} files, the maximum this scan requests. ` +
    `Results are truncated, so the index is INCOMPLETE — symbols and files past the limit are ` +
    `invisible to search, find_references and analyze_impact. Narrow the workspace, or exclude ` +
    `directories that do not need indexing.`
  );
}
