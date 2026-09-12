/**
 * Identifier orientation: a turn-0 block that names the files mentioning the
 * issue's own identifiers -- file NAMES and match counts, no code.
 *
 * Why this and not retrieval. Over 1,100 scored gemma4:e4b task-runs, resolve
 * decomposes as localize 49% x fix-given-localized 23%; half the canary never
 * edits the gold file. The one component aimed at that stage, gated retrieval,
 * injects symbol BODIES and measured harmful: paired on task+seed, when its
 * top-k misses the gold file the model localizes 46% with retrieval off and 13%
 * with it on (19 broke, 1 fixed, p<0.001); when it hits, no gain (p=0.47). A
 * wrong body anchors the model on the wrong file. The hypothesis here is the
 * minimal opposite: names orient without anchoring, because there is no code
 * to paste and nothing to mistake for the fix.
 *
 * Deterministic and cheap -- `git grep -l` per identifier, ~100ms each -- so
 * there is no model call to go wrong and nothing to warm a cache.
 *
 * Everything here is pure; the driver runs git and passes the hits in.
 */

/** How many identifiers to search for. More is slower and noisier. */
export const MAX_IDENTIFIERS = 10;
/**
 * How many files to name. Was 12 in v1. Recomputed offline over the canary
 * (swe-runs/orient-blocks-full.json): the gold file is somewhere in the
 * identifier hits for 44/50 tasks, but a 12-file list named it for 32, a
 * 20-file list for 37, 30 for 39-40. 20 is the knee; past it the block is a
 * directory listing. The open question the v2 A/B answers is whether the
 * longer list anchors worse on the tasks where it still misses.
 */
export const MAX_FILES = 20;

const STOP = new Set([
  'self',
  'none',
  'true',
  'false',
  'import',
  'from',
  'return',
  'class',
  'def',
  'the',
  'this',
  'that',
  'with',
  'python',
  'django',
  'sympy',
  'error',
  'exception',
  'traceback',
  'file',
  'line',
  'test',
  'tests',
  'value',
  'object',
  'type',
  'name',
  'list',
  'dict',
  'str',
  'int',
  'print',
  'result',
  'expected',
  'actual',
  'output',
]);

/**
 * Pull code-shaped identifiers out of an issue. Preference order: backticked
 * spans (the reporter marked them as code), then dotted paths and CamelCase
 * and snake_case tokens. Generic words are dropped; the rest are ranked by
 * length, which is a cheap proxy for specificity.
 */
export function extractIdentifiers(problemStatement: string, max = MAX_IDENTIFIERS): string[] {
  const seen = new Map<string, number>();
  const add = (raw: string, weight: number): void => {
    const t = raw.trim().replace(/^[`'"(]+|[`'"),.:;]+$/g, '');
    if (t.length < 4 || t.length > 60) return;
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(t)) return;
    if (STOP.has(t.toLowerCase())) return;
    if (!/[A-Z_.]/.test(t) && !/\d/.test(t) && t.length < 8) return; // plain short lowercase word
    // Exception names describe the SYMPTOM, never the fix site, and they hit
    // hundreds of files (TypeError: 297 in sympy, AttributeError: 46 in
    // matplotlib). In v1 they outranked a one-file identifier that named the
    // gold file (`_facecolors2d` -> art3d.py). Dropped outright.
    if (/(Error|Exception|Warning)$/.test(t)) return;
    seen.set(t, Math.max(seen.get(t) ?? 0, weight * 100 + t.length));
  };
  for (const m of problemStatement.matchAll(/`([^`\n]{3,80})`/g)) {
    // A backticked span may be an expression; take each identifier-ish token in it.
    for (const tok of m[1].split(/[^A-Za-z0-9_.]+/)) add(tok, 3);
  }
  for (const m of problemStatement.matchAll(/\b[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+\b/g)) add(m[0], 2);
  for (const m of problemStatement.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g)) add(m[0], 2);
  for (const m of problemStatement.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g)) add(m[0], 1);
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([t]) => t);
}

export interface RankedFile {
  path: string;
  /** Which of the searched identifiers this file mentions. */
  matched: string[];
}

/**
 * Rank files by the identifiers they mention, weighted by how rare each
 * identifier is across the repository (v2). v1 counted distinct identifiers
 * equally, and a file mentioning `django.db` (848 files) and `TypeError`
 * (297) scored the same as one mentioning `_facecolors2d` (1 file). An
 * identifier that appears in three files is a lead; one that appears in
 * five hundred is a word. Weight 1/log(2 + files) per distinct identifier --
 * recomputed offline on the canary this names the gold file for 34/50 at cap
 * 12 and 37/50 at cap 20, versus 32 for the equal-weight count.
 *
 * Test files sort after source files at equal score: the fix is almost never
 * in a test. Ties beyond that break on path so the block is deterministic.
 */
export function rankFilesByHits(hits: ReadonlyMap<string, readonly string[]>, max = MAX_FILES): RankedFile[] {
  const byFile = new Map<string, Set<string>>();
  const weight = new Map<string, number>();
  for (const [ident, files] of hits) {
    weight.set(ident, 1 / Math.log(2 + files.length));
    for (const f of files) {
      const p = f.replace(/\\/g, '/');
      if (!byFile.has(p)) byFile.set(p, new Set());
      byFile.get(p)!.add(ident);
    }
  }
  const isTest = (p: string): boolean =>
    /(^|\/)tests?\//.test(p) || /(^|\/)test_[^/]*$/.test(p) || /_tests?\.py$/.test(p);
  const score = (s: Set<string>): number => [...s].reduce((acc, id) => acc + (weight.get(id) ?? 0), 0);
  return [...byFile.entries()]
    .map(([path, s]) => ({ path, matched: [...s].sort(), score: score(s) }))
    .sort(
      (a, b) => b.score - a.score || Number(isTest(a.path)) - Number(isTest(b.path)) || a.path.localeCompare(b.path),
    )
    .slice(0, max)
    .map(({ path, matched }) => ({ path, matched }));
}

/** The block the model sees. Names and which terms matched; never code. */
export function formatOrientation(identifiers: readonly string[], ranked: readonly RankedFile[]): string {
  if (identifiers.length === 0 || ranked.length === 0) return '';
  const lines = [
    `Files in this repository that mention identifiers from the issue (${identifiers.join(', ')}):`,
    ...ranked.map((r) => `- ${r.path}  (${r.matched.join(', ')})`),
    `These are leads, not answers: read the likeliest one before deciding where the change goes.`,
  ];
  return lines.join('\n');
}

/** Did the block name a file the gold patch touches? The recall analogue of goldFilesInTopK. */
export function orientationRecall(ranked: readonly RankedFile[], goldPatch: string): boolean {
  const gold = new Set((goldPatch.match(/^\+\+\+ b\/(.+)$/gm) ?? []).map((l) => l.replace(/^\+\+\+ b\//, '').trim()));
  return ranked.some((r) => gold.has(r.path));
}
