#!/usr/bin/env node
// bump-version.mjs — bump the SideCar version and every stat the release claims.
//
//   node scripts/bump-version.mjs <version> ["summary"] [--dry-run] [--skip-tests]
//   npm run bump -- 0.125.0 "what changed"
//
// One implementation for every platform. The previous bump-version.sh used
// `sed -i ''` (the macOS form) on every line and two inline python3 programs;
// it could not run under GNU sed or without python3, so v0.124.0 was bumped by
// hand. The counts come from scripts/lib/releaseStats.mjs — the same derivation
// `verify:release` re-checks — and the text edits from scripts/lib/bumpEdits.mjs,
// which is unit-tested.
//
// What it does:
//   1. Validates <version> is a legal next step from the latest vX.Y.Z tag.
//   2. Runs the suite (unless --skip-tests) and counts tools and skills.
//   3. Updates package.json + package-lock.json (`npm version`), CHANGELOG.md,
//      README.md, SECURITY.md, docs/index.html, docs/agent-mode.md,
//      docs/troubleshooting.md.
//   4. Prints the changed files for review. Commits nothing.
//
// --dry-run prints every change it would make and writes nothing.

import { readFileSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { deriveTestStats, deriveToolCount, deriveSkillCount, packageVersion } from './lib/releaseStats.mjs';
import {
  validNextVersions,
  latestReleaseTag,
  bumpLandingPage,
  bumpAgentModeDoc,
  bumpTroubleshootingDoc,
  bumpReadme,
  bumpSecurityTable,
  bumpChangelog,
} from './lib/bumpEdits.mjs';

process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), '..'));

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const newVersion = positional[0];
const summary = positional[1] ?? '';
const dryRun = flags.has('--dry-run');
const skipTests = flags.has('--skip-tests');

if (!newVersion || !/^\d+\.\d+\.\d+$/.test(newVersion)) {
  console.error('Usage: node scripts/bump-version.mjs <version> ["summary"] [--dry-run] [--skip-tests]');
  console.error('Example: node scripts/bump-version.mjs 0.125.0 "stale-edit recovery, catalog gate"');
  process.exit(1);
}

const oldVersion = packageVersion();
const today = new Date().toISOString().slice(0, 10);
if (newVersion === oldVersion) {
  console.error(
    `ERROR: package.json is already at ${oldVersion}; a bump to the same version would add a duplicate CHANGELOG section.`,
  );
  process.exit(1);
}

// --- 0. Version must be a legal next step from the latest tag ---------------
const latestTag = latestReleaseTag(execFileSync('git', ['tag'], { encoding: 'utf-8' }));
const valid = validNextVersions(latestTag);
if (valid && !valid.includes(newVersion)) {
  console.error('ERROR: version skip detected.');
  console.error(`  Latest tag : ${latestTag}`);
  console.error(`  Requested  : v${newVersion}`);
  console.error(`  Valid next : ${valid.join(' ')}`);
  console.error('Fix the version or delete stale tags before proceeding.');
  process.exit(1);
}

console.log(`=== SideCar Version Bump: ${oldVersion} → ${newVersion}${dryRun ? ' (dry run)' : ''} ===\n`);

// --- 1. Stats ----------------------------------------------------------------
console.log('Collecting stats...');
let tests;
if (skipTests) {
  console.log(
    '  Tests:  skipped (--skip-tests) — test counts are left as they are; verify:release will re-derive them',
  );
} else {
  tests = deriveTestStats();
  console.log(`  Tests:  ${tests.passed} passed (${tests.files} files, ${tests.skipped} skipped)`);
}
const tools = deriveToolCount();
const skills = deriveSkillCount();
console.log(`  Tools:  ${tools} built-in`);
console.log(`  Skills: ${skills} built-in\n`);

// --- 2. Edits ------------------------------------------------------------------
const changed = [];
const edit = (file, fn) => {
  const before = readFileSync(file, 'utf-8');
  const after = fn(before);
  if (after === before) {
    console.log(`  ${file}: no change`);
    return;
  }
  changed.push(file);
  if (dryRun) {
    const delta = after.split('\n').length - before.split('\n').length;
    console.log(`  ${file}: would change (${delta >= 0 ? '+' : ''}${delta} line(s))`);
    return;
  }
  writeFileSync(file, after);
  console.log(`  ${file}: updated`);
};
const ctx = {
  oldVersion,
  newVersion,
  today,
  summary,
  tests: tests?.passed,
  testFiles: tests?.files,
  tools,
  skills,
};

console.log('Updating files...');
if (dryRun) {
  console.log(`  package.json + package-lock.json: would set version ${newVersion}`);
} else {
  execFileSync('npm', ['version', newVersion, '--no-git-tag-version'], { stdio: 'ignore', shell: true });
  changed.push('package.json', 'package-lock.json');
  console.log(`  package.json + package-lock.json: version ${newVersion}`);
}
edit('docs/index.html', (s) => bumpLandingPage(s, ctx));
edit('docs/agent-mode.md', (s) => bumpAgentModeDoc(s, ctx));
edit('docs/troubleshooting.md', (s) => bumpTroubleshootingDoc(s, ctx));
edit('README.md', (s) => bumpReadme(s, ctx));
edit('SECURITY.md', (s) => bumpSecurityTable(s, ctx));
edit('CHANGELOG.md', (s) => bumpChangelog(s, { ...ctx, tests: ctx.tests ?? '?', testFiles: ctx.testFiles ?? '?' }));

// --- 3. Summary ----------------------------------------------------------------
console.log(`\n=== ${dryRun ? 'Dry run complete' : 'Done'} ===\n`);
if (!dryRun) {
  console.log('Updated files:');
  for (const f of changed) console.log(`  ${f}`);
  console.log('\nReview the CHANGELOG entry and expand it (Added / Changed / Fixed) before committing.');
  console.log('Then: git diff  →  git add -A && git commit  →  npm run verify:release immediately before tagging.');
}
