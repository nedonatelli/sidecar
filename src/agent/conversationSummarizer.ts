import type { ChatMessage } from '../ollama/types.js';
import { logger } from '../system/logger.js';
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
 * Tool names that mutate files in the workspace. Any `tool_use` block with
 * one of these names contributes a line to the `## Code changes` section
 * of the structured summary. Kept permissive — OK to include a tool here
 * that doesn't actually change files (the section is informational, not
 * load-bearing), but missing a real mutator means the summary under-reports.
 */
const CODE_CHANGE_TOOL_PATTERN =
  /^(write_file|edit_file|delete_file|create_file|rename_file|move_file|apply_edit|apply_patch)$/;

/** Plausible path-carrying input keys across the built-in file tools. */
const PATH_KEYS = ['path', 'filePath', 'file_path', 'file', 'target', 'source'] as const;

/** Pull a path string out of a `tool_use` input record, tolerating the key variation across tools. */
function pathFromToolInput(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  for (const key of PATH_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

/**
 * Walk the old turns and emit one bullet per (path, tool) touched. Dedups
 * by path keeping the last tool that touched it — reflects the final
 * intent after a write → edit → edit sequence on the same file.
 */
function extractCodeChanges(turns: Array<ChatMessage[]>): string[] {
  const lastToolByPath = new Map<string, string>();
  for (const turn of turns) {
    for (const msg of turn) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type !== 'tool_use') continue;
        if (!CODE_CHANGE_TOOL_PATTERN.test(block.name)) continue;
        const p = pathFromToolInput(block.input);
        if (p) lastToolByPath.set(p, block.name);
      }
    }
  }
  return Array.from(lastToolByPath.entries()).map(([p, tool]) => `- \`${p}\` (${tool})`);
}

/** Cap on distinct error lines carried into the summary. */
const MAX_ERROR_LINES = 5;

/**
 * Walk the old turns and pull one line per DISTINCT failed tool call
 * (tool_result blocks with is_error). Errors are load-bearing across
 * compaction: a model that forgets "edit_file failed: file does not exist —
 * use write_file" re-walks the same dead end after the turns are shed.
 * Dedups by (tool, first line of message); keeps the first occurrence.
 */
