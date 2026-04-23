/**
 * Utility functions for message classification and workspace relevance.
 * Extracted from chatHandlers.ts to reduce its size.
 */

import type { ChatState } from '../chatState.js';
import { PLAN_MODE_THRESHOLDS } from '../../config/constants.js';
import { getContentText } from '../../ollama/types.js';

/**
 * Detect terse user messages like "continue", "go on", "keep going" that mean
 * "resume what you were just doing" rather than "answer this literal word".
 * Caller should also check that there's a prior assistant message — otherwise
 * there's nothing to continue.
 */
const CONTINUATION_PATTERNS: RegExp[] = [
  /^continue\.?$/i,
  /^continue please\.?$/i,
  /^please continue\.?$/i,
  /^continue working\.?$/i,
  /^keep (going|working)\.?$/i,
  /^go on\.?$/i,
  /^go ahead\.?$/i,
  /^carry on\.?$/i,
  /^proceed\.?$/i,
  /^resume\.?$/i,
  /^next\.?$/i,
  /^and\??$/i,
  /^more\.?$/i,
  /^finish (it|this|up)\.?$/i,
  /^keep at it\.?$/i,
];

const COMMIT_REQUEST_PATTERNS: RegExp[] = [
  /^commit\.?$/i,
  /^commit (it|this|that|the changes?|them)\.?$/i,
  /^commit (and push|it now)\.?$/i,
  /^make (a )?commit\.?$/i,
  /^create (a )?commit\.?$/i,
  /^save (the )?changes?\.?$/i,
  /^lgtm\.?$/i,
];

/** Returns true when the user wants to commit the current changes. */
export function isCommitRequest(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 50) return false;
  if (trimmed.startsWith('/')) return false;
  return COMMIT_REQUEST_PATTERNS.some((re) => re.test(trimmed));
}

