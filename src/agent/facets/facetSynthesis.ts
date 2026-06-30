// ---------------------------------------------------------------------------
// Multi-facet review synthesis (scaffolding roadmap O2).
//
// A "comprehensive review" dispatches several read-only review specialists
// (architecture + security) in parallel and merges their outputs into one
// report. Synthesis is DETERMINISTIC concatenation under per-specialist
// headers — NOT an LLM merge — on purpose: an LLM synthesis pass would add a
// fresh hallucination surface (and latency) over already-grounded reviews,
// exactly the thing the verify layer exists to avoid. Each specialist's
// grounded text stands on its own, under its own heading.
// ---------------------------------------------------------------------------

export interface FacetReviewResult {
  facetId: string;
  output: string;
  success: boolean;
  /** True when the facet produced a diff (a writing facet) rather than a text review. */
  hasDiff: boolean;
}

const NO_OUTPUT = '(facet produced no output)';

/**
 * Merge the usable (successful, no-diff, non-empty) review outputs into one
 * markdown report. A single result keeps the single-review heading; multiple
 * results are concatenated under per-facet sections. Returns '' when nothing
 * usable is present.
 */
export function synthesizeFacetReviews(task: string, results: readonly FacetReviewResult[]): string {
  const usable = results.filter((r) => r.success && !r.hasDiff && r.output && r.output.trim() !== NO_OUTPUT);
  if (usable.length === 0) return '';
  if (usable.length === 1) {
    const r = usable[0];
    return `# ${r.facetId} — review\n\n_Task: ${task}_\n\n${r.output.trim()}\n`;
  }
  const sections = usable.map((r) => `## ${r.facetId}\n\n${r.output.trim()}`).join('\n\n');
  return `# Comprehensive review\n\n_Task: ${task}_\n\n${sections}\n`;
}
