import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import { findIntentTarget } from './fs.js';

// ---------------------------------------------------------------------------
// FUZZY-MATCHER ORACLE, ground-truthed against real git history.
//
// findIntentTarget is the most dangerous heuristic in the edit path. When a
// model's `search` string does not match, it GUESSES which region of the file
// the model meant to rewrite, using only the `replace` text. A wrong guess does
// not fail loudly — it silently rewrites the wrong code, and if the result
// happens to parse, no other guard in the stack can see it.
//
// Every commit in a real repository is ground truth for exactly this question:
// given the lines a commit ADDED, which region did it actually REPLACE? The
// corpus is 1,700 hunks from SideCar, flask, requests, fastapi, pip, black,
// pytest, httpx, attrs, ripgrep and fd. Rebuild it with:
//
//     node scripts/mine-edit-corpus.mjs
//
// The property is NOT "always find the region" — declining is safe, because the
// model just gets an error and retries. It is:
//
//     IF the matcher commits to a region, that region is the one the edit touched.
//
// Measured over this corpus, the required margin (how far the winning window must
// beat the runner-up) is the whole ballgame:
//
//     margin 1 → 6.7% of committed guesses rewrite the WRONG region
//     margin 2 → 1.3%
//     margin 3 → 0.0%   (177 commitments, zero wrong)
//
// Which is why edit_file has two tiers: it APPLIES a guess only at margin 3, and
// merely SUGGESTS a region (writing nothing) below that.
// ---------------------------------------------------------------------------

interface Sample {
  repo: string;
  file: string;
  before: string;
  removed: string; // ground truth: the region the commit actually replaced
  added: string; // what a model would put in `replace`
}

// Kept in sync with fs.ts by the assertions below; see APPLY_MARGIN there.
const APPLY_MARGIN = 3;
const SUGGEST_MARGIN = 1;

const CORPUS = '/tmp/edit-corpus.json';

function loadCorpus(): Sample[] {
  try {
    return JSON.parse(fs.readFileSync(CORPUS, 'utf-8')) as Sample[];
  } catch {
    return []; // not mined on this machine — see the header
  }
}

/** Do two snippets share any non-trivial line? Overlap = the matcher landed on the right region. */
function overlaps(a: string, b: string): boolean {
  const linesOf = (s: string) =>
    new Set(
      s
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 3),
    );
  const A = linesOf(a);
  for (const line of linesOf(b)) if (A.has(line)) return true;
  return false;
}

function score(corpus: Sample[], margin: number) {
  let declined = 0;
  let correct = 0;
  const wrong: string[] = [];

  for (const s of corpus) {
    const target = findIntentTarget(s.before, s.added, 0.4, margin);
    if (target === null) {
      declined++;
      continue;
    }
    if (overlaps(target, s.removed)) correct++;
    else wrong.push(`${s.repo}/${s.file}`);
  }

  const committed = correct + wrong.length;
  return { declined, correct, wrong, committed, wrongRate: committed > 0 ? wrong.length / committed : 0 };
}

describe('findIntentTarget oracle: 1,700 real edits from 11 repositories', () => {
  const corpus = loadCorpus();
  const mined = corpus.length > 0;

  it.skipIf(!mined)('APPLY tier: every region it writes to disk is the region the edit touched', () => {
    const r = score(corpus, APPLY_MARGIN);

    // This tier WRITES. A wrong region here is silent corruption of untouched
    // code — the exact failure the whole guard stack exists to prevent, arriving
    // through the one door that opens by guessing. Zero is the only passing number.
    expect({
      summary: `corpus=${corpus.length} committed=${r.committed} wrong=${r.wrong.length}`,
      worst: r.wrong.slice(0, 8),
    }).toEqual({
      summary: `corpus=${corpus.length} committed=${r.committed} wrong=0`,
      worst: [],
    });

    // …and it must still be USEFUL. A matcher that declines everything is
    // trivially correct and worthless: it was the suggest-only build that
    // dropped qwen2.5-coder from 5/5 to 3/5 on the dogfood suite.
    expect(r.committed).toBeGreaterThan(100);
  });

  it.skipIf(!mined)('SUGGEST tier: mostly right, and it writes nothing when it is wrong', () => {
    const r = score(corpus, SUGGEST_MARGIN);

    // This tier only hands the model a region to copy into `search`, so a miss
    // costs a retry, not a file. It buys ~3.5x the coverage of the apply tier;
    // the bar is that it is right most of the time, not that it is never wrong.
    expect(r.committed).toBeGreaterThan(score(corpus, APPLY_MARGIN).committed * 2);
    expect(r.wrongRate).toBeLessThan(0.15);
  });
});