function extractErrors(turns: Array<ChatMessage[]>): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const nameById = new Map<string, string>();
  for (const turn of turns) {
    for (const msg of turn) {
      if (!Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block.type === 'tool_use') nameById.set(block.id, block.name);
        if (block.type !== 'tool_result' || !block.is_error) continue;
        const text = typeof block.content === 'string' ? block.content : getContentText(block.content);
        const firstLine = smartTruncate(text, 120);
        const tool = nameById.get(block.tool_use_id) ?? 'tool';
        const key = `${tool}:${firstLine}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (lines.length < MAX_ERROR_LINES) lines.push(`- ${tool}: ${firstLine}`);
      }
    }
  }
  return lines;
}

/**
 * Assemble the structured Markdown summary from pre-computed fact lines,
 * detected code-change entries, and distinct errors hit. Omits sections
 * that have no content so the summary never includes empty headers.
 */
function assembleStructuredSummary(
  factLines: string[],
  codeChanges: string[],
  errors: string[] = [],
  standingInstructions: string[] = [],
): string {
  const parts: string[] = [];
  if (standingInstructions.length > 0) {
    // First section — the most durable content leads, so even a downstream
    // truncation keeps the user's standing rules.
    parts.push('## Standing instructions\n' + standingInstructions.map((l) => `- ${l}`).join('\n'));
  }
  if (factLines.length > 0) {
    parts.push('## Facts established\n' + factLines.map((l) => `- ${l}`).join('\n'));
  }
  if (codeChanges.length > 0) {
    parts.push('## Code changes\n' + codeChanges.join('\n'));
  }
  if (errors.length > 0) {
    parts.push('## Errors hit\n' + errors.join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * Durable-instruction markers. The naive-English test: would a reader call
 * this sentence a standing rule rather than a one-off request? Validated
 * against the long-horizon cases' real phrasings ("remember the magic word is
 * pineapple", "all results must be even") — extend from dogfood corpus, not
 * invented fixtures.
 */
const STANDING_INSTRUCTION_RE =
  /\b(?:always|never|must(?:\s+not)?|remember|from now on|do not|don't|make sure|ensure that|every time|going forward|keep in mind|only use|use only|no matter what)\b/i;

/**
 * Deterministic latch for the durable-context package: pull instruction-shaped
 * sentences out of the USER messages being compacted away, verbatim. The
 * ceiling run proved the failure is structural — even a frontier summarizer
 * drops "the answer must be even" through the four-section prompt because no
 * section owns it — so the floor must not depend on any model. Skips synthetic
 * '['-prefixed loop injections and tool-result carriers. Per-entry and total
 * caps bound the token cost that made unscoped verbatim preservation a wash.
 */
export function extractStandingInstructions(
  messages: ChatMessage[],
  opts: { perEntryChars?: number; totalChars?: number } = {},
): string[] {
  const perEntry = opts.perEntryChars ?? 200;
  const total = opts.totalChars ?? 800;
  const out: string[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const msg of messages) {
    if (msg.role !== 'user') continue;
    const raw =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .filter((b) => b.type === 'text')
            .map((b) => (b as { text: string }).text)
            .join(' ');
    const text = raw.trim();
    // RE-LATCH before the synthetic skip: a prior summary message carries its
    // own `## Standing instructions` section AND starts with '[Earlier
    // conversation summary…]' — skipping it as a synthetic injection killed
    // every latched instruction at the SECOND compaction (found live:
    // memory-recall forces several compactions; latched=0 in final history).
    // Same self-masking class as the v0.120 action-reprompt '[' bug.
    const sectionMatch = /## Standing instructions\n((?:- [^\n]+\n?)+)/.exec(text);
    if (sectionMatch) {
      for (const line of sectionMatch[1].split('\n')) {
        const entry = line.replace(/^- /, '').trim();
        if (entry === '') continue;
        const key = entry.toLowerCase();
        if (seen.has(key) || used + entry.length > total) continue;
        seen.add(key);
        out.push(entry);
        used += entry.length;
      }
      continue; // the rest of a summary message is compressed prose, not user intent
    }
    if (text === '' || text.startsWith('[')) continue; // synthetic injections carry no user intent
    for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
      const t = sentence.trim();
      if (t.length < 8 || !STANDING_INSTRUCTION_RE.test(t)) continue;
      const entry = t.length > perEntry ? t.slice(0, perEntry) + '…' : t;
      const key = entry.toLowerCase();
      if (seen.has(key)) continue;
      if (used + entry.length > total) return out;
      seen.add(key);
      out.push(entry);
      used += entry.length;
    }
  }
  return out;
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
  /**
   * Durable-context package (`sidecar.compaction.durableInstructions`):
   * deterministically latch instruction-shaped user sentences into a leading
   * `## Standing instructions` section, and instruct the LLM path to carry
   * the section too. Off (false) preserves pre-package behavior exactly.
   */
  durableInstructions?: boolean;
  /**
   * Max chars of user messages preserved VERBATIM above the model summary.
   * User turns are short, so this is cheap; it is how standing instructions and
   * constraints survive compaction without depending on the summarizer model.
   * Default: 1500.
   */
  maxVerbatimUserChars?: number;
}

/**
 * Extract the user's own messages, verbatim, from the turns being summarized.
 *
 * A turn (per splitIntoTurns) begins with the real user message; tool results are
 * role:'user' but never start a turn, so `turn[0]` is the user's actual words when
 * it is a user role. Synthetic injections (gate reprompts, prior summaries — they
 * start with '[') and empty/text-free messages are skipped: they are not the user
 * speaking. Each message is capped, and the total is bounded keeping the MOST
 * RECENT (a later instruction supersedes an earlier one, and recency is the safer
 * thing to retain under budget).
 *
 * Pure and exported for unit testing — this is the deterministic core of "keep the
 * user's words so standing instructions survive compaction".
 */
