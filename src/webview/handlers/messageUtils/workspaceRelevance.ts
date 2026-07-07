/**
 * Topic-change detection for the workspace file index: keyword overlap between
 * consecutive user messages drives whether relevance scores decay or fully
 * reset (a pivot shouldn't let stale files keep dominating context).
 */

import type { ChatState } from '../../chatState.js';

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
