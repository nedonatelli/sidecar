/**
 * Utility functions for message classification and workspace relevance.
 * Extracted from chatHandlers.ts to reduce its size.
 */

import type { ChatState } from '../chatState.js';
import { PLAN_MODE_THRESHOLDS } from '../../config/constants.js';

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
export function shouldAutoEnablePlanMode(text: string, conversationLength: number): boolean {
  if (!text) return false;

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

  const hasMultipleSteps = (text.match(/^\d+\./gm) || []).length >= 3;
  if (hasMultipleSteps && charCount > 500) {
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
export function prepareUserMessageText(state: ChatState, text: string): string {
  const hasPriorAssistant = state.messages.some((m) => m.role === 'assistant');
  if (state.pendingQuestion) {
    const isShortReply = text.split(/\s+/).length <= 8 && !text.startsWith('/');
    const wrapped = isShortReply ? `[Responding to your question: "${state.pendingQuestion}"]\n\n${text}` : text;
    state.pendingQuestion = null;
    return wrapped;
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