const SHOW_DIFF_PATTERNS: RegExp[] = [
  /^(show|what|see) (me )?(the )?(diff|changes?|what (changed|you did|was changed))\.?$/i,
  /^(show|display) diff\.?$/i,
  /^what('?d| did) you (change|do|edit)\.?\??$/i,
  /^what changed\.?\??$/i,
  /^show changes?\.?$/i,
  /^diff\.?$/i,
];

/** Returns true when the user wants to see the current change summary. */
export function isShowDiffRequest(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  if (trimmed.startsWith('/')) return false;
  return SHOW_DIFF_PATTERNS.some((re) => re.test(trimmed));
}

const DEFERRED_ANSWER_PATTERNS: RegExp[] = [
  /^i (don'?t|do not) know\.?$/i,
  /^(your|your own) (call|choice|pick|decision|judgment|judgement|preference)\.?$/i,
  /^up to you\.?$/i,
  /^whatever (you think|you prefer|works|is best|makes sense)\.?$/i,
  /^you (decide|choose|pick)\.?$/i,
  /^(use your )?(best )?judgment\.?$/i,
  /^any(thing| of them)\.?$/i,
  /^(it )?doesn'?t matter\.?$/i,
  /^(no|no strong) preference\.?$/i,
  /^(just )?(go with|pick) (whatever|what you think)\.?$/i,
  /^sure[,!]?\s+(your call|up to you|whatever)\.?$/i,
];

/** Returns true when the user is deferring a pending question back to the agent. */
export function isDeferredAnswer(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return false;
  if (trimmed.startsWith('/')) return false;
  return DEFERRED_ANSWER_PATTERNS.some((re) => re.test(trimmed));
}

const PLAN_REJECTION_PATTERNS: RegExp[] = [
  /^no\.?$/i,
  /^nope\.?$/i,
  /^nah\.?$/i,
  /^cancel\.?$/i,
  /^reject\.?$/i,
  /^rejected\.?$/i,
  /^stop\.?$/i,
  /^abort\.?$/i,
  /^start over\.?$/i,
  /^scratch that\.?$/i,
  /^never mind\.?$/i,
  /^nevermind\.?$/i,
  /^forget it\.?$/i,
  /^discard(ed)?\.?$/i,
  /^don'?t (do it|proceed|execute)\.?$/i,
  /^no[,!]?\s+(thanks?|thank you)\.?$/i,
];

/** Returns true when the user is rejecting a presented plan. */
export function isPlanRejection(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return false;
  if (trimmed.startsWith('/')) return false;
  return PLAN_REJECTION_PATTERNS.some((re) => re.test(trimmed));
}

const UNDO_REQUEST_PATTERNS: RegExp[] = [
  /^undo\.?$/i,
  /^undo (that|this|it|the changes?|all)\.?$/i,
  /^revert\.?$/i,
  /^revert (that|this|it|the changes?)\.?$/i,
  /^roll ?back\.?$/i,
  /^roll ?back (that|this|the changes?)\.?$/i,
  /^un-?do that\.?$/i,
  /^take that back\.?$/i,
  /^restore (original|previous)\.?$/i,
];

/** Returns true when the user wants to undo the agent's file changes. */
export function isUndoRequest(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 50) return false;
  if (trimmed.startsWith('/')) return false;
  return UNDO_REQUEST_PATTERNS.some((re) => re.test(trimmed));
}

const PLAN_APPROVAL_PATTERNS: RegExp[] = [
  /^yes\.?$/i,
  /^yeah\.?$/i,
  /^yep\.?$/i,
  /^yup\.?$/i,
  /^sure\.?$/i,
  /^ok\.?$/i,
  /^okay\.?$/i,
  /^sounds good\.?$/i,
  /^looks good\.?$/i,
  /^go ahead\.?$/i,
  /^go for it\.?$/i,
  /^do it\.?$/i,
  /^let'?s? (go|do it)\.?$/i,
  /^proceed\.?$/i,
  /^approved?\.?$/i,
  /^execute\.?$/i,
  /^execute (the )?plan\.?$/i,
  /^run (it|the plan)\.?$/i,
  /^(that'?s? )?good\.?$/i,
  /^(that'?s? )?perfect\.?$/i,
  /^i approve\.?$/i,
  /^yes[,!]? (please|go ahead|do it|proceed)\.?$/i,
];

/** Returns true when the user's message is a plain approval of a presented plan. */
export function isPlanApproval(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 40) return false;
  if (trimmed.startsWith('/')) return false;
  return PLAN_APPROVAL_PATTERNS.some((re) => re.test(trimmed));
}

export function isContinuationRequest(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > 30) return false;
  if (trimmed.startsWith('/')) return false;
  return CONTINUATION_PATTERNS.some((re) => re.test(trimmed));
}

/**
 * Detect if a user request should automatically trigger plan mode.
 * Large tasks benefit from planning before execution.
 */
/** Returns true when the message body looks like a pre-written plan (bullets or numbered list). */
function hasPrewrittenList(text: string): boolean {
  const bulletLines = (text.match(/^[\s]*[-*•]\s+\S/gm) || []).length;
  if (bulletLines >= 2) return true;
  const numberedLines = (text.match(/^[\s]*\d+[.)]\s+\S/gm) || []).length;
  if (numberedLines >= 2) return true;
  return false;
}

export function shouldAutoEnablePlanMode(text: string, conversationLength: number): boolean {
  if (!text) return false;

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

export function classifyError(message: string): {
  errorType:
    | 'connection'
    | 'auth'
    | 'model'
    | 'timeout'
    | 'rate_limit'
    | 'server_error'
    | 'content_policy'
    | 'token_limit'
    | 'unknown';
  errorAction?: string;
  errorActionCommand?: string;
} {
  const lower = message.toLowerCase();
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('eaddrnotavail') ||
    lower.includes('ehostunreach') ||
    lower.includes('econnreset') ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    return { errorType: 'connection', errorAction: 'Check Connection', errorActionCommand: 'openSettings' };
  }
  if (lower.includes('429') || lower.includes('rate limit') || lower.includes('too many requests')) {
    return { errorType: 'rate_limit', errorAction: 'Wait and Retry' };
  }
  if (
    lower.includes('content_policy') ||
    lower.includes('content policy') ||
    lower.includes('safety') ||
    lower.includes('flagged')
  ) {
    return { errorType: 'content_policy' };
  }
  if (
    lower.includes('token') &&
    (lower.includes('limit') || lower.includes('exceed') || lower.includes('too long') || lower.includes('maximum'))
  ) {
    return { errorType: 'token_limit', errorAction: 'Reduce Context', errorActionCommand: 'compactContext' };
  }
  if (
    lower.includes('401') ||
    lower.includes('403') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid api key')
  ) {
    return { errorType: 'auth', errorAction: 'Check API Key', errorActionCommand: 'openSettings' };
  }
  if (lower.includes('404') && (lower.includes('model') || lower.includes('not found'))) {
    return { errorType: 'model', errorAction: 'Install Model' };
  }
  if (
    lower.includes('500') ||
    lower.includes('502') ||
    lower.includes('503') ||
    lower.includes('504') ||
    lower.includes('internal server error') ||
    lower.includes('bad gateway') ||
    lower.includes('service unavailable') ||
    lower.includes('overloaded')
  ) {
    return { errorType: 'server_error', errorAction: 'Retry' };
  }
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('etimedout')) {
    return { errorType: 'timeout', errorAction: 'Retry' };
  }
  return { errorType: 'unknown' };
}

