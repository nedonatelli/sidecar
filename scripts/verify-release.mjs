#!/usr/bin/env node
// Release-time check that the numbers a release claims about itself are still true.
//
// `bump-version.sh` writes test/tool/skill counts into CHANGELOG.md and
// docs/index.html at the moment it runs. Nothing re-checked them, so every
// commit landing afterwards silently invalidated the claim. In 0.122.2 the
// recorded count was 8501 while the shipped build had 8502 — in two files — and
// the fix that changed it had no changelog entry at all, which meant the release
// notes described a build that behaves differently from the one shipped.
//
// Deliberately NOT a CI gate. Test count changes on nearly every commit, so
// gating per-commit would fire constantly and be tuned out — the same reasoning
// that made a scaffold MINOR bump not invalidate an eval baseline (#11). This
// runs once, at release.
//
//   node scripts/verify-release.mjs [--skip-tests]

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { deriveTestStats, deriveToolCount, deriveSkillCount, packageVersion } from './lib/releaseStats.mjs';

const SKIP_TESTS = process.argv.includes('--skip-tests');
const problems = [];
const warnings = [];

const version = packageVersion();
const changelog = readFileSync('CHANGELOG.md', 'utf-8');
const landing = readFileSync('docs/index.html', 'utf-8');

// --- the version must have a section at all -------------------------------
const sectionRe = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\] - (\\d{4}-\\d{2}-\\d{2})$`, 'm');
const section = sectionRe.exec(changelog);
if (!section) {
  console.error(`FAIL: CHANGELOG.md has no "## [${version}] - YYYY-MM-DD" section.`);
  process.exit(1);
}

// --- the date must be today, but only for a release not yet cut ------------
// An already-tagged version's date is history, not drift. Checking it against
// today would fail on every repo state after the release, which is how a
// verifier gets ignored.
const alreadyTagged = (() => {
  try {
    execSync(`git rev-parse -q --verify refs/tags/v${version}`, { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();
const today = new Date().toISOString().slice(0, 10);
if (!alreadyTagged && section[1] !== today) {
  problems.push(`release date is ${section[1]}, today is ${today} — the bump ran on a different day than the release`);
}

// --- the stats must match a freshly-derived reality ------------------------
const body = changelog.slice(section.index, changelog.indexOf('\n## [', section.index + 1));
const claimedTests = /-\s*(\d+) total tests \((\d+) test files\)/.exec(body);
const claimedTools = /-\s*(\d+) built-in tools, (\d+) skills/.exec(body);

const tools = deriveToolCount();
const skills = deriveSkillCount();
if (!claimedTools) {
  problems.push('CHANGELOG Stats block has no "N built-in tools, N skills" line');
} else {
  if (Number(claimedTools[1]) !== tools) problems.push(`tools: CHANGELOG says ${claimedTools[1]}, actual ${tools}`);
  if (Number(claimedTools[2]) !== skills) problems.push(`skills: CHANGELOG says ${claimedTools[2]}, actual ${skills}`);
}

if (SKIP_TESTS) {
  warnings.push('--skip-tests: test counts were NOT verified');
} else if (!claimedTests) {
  problems.push('CHANGELOG Stats block has no "N total tests (N test files)" line');
} else {
  const t = deriveTestStats();
  if (Number(claimedTests[1]) !== t.passed)
    problems.push(`tests: CHANGELOG says ${claimedTests[1]}, actual ${t.passed}`);
  if (Number(claimedTests[2]) !== t.files)
    problems.push(`test files: CHANGELOG says ${claimedTests[2]}, actual ${t.files}`);

  // The landing page carried the same stale number in 0.122.2, so check it too.
  const onLanding = /<span class="stat-num">(\d{4,})<\/span>\s*<span class="stat-label">tests passing<\/span>/.exec(
    landing,
  );
  if (!onLanding) problems.push('docs/index.html has no "tests passing" stat to check');
  else if (Number(onLanding[1]) !== t.passed) {
    problems.push(`tests: docs/index.html says ${onLanding[1]}, actual ${t.passed}`);
  }
}

// --- source landing after the bump, with no changelog entry ---------------
// A heuristic, and a warning rather than a failure: not every source commit
// warrants an entry. But this is the check that would have caught the omission
// that actually mattered in 0.122.2.
//
// It is inert when the version bump was committed together with source changes
// rather than on its own — as happened in 0.122.2 itself, where the bump and the
// indexing fix landed as one commit. Say so rather than reporting nothing:
// a check that cannot run looks exactly like a check that found nothing.
try {
  const bump = execSync(`git log -1 --format=%H -S'"version": "${version}"' -- package.json`, {
    encoding: 'utf-8',
  }).trim();
  const head = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  if (!bump) {
    warnings.push(`no commit introduces version ${version} in package.json — post-bump source check did not run`);
  } else if (bump === head) {
    warnings.push(
      'the version bump is the HEAD commit — post-bump source check has nothing to compare and did not run',
    );
  } else {
    const since = execSync(`git log ${bump}..HEAD --name-only --format=%H`, { encoding: 'utf-8' });
    const touchedSrc = since.split('\n').filter((l) => l.startsWith('src/'));
    const touchedChangelog = since.includes('CHANGELOG.md');
    if (touchedSrc.length > 0 && !touchedChangelog) {
      warnings.push(
        `${new Set(touchedSrc).size} source file(s) changed after the version bump with no CHANGELOG edit:\n` +
          [...new Set(touchedSrc)]
            .slice(0, 8)
            .map((f) => `      ${f}`)
            .join('\n'),
      );
    }
  }
} catch {
  warnings.push('could not determine the bump commit — skipped the post-bump source check');
}

// --- report ----------------------------------------------------------------
for (const w of warnings) console.warn(`WARN: ${w}`);
if (problems.length > 0) {
  console.error(`\nFAIL: release ${version} claims ${problems.length} thing(s) that are no longer true:`);
  for (const p of problems) console.error(`  - ${p}`);
  console.error('\nRe-run `npm run bump` for this version, or correct the numbers by hand.');
  process.exit(1);
}
console.log(`✓ release ${version} — changelog date, tool/skill counts${SKIP_TESTS ? '' : ', test counts'} all match.`);
