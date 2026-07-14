#!/usr/bin/env node
// Mine ground truth for the findIntentTarget oracle from real git history.
//
// findIntentTarget guesses which region of a file a model MEANT to rewrite when
// its `search` string does not match. A wrong guess silently rewrites untouched
// code, so the guess needs ground truth — and every commit in every repository
// is exactly that: given the lines a commit ADDED, which region did it REPLACE?
//
// Emits /tmp/edit-corpus.json: [{ repo, file, before, removed, added }]
// `before` is the file as it stood at the parent commit; `removed` is the region
// the commit actually replaced (the answer); `added` is what a model would put
// in `replace`.
//
// The output is ~56 MB, so it is NOT committed — findIntentTarget.oracle.test.ts
// skips cleanly when it is absent. Run this to reproduce the measurement:
//
//     node scripts/mine-edit-corpus.mjs
//     npx vitest run src/agent/tools/findIntentTarget.oracle.test.ts

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const CACHE = '/tmp/edit-corpus-repos';
const OUT = '/tmp/edit-corpus.json';
const PER_REPO = 160; // hunks; 11 repos → ~1,700 samples
const COMMITS = 400;

// Deliberately mixed: Python, TypeScript and Rust, libraries and applications,
// so the matcher is not tuned to one language's line shapes.
const REPOS = [
  ['sidecar', process.cwd()],
  ['flask', 'https://github.com/pallets/flask'],
  ['requests', 'https://github.com/psf/requests'],
  ['fastapi', 'https://github.com/fastapi/fastapi'],
  ['pip', 'https://github.com/pypa/pip'],
  ['black', 'https://github.com/psf/black'],
  ['pytest', 'https://github.com/pytest-dev/pytest'],
  ['httpx', 'https://github.com/encode/httpx'],
  ['attrs', 'https://github.com/python-attrs/attrs'],
  ['ripgrep', 'https://github.com/BurntSushi/ripgrep'],
  ['fd', 'https://github.com/sharkdp/fd'],
];

const CODE = /\.(py|ts|js|rs|go|java|rb)$/;

const git = (dir, args) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf-8', maxBuffer: 512 * 1024 * 1024 });

function ensure(name, src) {
  if (!src.startsWith('http')) return src;
  const dir = path.join(CACHE, name);
  if (fs.existsSync(dir)) return dir;
  fs.mkdirSync(CACHE, { recursive: true });
  console.error(`cloning ${name}…`);
  execFileSync('git', ['clone', '--quiet', '--filter=blob:none', src, dir], { stdio: 'inherit' });
  return dir;
}

/** Pull replaced-region hunks out of a unified diff: a hunk with BOTH removed and added lines. */
function hunksOf(diff) {
  const out = [];
  let file = null;
  let removed = [];
  let added = [];
  const flush = () => {
    if (file && removed.length && added.length)
      out.push({ file, removed: removed.join('\n'), added: added.join('\n') });
    removed = [];
    added = [];
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      flush();
      file = line.slice(6);
    } else if (line.startsWith('@@')) {
      flush();
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removed.push(line.slice(1));
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      added.push(line.slice(1));
    } else if (removed.length && added.length) {
      flush(); // context line ends the replaced region
    } else {
      removed = [];
      added = [];
    }
  }
  flush();
  return out;
}

const samples = [];

for (const [name, src] of REPOS) {
  const dir = ensure(name, src);
  let taken = 0;
  const shas = git(dir, ['log', '--no-merges', '-n', String(COMMITS), '--format=%H'])
    .trim()
    .split('\n');

  for (const sha of shas) {
    if (taken >= PER_REPO) break;
    let diff;
    try {
      diff = git(dir, ['show', sha, '--unified=0', '--no-color', '--format=']);
    } catch {
      continue;
    }

    for (const h of hunksOf(diff)) {
      if (taken >= PER_REPO) break;
      if (!CODE.test(h.file)) continue;
      // A one-line change is not a region; a giant one is a rewrite, not an edit.
      const n = h.added.split('\n').length;
      if (n < 2 || n > 25) continue;

      let before;
      try {
        before = git(dir, ['show', `${sha}~1:${h.file}`]);
      } catch {
        continue; // new file — nothing was replaced
      }
      if (!before.includes(h.removed)) continue; // ground truth must be verbatim present
      if (before.length > 200_000) continue;

      samples.push({ repo: name, file: h.file, before, removed: h.removed, added: h.added });
      taken++;
    }
  }
  console.error(`${name}: ${taken}`);
}

fs.writeFileSync(OUT, JSON.stringify(samples));
console.error(`\n${samples.length} samples → ${OUT}`);
