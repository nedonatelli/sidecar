// The single derivation of the numbers a release claims about itself.
//
// `bump-version.sh` used to derive these inline and write them into CHANGELOG.md
// and docs/index.html. Nothing ever re-checked them, so any commit landing after
// the bump silently invalidated the claim — in 0.122.2 the recorded count was
// 8501 while the shipped build had 8502, in two files. Both the writer and the
// verifier now read from here, so they cannot disagree about how a number is
// obtained; they can only disagree about when it was taken, which is the thing
// worth detecting.

import { execSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const sh = (cmd) => execSync(cmd, { encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

/** Tests passed / test files / tests skipped, by running the suite. */
export function deriveTestStats() {
  let out = '';
  try {
    out = sh('npx vitest run 2>&1');
  } catch (err) {
    // vitest exits non-zero on failure; its summary is still on stdout and is
    // what we are reading. A genuinely broken run is caught by the caller
    // seeing zero/unparseable numbers rather than by the exit code.
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const files = /Test Files\s+(\d+) passed/.exec(out)?.[1];
  const passed = /Tests\s+(\d+) passed/.exec(out)?.[1];
  const skipped = /Tests\s+.*?(\d+) skipped/.exec(out)?.[1] ?? '0';
  if (!files || !passed) throw new Error('could not parse vitest summary — is the suite runnable?');
  return { files: Number(files), passed: Number(passed), skipped: Number(skipped) };
}

/**
 * Built-in tool count. Every built-in declares a line-leading
 * `name: '<snake_case>'`, either in a per-module array under src/agent/tools/
 * or inline in tools.ts. Test fixtures contain the same shape, so they are
 * excluded — an earlier `{ definition:` heuristic undercounted by about half.
 *
 * Counted in Node, not through the shell: this used to be `find … -exec grep`
 * and `ls skills/*.md | wc -l` via execSync, which on Windows runs under
 * cmd.exe — where `find.exe` is a string search that returned a number
 * without complaint and `ls` does not exist at all. The release check could
 * not run on the machine that cut the release.
 */
const TOOL_NAME_RE = /^[ 	]*name: ['"][a-z_]+['"]/gm;

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

export function deriveToolCount() {
  const modules = walk('src/agent/tools').filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  const count = (file) => (readFileSync(file, 'utf-8').match(TOOL_NAME_RE) ?? []).length;
  return modules.reduce((n, f) => n + count(f), 0) + count('src/agent/tools.ts');
}

/** Built-in skill count. */
export function deriveSkillCount() {
  try {
    return readdirSync('skills').filter((f) => f.endsWith('.md')).length;
  } catch {
    return 0;
  }
}

/** The version the working tree currently claims to be. */
export function packageVersion() {
  return JSON.parse(readFileSync('package.json', 'utf-8')).version;
}
