// ---------------------------------------------------------------------------
// Citation checking — pure helpers shared by the V1 unverified-claim gate
// (src/agent/completionGate.ts, runtime) and the M1 citation-resolution eval
// scorer (tests/llm-eval/agentScorers.ts, offline). No VS Code imports so both
// the extension host and the node eval harness can use it.
//
// "Even a grounded, structured review can ship fabricated citations" — this is
// the substrate for catching them: extract the file paths an answer cites, and
// let the caller resolve them (against the live workspace, or an eval fixture).
// ---------------------------------------------------------------------------

/** Cited path-like tokens: workspace-dir-rooted, or any bare file with a known
 * extension. Dotted filenames (`vitest.config.ts`) match in full — the earlier
 * pattern truncated them to their last two segments (`config.ts`), which then
 * resolved nowhere and counted as a fabrication. No globs. */
export const CITED_PATH_RE =
  /\b(?:src|tests?|lib|pkg|cmd|docs|media|scripts)\/[\w./-]+\.\w{1,5}\b|\b[\w-]+(?:[./][\w-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|json|md|toml|yaml|yml)\b/g;

/**
 * Well-known `X.js` BRAND tokens that appear in architecture prose but are
 * never file citations ("a Node.js project", "like Vue.js"). Measured live:
 * these dominated the "unresolved citation" count in longer (gate-driven)
 * reviews, penalizing exactly the arm that wrote more thorough prose. Only
 * bare tokens are filtered — `src/node.js` is still a citation.
 */
const BRAND_JS_RE =
  /^(?:node|deno|bun|vue|react|next|nuxt|angular|ember|backbone|express|three|d3|p5|chart|jquery)\.js$/i;

/** Phrases where the model admits a finding is not actually verified against the code. */
export const HEDGE_RE =
  /\b(?:I (?:cannot|can(?:'|’)t|could not|couldn(?:'|’)t) verify|without (?:reading|opening|checking)|I (?:did|have) not (?:read|open|verif|check)|implied usage|presumably|I(?:'|’)?m assuming|I assume (?:that )?|appears? to suggest)\b/i;

/** Distinct path-like tokens cited in a block of model text. */
export function extractCitedPaths(text: string): string[] {
  const raw = text.match(CITED_PATH_RE) ?? [];
  return [...new Set(raw.filter((t) => !BRAND_JS_RE.test(t)))];
}

/**
 * Candidate on-disk forms of a cited path. NodeNext source cites a `.js`
 * import specifier that resolves to a `.ts` file, so a `.js`/`.jsx`/`.mjs`/
 * `.cjs` citation should be treated as resolved when its TS sibling exists.
 */
export function pathVariants(p: string): string[] {
  const variants = [p];
  if (p.endsWith('.js')) variants.push(p.slice(0, -3) + '.ts');
  else if (p.endsWith('.jsx')) variants.push(p.slice(0, -4) + '.tsx');
  else if (p.endsWith('.mjs') || p.endsWith('.cjs')) variants.push(p.slice(0, -4) + '.ts');
  return variants;
}

/** True when the text admits an unverified claim (an inference presented as fact). */
export function hasUnverifiedHedge(text: string): boolean {
  return HEDGE_RE.test(text);
}

/**
 * Suffix-aware resolution of one cited path against a set of known
 * workspace-relative paths. Prose cites files by basename or partial path
 * ("loop.ts", "config/settings.ts") far more often than by full path;
 * exact-at-root-only matching measured 85% "unresolved" in BOTH ablation
 * arms — pure notation noise that drowned the citation gate's real signal
 * and false-accused legitimate references. A citation resolves when any
 * NodeNext variant equals a known path or is a `/`-aligned suffix of one;
 * a true fabrication matches nothing and still fails.
 */
export function resolvesAmong(cited: string, knownPaths: readonly string[]): boolean {
  return pathVariants(cited).some((v) => knownPaths.some((k) => k === v || k.endsWith('/' + v)));
}

/** Graded citation metrics for one block of model text (scaffolding M1/M2). */
export interface CitationMetrics {
  /** Distinct path-like citations found in the text. */
  citedPaths: number;
  /** Citations that resolve to no known path — the fabrication count. */
  unresolvedCitations: number;
  /**
   * unresolvedCitations / citedPaths (0 when nothing is cited). The fair
   * cross-arm comparator: a raw count penalizes thoroughness — a longer
   * review cites more paths, so its count rises even when its fabrication
   * QUALITY is identical (measured: gate-on 14.4 paths vs 10.0, same rate).
   */
  unresolvedCitationRate: number;
}

/**
 * Compute the graded citation metrics against a known path set. This is the
 * instrument the ablation harness compares as means across arms — binary
 * pass/fail provably cannot see a reduction (perfection-or-fail fails both
 * arms), and the count alone confuses verbosity with fabrication.
 */
export function citationMetricsForText(text: string, knownPaths: readonly string[]): CitationMetrics {
  const cited = extractCitedPaths(text);
  const unresolved = cited.filter((c) => !resolvesAmong(c, knownPaths)).length;
  return {
    citedPaths: cited.length,
    unresolvedCitations: unresolved,
    unresolvedCitationRate: cited.length > 0 ? unresolved / cited.length : 0,
  };
}
