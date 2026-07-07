/**
 * Whole-repo review detection → read-only review-specialist routing.
 *
 * A facet dispatch is heavyweight (own shadow workspace, read-only loop), so
 * we only offer it for prompts that clearly target the WHOLE codebase, not a
 * single file or symbol. Single-file review ("review src/foo.ts", "review this
 * function") falls through to the normal loop, backstopped by the no-grounding
 * completion gate. The labels below are the offer buttons; clicking one sends
 * its text back as a userMessage, which the dispatcher routes server-side.
 */

/** Offer-button label that launches the architecture-reviewer facet. */
export const RUN_ARCH_REVIEW_LABEL = '▶ Run Architecture Reviewer (grounded, cited)';
/** Offer-button label that declines the facet and answers in the normal loop. */
export const ANSWER_INLINE_LABEL = 'Answer inline instead';

const REPO_REVIEW_VERB_RE =
  /\b(review|audit|assess|evaluat(?:e|ing)|critiqu(?:e|ing)|analy[sz]e|appraise|inspect|go over|look over)\b/i;
const REPO_SCOPE_RE =
  /\b(this (?:repo|repository|project|codebase|code\s?base|extension)|the (?:repo|repository|project|codebase|code\s?base|whole codebase|entire codebase)|(?:overall|whole|entire|high[-\s]?level)\s+(?:architecture|design|structure)|(?:architecture|design|structure) of (?:this|the)\s+(?:repo|repository|project|codebase|code\s?base|system|application|app|extension))\b/i;
/** A specific file path or singular code target — disqualifies a whole-repo offer. */
const SPECIFIC_TARGET_RE =
  /\b[\w./-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|json|md|toml|yaml|yml|sh|java|cpp|c|h)\b|\b(?:this|the)\s+(?:file|function|method|class)\b/i;

/**
 * Returns true when the message asks for a review/evaluation of the WHOLE
 * codebase or its architecture — and does NOT name a specific file or symbol.
 */
export function isRepoReviewRequest(text: string): boolean {
  if (!text) return false;
  if (text.trim().startsWith('/')) return false;
  if (SPECIFIC_TARGET_RE.test(text)) return false;
  return REPO_REVIEW_VERB_RE.test(text) && REPO_SCOPE_RE.test(text);
}

const ARCH_REVIEW_ACCEPT_RE =
  /\b(run|launch|dispatch|use|yes|yeah|yep|sure|ok|okay|go ahead|go for it|do it|please do|sounds good|the specialist|reviewer)\b/i;
const ARCH_REVIEW_DECLINE_RE =
  /\b(no|nope|nah|inline|just (?:answer|tell|summar|do)|don'?t|skip|yourself|never\s?mind|forget it)\b/i;

/** While an architecture-review offer is pending, does the reply accept it? */
export function isArchReviewAccept(text: string): boolean {
  if (!text) return false;
  return ARCH_REVIEW_ACCEPT_RE.test(text) && !ARCH_REVIEW_DECLINE_RE.test(text);
}

/** While an architecture-review offer is pending, does the reply decline it? */
export function isArchReviewDecline(text: string): boolean {
  if (!text) return false;
  return ARCH_REVIEW_DECLINE_RE.test(text);
}

// ---------------------------------------------------------------------------
// Generalized intent → specialist routing (scaffolding roadmap O1).
//
// Extends the architecture-reviewer auto-offer to all read-only review
// specialists: a security audit routes to security-reviewer, a whole-repo
// architecture/design review to architecture-reviewer. Writing facets are NOT
// offered here — they produce diffs that need the review panel, a heavier flow.
// ---------------------------------------------------------------------------

/** A read-only review specialist the router can offer. */
export interface ReviewFacetMatch {
  facetId: string;
  displayName: string;
}

const SECURITY_REVIEW_RE =
  /\b(security|vulnerab\w*|exploit\w*|injection|xss|csrf|ssrf|auth(?:entication|orization)?|secret|credential|sanitiz\w*|owasp|cve|attack surface|threat\s?model)\b/i;

/**
 * Route a chat message to a read-only review specialist, or null. Security
 * audits of the codebase → security-reviewer; whole-repo architecture/design
 * reviews → architecture-reviewer. Single-file/symbol requests don't match
 * (they fall through to the normal loop). Security is checked first so a
 * "review this codebase for security holes" prompt picks the right specialist.
 */
export function classifyReviewFacet(text: string): ReviewFacetMatch | null {
  if (!text) return null;
  if (text.trim().startsWith('/')) return null;
  if (SPECIFIC_TARGET_RE.test(text)) return null;
  const codebaseTarget = REPO_SCOPE_RE.test(text) || /\b(codebase|code\s?base|repo|repository|project)\b/i.test(text);
  if (REPO_REVIEW_VERB_RE.test(text) && SECURITY_REVIEW_RE.test(text) && codebaseTarget) {
    return { facetId: 'security-reviewer', displayName: 'Security Reviewer' };
  }
  if (isRepoReviewRequest(text)) {
    return { facetId: 'architecture-reviewer', displayName: 'Architecture Reviewer' };
  }
  return null;
}

/** Offer-button label for a given specialist (clicking it accepts via isArchReviewAccept). */
export function runReviewLabel(displayName: string): string {
  return `▶ Run ${displayName} (grounded, cited)`;
}

const COMPREHENSIVE_RE = /\b(comprehensive|thorough|full|complete|in[-\s]?depth|end[-\s]?to[-\s]?end|overall)\b/i;

/** One or more review specialists to dispatch for a request (O2 multi-facet). */
export interface ReviewFacetSelection {
  facetIds: string[];
  displayName: string;
}

/**
 * Route a review request to one OR MORE specialists (O2). A "comprehensive /
 * thorough / full" review, or one that explicitly asks for both architecture
 * and security, dispatches the architecture + security reviewers together
 * (synthesized into one report). Otherwise it falls back to the single
 * specialist classifyReviewFacet picks. Returns null for non-review requests.
 */
export function classifyReviewFacets(text: string): ReviewFacetSelection | null {
  const single = classifyReviewFacet(text);
  if (!single) return null;
  const bothNamed = /\barchitecture\b/i.test(text) && /\bsecurity\b/i.test(text);
  if (COMPREHENSIVE_RE.test(text) || bothNamed) {
    return { facetIds: ['architecture-reviewer', 'security-reviewer'], displayName: 'Architecture + Security review' };
  }
  return { facetIds: [single.facetId], displayName: single.displayName };
}
