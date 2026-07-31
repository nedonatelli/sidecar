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
import { readFileSync } from 'fs';

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
 */
export function deriveToolCount() {
  const pattern = '^[[:space:]]*name: [\'\\"][a-z_]+[\'\\"]';
  const inModules = sh(
    `find src/agent/tools -name '*.ts' ! -name '*.test.ts' -exec grep -hoE "${pattern}" {} + | wc -l`,
  ).trim();
  const inline = sh(`grep -hoE "${pattern}" src/agent/tools.ts | wc -l`).trim();
  return Number(inModules) + Number(inline);
}

/** Built-in skill count. */
export function deriveSkillCount() {
  return sh('ls skills/*.md 2>/dev/null | wc -l').trim() ? Number(sh('ls skills/*.md | wc -l').trim()) : 0;
}

/** The version the working tree currently claims to be. */
export function packageVersion() {
  return JSON.parse(readFileSync('package.json', 'utf-8')).version;
}
