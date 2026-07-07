/**
 * Message classification and workspace-relevance utilities. Extracted from
 * chatHandlers.ts, then split into focused modules under `messageUtils/`; this
 * barrel preserves the original import surface so callers keep importing from
 * `./messageUtils.js`.
 *
 * - intentClassifiers — terse-reply predicates (commit / approve / undo / …)
 * - reviewRouting      — whole-repo review detection → review-specialist offers
 * - planMode           — auto-plan-mode + read/full tool-tier heuristics
 * - errorTaxonomy      — backend error → typed class + recovery action
 * - workspaceRelevance — keyword overlap + index relevance decay/reset
 * - messagePrep        — numbered-list refs, continuation framing, lang→ext
 */

export * from './messageUtils/intentClassifiers.js';
export * from './messageUtils/reviewRouting.js';
export * from './messageUtils/planMode.js';
export * from './messageUtils/errorTaxonomy.js';
export * from './messageUtils/workspaceRelevance.js';
export * from './messageUtils/messagePrep.js';
