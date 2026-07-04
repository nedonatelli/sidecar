/**
 * User-message enrichment before it reaches the model: numbered-list reference
 * expansion, pending-question / continuation framing, and language→extension
 * mapping for fenced code blocks.
 */

import type { ChatState } from '../../chatState.js';
import { getContentText } from '../../../ollama/types.js';
import { isDeferredAnswer, isContinuationRequest } from './intentClassifiers.js';

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