export function extractUserMessagesVerbatim(oldTurns: ChatMessage[][], maxChars: number, perMessageCap = 500): string {
  const lines: string[] = [];
  for (const turn of oldTurns) {
    const first = turn[0];
    if (!first || first.role !== 'user') continue;
    const text = getContentText(first.content).trim();
    if (text === '' || text.startsWith('[')) continue; // tool-result / synthetic
    const oneLine = text.replace(/\s+/g, ' ');
    const capped = oneLine.length > perMessageCap ? oneLine.slice(0, perMessageCap) + '…' : oneLine;
    lines.push(`- ${capped}`);
  }
  // Keep the most recent lines that fit within the budget.
  let out = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const next = out ? lines[i] + '\n' + out : lines[i];
    if (next.length > maxChars) break;
    out = next;
  }
  return out;
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
      const summary = await this.generateSummary(
        oldTurns,
        maxSummaryLength,
        maxCharsPerTurn,
        summaryTimeoutMs,
        options.durableInstructions === true,
      );

      // Preserve the user's OWN messages verbatim, ABOVE the model summary.
      //
      // The summary is generated by a (possibly weak) model compressing old turns
      // into "facts", and a whole class of content has no home in that structure:
      // standing instructions ("remember the magic word is pineapple") and durable
      // constraints ("every config value must be even") are neither a fact, a code
      // change, an error, nor pending work — so they get dropped, and the model
      // later fails a task that depended on them. Measured: gemma4/ministral lose
      // exactly these through compaction.
      //
      // User messages are the CHEAP part of the window — short instructions and
      // questions, not the bulky tool output that actually bloats context — so
      // keeping them verbatim costs little and preserves standing instructions
      // DETERMINISTICALLY, with no dependence on the summarizer model's judgment.
      // This is how Claude Code's own compaction survives "remember X": it keeps an
      // "All user messages" block word-for-word rather than trusting a distillation.
      const verbatimUser = extractUserMessagesVerbatim(oldTurns, options.maxVerbatimUserChars ?? 1500);

      // Build new message array: summary block + recent turns
      const newMessages: ChatMessage[] = [];

      // Insert summary as a user message + assistant acknowledgment to maintain
      // valid message alternation (prevents consecutive user messages which
      // Anthropic API rejects).
      const summaryBody = verbatimUser
        ? `## User messages so far (verbatim — the user's own words; any standing instruction or ` +
          `constraint here is still in force)\n${verbatimUser}\n\n${summary}`
        : summary;
      newMessages.push({
        role: 'user',
        content: `[Earlier conversation summary (turns 1–${oldTurns.length})]\n${summaryBody}`,
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
      logger.warn('Conversation summarization failed:', error);
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
      // Tool-result messages are also role:'user' but have ContentBlock[] content with
      // tool_result blocks — those are NOT turn boundaries. A new turn starts only when
      // the user sends a real text/image message (not a tool response).
      const isNewUserTurn =
        msg.role === 'user' &&
        (typeof msg.content === 'string' ||
          (Array.isArray(msg.content) && msg.content.every((b) => b.type !== 'tool_result')));
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
   * Generate a compact, structured summary of old turns.
   *
   * Output format is always Markdown with two optional sections:
   *
   *   ## Facts established
   *   - Turn 1: <query> → <reply>
   *   - ...
   *
   *   ## Code changes
   *   - `path/to/file.ts` (edit_file)
   *   - ...
   *
   * When the deterministic per-turn extraction fits in `maxLength` we return
   * it directly (fast path, no LLM round-trip). Otherwise the LLM is asked to
   * compress the fact lines further while keeping the same section headers,
   * so the caller always sees a consistent structure regardless of path.
   */
  private async generateSummary(
    oldTurns: Array<ChatMessage[]>,
    maxLength: number,
    maxCharsPerTurn: number,
    timeoutMs: number,
    durableInstructions = false,
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
      // past the per-turn budget. Measured against maxCharsPerTurn directly —
      // the `- ` bullet prefix added by assembleStructuredSummary isn't
      // counted so callers with very tight caps still get consistent bullet
      // widths across summaries.
      facts.push(turnSummary.length > maxCharsPerTurn ? turnSummary.slice(0, maxCharsPerTurn - 1) + '…' : turnSummary);
    }

    // Extract code changes and distinct errors from structured tool-call
    // data (not prose) — deterministic, so they survive the fast path and
    // the LLM path identically.
    const codeChanges = extractCodeChanges(oldTurns);
    const errors = extractErrors(oldTurns);
    const standing = durableInstructions ? extractStandingInstructions(oldTurns.flat()) : [];

    // Fast path: if the structured assembly fits, return it as-is and skip
    // the LLM round-trip entirely.
    const structured = assembleStructuredSummary(facts, codeChanges, errors, standing);
    if (structured.length <= maxLength) {
      return structured;
    }

    // Slow path: ask the LLM to compress the fact lines into fewer, denser
    // bullets under the same `## Facts established` header. We pass the
    // detected code changes verbatim — the LLM shouldn't re-invent them.
    const verbatimTail = [
      codeChanges.length > 0 ? 60 + codeChanges.join('\n').length : 0,
      errors.length > 0 ? 60 + errors.join('\n').length : 0,
    ].reduce((a, b) => a + b, 0);
    const factBudget = Math.max(100, maxLength - verbatimTail);
    const standingBlock =
      standing.length > 0
        ? "## Standing instructions\n(Use the latched list provided below verbatim — these are the user's durable rules; never drop or reword them.)\n\n"
        : durableInstructions
          ? '## Standing instructions\n- <ONLY durable rules the user stated that still apply — "always/never/must/remember" style constraints, copied near-verbatim. Omit this section entirely when there are none. Never invent one.>\n\n'
          : '';
    const prompt = `Compress the raw conversation turns below into a Markdown document with this exact structure:

${standingBlock}## Facts established
- <concise bullet — one finding, decision, or key insight per line>
- ...

${codeChanges.length > 0 ? '## Code changes\n(Use the code-change list provided below verbatim — do not regenerate or reformat.)\n\n' : ''}${errors.length > 0 ? '## Errors hit\n(Use the error list provided below verbatim — do not regenerate or reformat.)\n\n' : ''}## Pending work
- <ONLY if the raw turns show an unfinished task list, numbered steps not yet done, or explicitly stated next steps — list them here. Omit this section entirely when there is no clearly pending work.>

Constraints:
- Keep the entire response under ${factBudget} characters.
- Every fact bullet must be self-contained — no references to "turn N" or other bullets.
- Prefer concrete nouns (file paths, function names, error messages) over vague prose.
- Omit the "Code changes" section entirely if the list below is empty.
- Never invent pending work — an empty "Pending work" section must be omitted, not filled.

Raw turns:
${facts.join('\n')}

${standing.length > 0 ? 'Latched standing instructions (verbatim):\n' + standing.map((l) => `- ${l}`).join('\n') + '\n\n' : ''}${codeChanges.length > 0 ? 'Code changes (verbatim):\n' + codeChanges.join('\n') + '\n\n' : ''}${errors.length > 0 ? 'Errors hit (verbatim):\n' + errors.join('\n') + '\n\n' : ''}Structured summary:`;

    try {
      const summarizeMessages: ChatMessage[] = [{ role: 'user', content: prompt }];

      // Role-Based Model Routing . Tag this dispatch
      // as the `summarize` role so `sidecar.modelRouting.rules` can
      // point summarization at a cheap model (typical: Haiku) while
      // leaving the main agent loop on a bigger reasoning-capable one.
      // No-op when no router is attached.
      this.client.routeForDispatch({ role: 'summarize' });

      const summaryPromise = new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Summarization timeout')), timeoutMs);

        this.client
          .complete(summarizeMessages, maxLength)
          .then((result) => {
            clearTimeout(timer);
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

            // Strip any "Structured summary:" / "Summary:" preamble the model
            // may echo before the first header, then truncate to budget.
            const clean = text.trim().replace(/^(Structured summary:?|Compact summary:?|Summary:?)\s*/i, '');

            // If the model ignored the schema (no `## Facts established`
            // header at all), fall back to the deterministic assembly so the
            // caller always gets a well-formed structured summary.
            const hasExpectedHeader = /^##\s+Facts established/m.test(clean);
            resolve(
              hasExpectedHeader
                ? clean.slice(0, maxLength)
                : assembleStructuredSummary(facts, codeChanges, errors, standing).slice(0, maxLength),
            );
          })
          .catch(reject);
      });

      return await summaryPromise;
    } catch {
      // On LLM failure / timeout, return the deterministic structured form
      // clamped to the caller's budget. Worst case: a tail-truncated but
      // still structurally-valid summary.
      return assembleStructuredSummary(facts, codeChanges, errors, standing).slice(0, maxLength);
    }
  }
}