/**
 * Compute keyword overlap between two strings.
 * Returns a ratio in [0, 1] where 0 = no shared keywords, 1 = identical.
 * Used to detect topic changes between consecutive user messages.
 */
export function keywordOverlap(a: string, b: string): number {
  const stopWords = new Set([
    'the',
    'a',
    'an',
    'is',
    'are',
    'was',
    'were',
    'be',
    'been',
    'being',
    'have',
    'has',
    'had',
    'do',
    'does',
    'did',
    'will',
    'would',
    'could',
    'should',
    'may',
    'might',
    'can',
    'to',
    'of',
    'in',
    'for',
    'on',
    'with',
    'at',
    'by',
    'from',
    'it',
    'this',
    'that',
    'and',
    'or',
    'but',
    'not',
    'if',
    'so',
    'as',
    'i',
    'me',
    'my',
    'you',
    'your',
    'we',
    'our',
    'they',
    'them',
    'what',
    'how',
    'why',
    'when',
    'where',
    'which',
    'who',
    'please',
    'just',
    'also',
  ]);

  const tokenize = (s: string) => {
    const words = s
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 2 && !stopWords.has(w));
    return new Set(words);
  };

  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const w of setA) {
    if (setB.has(w)) intersection++;
  }
  return intersection / Math.max(setA.size, setB.size);
}

/**
 * Decay (or reset) workspace index relevance scores for this turn.
 * Resets entirely when the new message's keyword overlap with the previous
 * user message is < 15% — that's the topic-change heuristic that keeps
 * stale files from dominating context after a pivot.
 */
export function updateWorkspaceRelevance(state: ChatState, text: string): void {
  if (!state.workspaceIndex) return;
  if (!text) {
    state.workspaceIndex.decayRelevance();
    return;
  }
  const userMsgs = state.messages.filter((m) => m.role === 'user');
  const prevQuery = userMsgs.length >= 2 ? String(userMsgs[userMsgs.length - 2].content) : '';
  const overlap = prevQuery ? keywordOverlap(text, prevQuery) : 1;
  if (overlap < 0.15) {
    state.workspaceIndex.resetRelevance();
  } else {
    state.workspaceIndex.decayRelevance();
  }
}

/**
 * Enrich the raw user text with a prefix that tells the model how to
 * interpret short replies. Three cases:
 *   - pendingQuestion + short reply → wrap as "[Responding to your question]"
 *   - prior assistant + continuation keyword → "[Continuation request]" directive
 *   - everything else → unchanged
 * Consumes `state.pendingQuestion` on the first path.
 */
/**
 * Parse a bare number reference from a short user message.
 * Accepts: "2", "#2", "2.", "2)", "option 2", "item 2", "choice 2", "number 2"
 * Optionally followed by trailing prose ("2 please", "let's do 2").
 * Returns the 1-based index, or null if the message isn't a number reference.
 */
