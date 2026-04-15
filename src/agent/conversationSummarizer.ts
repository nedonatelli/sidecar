import type { ChatMessage } from '../ollama/types.js';
import { getContentText, getContentLength } from '../ollama/types.js';
import type { SideCarClient } from '../ollama/client.js';

/** Truncate text to maxLen, breaking at a word boundary to avoid cutting file paths mid-name. */
function smartTruncate(text: string, maxLen: number): string {
  const flat = text.replace(/\n/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  // Find the last space before maxLen so we don't split a path or word
  const breakpoint = flat.lastIndexOf(' ', maxLen);
  const cutAt = breakpoint > maxLen * 0.6 ? breakpoint : maxLen;
  return flat.slice(0, cutAt) + '…';
}

/**
 * Summarizes older conversation turns to reduce context bloat.
 *
 * Strategy:
 *  - Identify "turn boundaries" (sequences of user → assistant messages)
 *  - Keep the last N turns untouched (fresh context)
 *  - For older turns, extract key facts and use the LLM to create a compact summary
 *  - Replace old turns with a single summarized block at the conversation start
 *
 * Example: 25 turns become "Summary of turns 1–20 (discovered X, fixed Y)" + full turns 21–25.
 *
 * This is especially valuable in long agent loops where early exploration becomes irrelevant.
 */

export interface SummaryResult {
  /** The summarized messages (older turns replaced with summary). */
  messages: ChatMessage[];
  /** Character count freed by summarization. */
  freedChars: number;
  /** Metadata about what was summarized. */
  metadata: {
    turnsCount: number;
    turnsSummarized: number;
    summaryLength: number;
  };
}

export interface SummarizeOptions {
  /** Keep this many recent turns untouched. Default: 4 */
  keepRecentTurns?: number;
  /** Only summarize if we can save at least this many chars. Default: 2000 */
  minCharsToSave?: number;
  /** Max chars in the generated summary. Default: 800 */
  maxSummaryLength?: number;
  /**
   * Max chars any single turn may contribute to the per-turn facts list
   * before it's truncated. Capping this bounds the pre-LLM `facts` aggregate
   * at roughly `oldTurns.length * maxCharsPerTurn`, which makes it far more
   * likely to fit inside `maxSummaryLength` directly and skip the LLM
   * round-trip. Default: 220 (enough to preserve a query and a short reply).
   */
  maxCharsPerTurn?: number;
  /** Timeout for the summarization LLM call (ms). Default: 10000 */
  summaryTimeoutMs?: number;
}

/**
 * Default per-turn contribution cap. Kept below `maxSummaryLength / 4` so
 * the fact concatenation of a typical 10-turn window stays within the
 * default summary budget without needing an LLM compression pass.
 */
export const DEFAULT_MAX_CHARS_PER_TURN = 220;

export class ConversationSummarizer {
  private client: SideCarClient;

  constructor(client: SideCarClient) {
    this.client = client;
  }

  /**
   * Attempt to summarize old conversation turns.
   * Returns the deduplicated messages and chars freed. If summarization fails,
   * returns the original messages with zero chars freed.
   */
  async summarize(messages: ChatMessage[], options: SummarizeOptions = {}): Promise<SummaryResult> {
    const keepRecentTurns = options.keepRecentTurns ?? 4;
    const minCharsToSave = options.minCharsToSave ?? 2000;
    const maxSummaryLength = options.maxSummaryLength ?? 800;
    const maxCharsPerTurn = options.maxCharsPerTurn ?? DEFAULT_MAX_CHARS_PER_TURN;
    const summaryTimeoutMs = options.summaryTimeoutMs ?? 10000;

    // Edge case: too few messages to bother
    if (messages.length < 10) {
      return {
        messages,
        freedChars: 0,
        metadata: {
          turnsCount: 1,
          turnsSummarized: 0,
          summaryLength: 0,
        },
      };
    }

    // Split into turns
    const turns = this.splitIntoTurns(messages);
    if (turns.length <= keepRecentTurns) {
      // Not enough old turns to summarize
      return {
        messages,
        freedChars: 0,
        metadata: {
          turnsCount: turns.length,
          turnsSummarized: 0,
          summaryLength: 0,
        },
      };
    }

    // Identify which turns to summarize (all but the last N)
    const recentTurns = turns.slice(-keepRecentTurns);
    const oldTurns = turns.slice(0, turns.length - keepRecentTurns);

    // Estimate chars we'd save
    const oldTurnsChars = oldTurns.reduce((sum, turn) => {
      return sum + turn.reduce((s, msg) => s + getContentLength(msg.content), 0);
    }, 0);

    // Only proceed if savings would be material
    if (oldTurnsChars < minCharsToSave) {
      return {
        messages,
        freedChars: 0,
        metadata: {
          turnsCount: turns.length,
          turnsSummarized: 0,
          summaryLength: 0,
        },
      };
    }

    // Try to summarize the old turns
    try {
      const summary = await this.generateSummary(oldTurns, maxSummaryLength, maxCharsPerTurn, summaryTimeoutMs);

      // Build new message array: summary block + recent turns
      const newMessages: ChatMessage[] = [];

      // Insert summary as a user message + assistant acknowledgment to maintain
      // valid message alternation (prevents consecutive user messages which
      // Anthropic API rejects).
      newMessages.push({
        role: 'user',
        content: `[Earlier conversation summary (turns 1–${oldTurns.length})]\n${summary}`,
      });
      newMessages.push({
        role: 'assistant',
        content: 'Understood. I have the conversation context from the summary above.',
      });

      // Flatten recent turns back into message array
      for (const turn of recentTurns) {
        newMessages.push(...turn);
      }

      const freedChars = oldTurnsChars - summary.length;
      return {
        messages: newMessages,
        freedChars: Math.max(0, freedChars),
        metadata: {
          turnsCount: turns.length,
          turnsSummarized: oldTurns.length,
          summaryLength: summary.length,
        },
      };
    } catch (error) {
      // If summarization fails, return original messages unchanged
      console.warn('Conversation summarization failed:', error);
      return {
        messages,
        freedChars: 0,
        metadata: {
          turnsCount: turns.length,
          turnsSummarized: 0,
          summaryLength: 0,
        },
      };
    }
  }

  /**
   * Split messages into turns.
   * A turn is: user message + all following assistant/tool messages until the next user message.
   */
  private splitIntoTurns(messages: ChatMessage[]): Array<ChatMessage[]> {
    const turns: Array<ChatMessage[]> = [];
    let currentTurn: ChatMessage[] = [];

    for (const msg of messages) {
      const isNewUserTurn = msg.role === 'user' && typeof msg.content === 'string';
      if (isNewUserTurn && currentTurn.length > 0) {
        turns.push(currentTurn);
        currentTurn = [];
      }
      currentTurn.push(msg);
    }

    if (currentTurn.length > 0) {
      turns.push(currentTurn);
    }

    return turns;
  }

  /**
   * Generate a compact summary of old turns using the LLM.
   * Extracts key facts: files examined, issues found, decisions made, progress.
   */
  private async generateSummary(
    oldTurns: Array<ChatMessage[]>,
    maxLength: number,
    maxCharsPerTurn: number,
    timeoutMs: number,
  ): Promise<string> {
    // Budget the user query and the assistant reply to roughly half the
    // per-turn cap each. The final trim after join ensures the assembled
    // line never exceeds maxCharsPerTurn even with the "Turn N: " prefix.
    const queryBudget = Math.max(60, Math.floor(maxCharsPerTurn * 0.45));
    const replyBudget = Math.max(60, Math.floor(maxCharsPerTurn * 0.55));

    // Build a compact representation of what happened in these turns
    const facts: string[] = [];

    for (let i = 0; i < oldTurns.length; i++) {
      const turn = oldTurns[i];
      const userMsg = turn[0];
      const userText = typeof userMsg.content === 'string' ? userMsg.content : getContentText(userMsg.content);

      const userQuery = smartTruncate(userText, queryBudget);

      const assistantChunks: string[] = [];
      for (const msg of turn.slice(1)) {
        if (msg.role === 'assistant') {
          const text = getContentText(msg.content);
          if (text.length > 0) {
            assistantChunks.push(smartTruncate(text, replyBudget));
          }
        }
      }

      const turnSummary =
        assistantChunks.length > 0
          ? `Turn ${i + 1}: ${userQuery} → ${assistantChunks[0]}`
          : `Turn ${i + 1}: ${userQuery}`;

      // Hard cap the assembled line so a wide query+reply pair can't blow
      // past the per-turn budget.
      facts.push(turnSummary.length > maxCharsPerTurn ? turnSummary.slice(0, maxCharsPerTurn - 1) + '…' : turnSummary);
    }

    // If facts alone are small enough, just use them
    const factsSummary = facts.join('\n');
    if (factsSummary.length <= maxLength) {
      return factsSummary;
    }

    // Otherwise, ask the LLM to compress further
    const prompt = `Summarize these conversation turns into ${Math.floor(maxLength / 4)} words or less. Focus on:
- Files/code examined
- Issues or errors found
- Solutions attempted
- Key decisions made

Turns:
${facts.join('\n')}

Compact summary:`;

    try {
      const summarizeMessages: ChatMessage[] = [{ role: 'user', content: prompt }];

      // Request summary with timeout
      const summaryPromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Summarization timeout')), timeoutMs);

        this.client
          .complete(summarizeMessages, maxLength)
          .then((result) => {
            clearTimeout(timer);
            // Extract text summary (may contain other blocks)
            const text =
              typeof result === 'string'
                ? result
                : getContentText(
                    typeof result === 'string'
                      ? result
                      : Array.isArray(result)
                        ? result
                        : [{ type: 'text' as const, text: String(result) }],
                  );

            // Clean up and truncate
            const clean = text.trim().replace(/^(Compact summary:?|Summary:?)\s*/i, '');
            resolve(clean.slice(0, maxLength));
          })
          .catch(reject);
      });

      return await summaryPromise;
    } catch {
      // Fall back to simple fact concatenation
      return factsSummary.slice(0, maxLength);
    }
  }
}
