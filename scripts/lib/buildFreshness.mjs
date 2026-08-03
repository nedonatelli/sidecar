import { readdir, stat } from 'fs/promises';
import * as path from 'path';

/**
 * Detect an integration suite about to run against a build that does not
 * contain the source it claims to test.
 *
 * `npm run test:integration` used to compile only the integration tsconfig and
 * then launch `vscode-test` against whatever `out/` and `dist/` happened to
 * hold. A dogfood run reported five passing tests for code that was not in the
 * build. The pass was real; what it validated was not what anyone thought.
 *
 * The artifact that actually goes stale is `dist/extension.js`. Measured, not
 * assumed: the integration tsconfig sets `rootDir` to the repo root, so
 * compiling it pulls the tests' transitive imports along and writes them to
 * `out/src/**` — that tree is current. `dist/extension.js` is written only by
 * `npm run bundle`, which the suite never invoked, so the extension the host
 * loads could be any age while the test code was current.
 *
 * `out/src/**` is still checked, because `npx vscode-test` skips the npm
 * script and therefore skips that compile. It is checked at `out/src`
 * specifically and not at `out/`: `npm run compile` uses `rootDir: ./src` and
 * writes a second, parallel tree at `out/**` that these tests never load. A
 * freshly built `out/agent/` would otherwise mask a stale `out/src/agent/`.
 *
 * The comparison is newest-source against newest-artifact. A build reads
 * sources and then writes outputs, so an artifact older than the newest source
 * cannot contain it. tsc rewriting only changed files is fine — the file you
 * edited is always among them.
 */

/** Directories never worth walking for source mtimes. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist', '.vscode-test', 'coverage', '.sidecar']);

/**
 * Newest mtime (ms) among files under `dir` matching `matches`, or 0 when the
 * directory is absent or holds no match.
 */
export async function newestMtime(dir, matches) {
  let newest = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0; // absent directory — the caller reports it as a missing artifact
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      newest = Math.max(newest, await newestMtime(full, matches));
    } else if (matches(entry.name)) {
      const s = await stat(full);
      newest = Math.max(newest, s.mtimeMs);
    }
  }
  return newest;
}

/**
 * Compare one artifact's mtime against the newest source mtime.
 *
 * Split out from the filesystem walk so the decision is testable without
 * building anything: a guard whose firing has never been observed is not known
 * to work, and this one only ever fires on a workstation mid-mistake.
 *
 * @returns a human-readable problem, or null when the artifact is current.
 */
export function staleness({ name, artifactMtime, newestSourceMtime, newestSourceFile, builtBy }) {
  if (artifactMtime === 0) {
    return `${name} is missing entirely — run \`${builtBy}\``;
  }
  if (artifactMtime < newestSourceMtime) {
    const behind = Math.round((newestSourceMtime - artifactMtime) / 1000);
    const ago = behind < 120 ? `${behind}s` : `${Math.round(behind / 60)}m`;
    return `${name} is ${ago} older than ${newestSourceFile} — run \`${builtBy}\``;
  }
  return null;
}

/**
 * Check every artifact the integration suite depends on.
 *
 * @returns array of problem strings; empty means the build is current.
 */
export async function findStaleArtifacts(root = process.cwd()) {
  const isTs = (n) => n.endsWith('.ts') && !n.endsWith('.d.ts');
  const srcDir = path.join(root, 'src');
  const newestSourceMtime = await newestMtime(srcDir, isTs);
  if (newestSourceMtime === 0) return []; // no sources — nothing to be stale against

  const newestSourceFile = await newestFileNamed(srcDir, isTs, newestSourceMtime, root);

  const outMtime = await newestMtime(path.join(root, 'out', 'src'), (n) => n.endsWith('.js'));
  let distMtime = 0;
  try {
    distMtime = (await stat(path.join(root, 'dist', 'extension.js'))).mtimeMs;
  } catch {
    distMtime = 0;
  }

  return [
    staleness({
      name: 'out/src/ (the code the integration tests require())',
      artifactMtime: outMtime,
      newestSourceMtime,
      newestSourceFile,
      builtBy: 'tsc -p src/test/integration/tsconfig.json',
    }),
    staleness({
      name: 'dist/extension.js (the extension the host loads)',
      artifactMtime: distMtime,
      newestSourceMtime,
      newestSourceFile,
      builtBy: 'npm run bundle',
    }),
  ].filter((p) => p !== null);
}

/** Relative path of the file whose mtime is `target`, for a message that names names. */
async function newestFileNamed(dir, matches, target, root) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 'a source file';
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const found = await newestFileNamed(full, matches, target, root);
      if (found !== 'a source file') return found;
    } else if (matches(entry.name)) {
      const s = await stat(full);
      if (s.mtimeMs === target) return path.relative(root, full);
    }
  }
  return 'a source file';
}

/** Throw with every problem listed, or return silently. Used by .vscode-test.mjs. */
export async function assertFreshBuild(root = process.cwd()) {
  const problems = await findStaleArtifacts(root);
  if (problems.length === 0) return;
  throw new Error(
    'Integration suite refused: the build does not contain the source it would be testing.\n' +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\n\nA stale build and a current one produce identical passing output, which is the\n' +
      'failure shape this suite exists to catch. Run `npm run test:integration`, which\n' +
      'rebuilds first.',
  );
}
