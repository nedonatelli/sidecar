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

/** Cited path-like tokens: workspace-dir-rooted, or any bare file with a known extension. No globs. */
export const CITED_PATH_RE =
  /\b(?:src|tests?|lib|pkg|cmd|docs|media|scripts)\/[\w./-]+\.\w{1,5}\b|\b[\w-]+(?:\/[\w-]+)*\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|json|md|toml|yaml|yml)\b/g;

/** Phrases where the model admits a finding is not actually verified against the code. */
export const HEDGE_RE =
  /\b(?:I (?:cannot|can(?:'|’)t|could not|couldn(?:'|’)t) verify|without (?:reading|opening|checking)|I (?:did|have) not (?:read|open|verif|check)|implied usage|presumably|I(?:'|’)?m assuming|I assume (?:that )?|appears? to suggest)\b/i;

/** Distinct path-like tokens cited in a block of model text. */
export function extractCitedPaths(text: string): string[] {
  return [...new Set(text.match(CITED_PATH_RE) ?? [])];
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