function parseNumberReference(text: string): { index: number; trailer: string } | null {
  const t = text.trim();
  if (t.length > 80) return null;

  // "option 2", "item 2", "choice 2", "number 2" — keyword prefix makes intent unambiguous.
  // "#2" — hash prefix also unambiguous.
  const prefixed = t.match(/^(?:(?:option|item|choice|number)\s+|#)(\d+)[.):]?\s*(.*)?$/i);
  if (prefixed) {
    const index = parseInt(prefixed[1], 10);
    if (index < 1 || index > 20) return null;
    return { index, trailer: (prefixed[2] ?? '').trim() };
  }

  // Bare "2", "2.", "2)" — allow only a short qualifier trailer (≤ 4 words)
  // so "2 please" resolves but "2 things need to change here" does not.
  const bare = t.match(/^(\d+)[.):]?\s*(.*)?$/);
  if (bare) {
    const index = parseInt(bare[1], 10);
    if (index < 1 || index > 20) return null;
    const trailer = (bare[2] ?? '').trim();
    if (trailer.split(/\s+/).filter(Boolean).length > 4) return null;
    return { index, trailer };
  }

  return null;
}

/**
 * Extract numbered list items from an assistant message body.
 * Handles both `1. text` and `1) text` styles, including multi-line items.
 */
function extractNumberedItems(body: string): string[] {
  const lines = body.split('\n');
  const items: string[] = [];
  let current: string | null = null;
  for (const line of lines) {
    const m = line.match(/^(\d+)[.)]\s+(.+)/);
    if (m) {
      if (current !== null) items.push(current.trim());
      current = m[2];
    } else if (current !== null) {
      // continuation line of the same item (indented or blank separators)
      const stripped = line.trimStart();
      if (stripped.length === 0) continue;
      // Stop if we hit a new structural element (heading, bullet, code fence)
      if (/^#{1,6}\s|^[-*•]\s|^```/.test(stripped)) {
        items.push(current.trim());
        current = null;
      } else {
        current += ' ' + stripped;
      }
    }
  }
  if (current !== null) items.push(current.trim());
  return items;
}

/**
 * If the user's message looks like a numbered-list selection ("2", "option 3",
 * "#1") and the most recent assistant message contained a numbered list, expand
 * the reference into a contextual message the model can act on unambiguously.
 * Returns null when the message is not a number reference or no list is found.
 */
export function resolveNumberedListRef(text: string, messages: ChatState['messages']): string | null {
  const ref = parseNumberReference(text);
  if (!ref) return null;

  // Find the last assistant message that contains a numbered list.
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  if (!lastAssistant) return null;

  const body = getContentText(lastAssistant.content);
  const items = extractNumberedItems(body);
  if (items.length === 0) return null;

  const item = items[ref.index - 1];
  if (!item) return null;

  const trailerSuffix = ref.trailer ? ` — ${ref.trailer}` : '';
  return (
    `[User selected item ${ref.index} from your list${trailerSuffix}]: "${item}"\n\n` +
    `Proceed with: ${item}${ref.trailer ? `. Additional context: ${ref.trailer}` : '.'}`
  );
}

export function prepareUserMessageText(state: ChatState, text: string): string {
  const hasPriorAssistant = state.messages.some((m) => m.role === 'assistant');
  if (state.pendingQuestion) {
    const question = state.pendingQuestion;
    state.pendingQuestion = null;
    if (isDeferredAnswer(text)) {
      return (
        `[The user deferred your question: "${question}"]\n\n` +
        `Use your best judgment and proceed. Do not ask again — make a reasonable choice and continue.`
      );
    }
    const isShortReply = text.split(/\s+/).length <= 8 && !text.startsWith('/');
    return isShortReply ? `[Responding to your question: "${question}"]\n\n${text}` : text;
  }
  if (hasPriorAssistant) {
    const resolved = resolveNumberedListRef(text, state.messages);
    if (resolved) return resolved;
  }
  if (hasPriorAssistant && isContinuationRequest(text)) {
    return (
      `[Continuation request: user said "${text}"]\n\n` +
      `Resume the work from your most recent response. Pick up exactly where you left off — ` +
      `do not repeat steps you already completed and do not re-summarize. ` +
      `If you stopped mid-task (iteration limit, error, cycle detection, or partial answer), ` +
      `continue executing the remaining steps. If the prior task is fully complete, take the ` +
      `next logical step toward the user's original goal in this conversation.`
    );
  }
  return text;
}

export function languageToExtension(lang: string): string {
  const map: Record<string, string> = {
    typescript: '.ts',
    javascript: '.js',
    python: '.py',
    rust: '.rs',
    go: '.go',
    java: '.java',
    cpp: '.cpp',
    c: '.c',
    html: '.html',
    css: '.css',
    json: '.json',
    yaml: '.yaml',
    markdown: '.md',
    bash: '.sh',
    sh: '.sh',
    sql: '.sql',
    tsx: '.tsx',
    jsx: '.jsx',
  };
  return map[lang.toLowerCase()] || '.txt';
}
