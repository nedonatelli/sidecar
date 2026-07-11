/**
 * Request-shape heuristics: whether a message should auto-enter plan mode
 * (large/multi-file/complex work) and whether it needs the full tool catalog
 * or only the read-only observation tier.
 */

import { PLAN_MODE_THRESHOLDS } from '../../../config/constants.js';

/** Returns true when the message body looks like a pre-written plan (bullets or numbered list). */
function hasPrewrittenList(text: string): boolean {
  const bulletLines = (text.match(/^[\s]*[-*•]\s+\S/gm) || []).length;
  if (bulletLines >= 2) return true;
  const numberedLines = (text.match(/^[\s]*\d+[.)]\s+\S/gm) || []).length;
  if (numberedLines >= 2) return true;
  return false;
}

/**
 * Detect if a user request should automatically trigger plan mode.
 * Large tasks benefit from planning before execution.
 */
export function shouldAutoEnablePlanMode(text: string, conversationLength: number): boolean {
  if (!text) return false;

  // Explicit request beats every heuristic below, including the
  // prewritten-list suppression: a message that literally opens with
  // "Plan:" (or asks to "plan first") is the user invoking plan mode by
  // name — dogfood found it did nothing, which reads as broken.
  if (/^\s*plan\s*[:\-–—]/i.test(text)) return true;
  if (
    /\b(plan (this|it|that) (first|out)|plan first|make a plan|plan before (you|doing|starting))\b/i.test(
      text.toLowerCase(),
    )
  )
    return true;

  // If the message already contains a list the user has done their own planning —
  // no need to enter plan mode on their behalf.
  if (hasPrewrittenList(text)) return false;

  const lower = text.toLowerCase();

  const multiFileKeywords = [
    'multiple files',
    'several files',
    'all files',
    'across',
    'refactor',
    'restructure',
    'reorganize',
    'migrate',
    'update all',
    'modify all',
    'change all',
    'replace all',
  ];
  if (multiFileKeywords.some((kw) => lower.includes(kw))) {
    return true;
  }

  const complexKeywords = [
    'architecture',
    'design',
    'overhaul',
    'complete rewrite',
    'major change',
    'breaking change',
    'large-scale',
    'comprehensive',
    'end-to-end',
  ];
  if (complexKeywords.some((kw) => lower.includes(kw))) {
    return true;
  }

  const wordCount = text.split(/\s+/).length;
  const charCount = text.length;

  if (wordCount > PLAN_MODE_THRESHOLDS.WORD_COUNT || charCount > PLAN_MODE_THRESHOLDS.CHAR_COUNT) {
    return true;
  }

  if (conversationLength > 5 && wordCount > 150 && charCount > 1000) {
    return true;
  }

  const complexityMarkers = ['how should i', 'best way to', "what' s the best", 'help me plan', 'create a plan'];
  if (complexityMarkers.some((marker) => lower.includes(marker))) {
    return true;
  }

  return false;
}

const READ_QUERY_PREFIX =
  /^(what|how|why|where|when|which|who|explain|describe|show me|tell me|find|search for|look (up|for)|list (all|the)|what (is|are|does|do|did)|how does|where (is|are))\b/i;

const ACTION_WORD =
  /\b(fix|implement|add|create|write|edit|delete|remove|refactor|change|update|run|execute|make|build|commit|push|pull|generate|convert|install|deploy|migrate|rename|move|rewrite|replace|extract|split|merge)\b/i;

/**
 * Classify whether a user message needs the full tool catalog or only
 * the read-only observation tier.
 *
 * Returns 'read' only when we're confident the user wants information
 * (explain, search, inspect) and no action words suggest otherwise.
 * Defaults to 'full' — the safe direction is over-provision, not under.
 */
export function resolveToolTier(text: string): 'read' | 'full' {
  if (!text) return 'full';
  if (text.length > 300) return 'full';
  const lower = text.toLowerCase().trim();
  if (ACTION_WORD.test(lower)) return 'full';
  if (READ_QUERY_PREFIX.test(lower)) return 'read';
  return 'full';
}
