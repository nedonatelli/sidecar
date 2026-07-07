// ---------------------------------------------------------------------------
// Lightweight file retrieval for the SWE-bench driver — orientation.
//
// The driver drops the agent into a freshly-cloned repo with no index, so a
// small local model burns its whole iteration budget just trying to FIND the
// file to edit (and usually never does). Production SideCar solves this with its
// retrieval pipeline (embedding + symbol index); that machinery is bound to the
// VS Code workspace and impractical to stand up per task. This is a self-
// contained keyword retriever that mirrors what retrieval does functionally —
// surface the handful of files most relevant to the issue — so the agent starts
// oriented. It is a documented proxy for production retrieval, not a reimpl.
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'that',
  'this',
  'with',
  'not',
  'are',
  'was',
  'when',
  'should',
  'would',
  'could',
  'have',
  'has',
  'does',
  'doing',
  'from',
  'into',
  'they',
  'them',
  'then',
  'than',
  'will',
  'your',
  'you',
  'but',
  'all',
  'any',
  'can',
  'get',
  'got',
  'its',
  'it',
  'is',
  'be',
  'to',
  'of',
  'in',
  'on',
  'a',
  'an',
  'if',
  'or',
  'as',
  'at',
  'by',
  'we',
  'do',
  'so',
  'no',
  'eg',
  'ie',
  'example',
  'work',
  'correctly',
  'helpful',
  'things',
  'given',
  'trying',
  'raised',
  'require',
  'use',
  'using',
  'used',
  'add',
  'fix',
]);

/**
 * Pull salient query terms from an issue: identifier-like tokens (camelCase /
 * snake_case / CapWords), backticked/quoted spans, and content words. Lowercased
 * + deduped. CapWords and code identifiers are the high-signal ones (class /
 * function / symbol names that tend to appear in the file that needs editing).
 */
export function extractTerms(problemStatement: string): string[] {
  const terms = new Set<string>();
  // Backticked or quoted spans first (often the exact symbol/API).
  for (const m of problemStatement.matchAll(/[`'"]([A-Za-z_][\w.]*)[`'"]/g)) {
    terms.add(m[1].toLowerCase());
  }
  for (const raw of problemStatement.split(/[^A-Za-z0-9_]+/)) {
    if (!raw) continue;
    const lower = raw.toLowerCase();
    const isIdentifier = /[A-Z]/.test(raw.slice(1)) || raw.includes('_'); // camelCase / snake_case / CapWords
    if (isIdentifier && raw.length > 2) {
      terms.add(lower);
    } else if (raw.length > 3 && !STOPWORDS.has(lower)) {
      terms.add(lower);
    }
  }
  return [...terms];
}

export interface RepoFile {
  /** Repo-relative path. */
  path: string;
  content: string;
}

export interface ScoredFile {
  path: string;
  score: number;
}

/**
 * Score every file against the issue terms and return the top `k` with score>0.
 * Path matches weigh heavily (a term in the filename is a strong signal); content
 * matches accumulate by frequency. Test files are down-weighted — the fix almost
 * always lives in source, and the gold tests are injected separately anyway.
 */
export function selectRelevantFiles(files: RepoFile[], problemStatement: string, k: number): ScoredFile[] {
  const terms = extractTerms(problemStatement);
  if (terms.length === 0) return [];
  const scored: ScoredFile[] = [];
  for (const f of files) {
    const pathLower = f.path.toLowerCase();
    const contentLower = f.content.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (pathLower.includes(t)) score += 12;
      // Count content occurrences, capped so one term can't dominate.
      let idx = contentLower.indexOf(t);
      let hits = 0;
      while (idx !== -1 && hits < 20) {
        hits++;
        idx = contentLower.indexOf(t, idx + t.length);
      }
      score += hits;
    }
    const isTest = /(^|\/)(tests?|testing)\//.test(pathLower) || /(^|\/)test_|_test\.py$|conftest\.py$/.test(pathLower);
    if (isTest) score *= 0.25;
    if (score > 0) scored.push({ path: f.path, score });
  }
  scored.sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  return scored.slice(0, k);
}
