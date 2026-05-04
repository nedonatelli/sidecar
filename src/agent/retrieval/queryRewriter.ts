/**
 * Query rewriting for retrieval — improves recall by transforming the user's
 * raw message into a tighter technical search query before embedding.
 *
 * Three modes on top of the free `ruleRewrite` baseline:
 *
 *   'off'    — returns the original query unchanged.
 *   'rule'   — synchronous, zero-cost: strips conversational preamble and
 *              expands camelCase identifiers into their constituent words so
 *              "how do I getEmbeddingIndex" → "get Embedding Index".
 *   'llm'    — one non-streaming LLM call (≤60 tokens) that reformulates the
 *              cleaned query as a concise technical search string. Falls back
 *              to the rule-cleaned query on timeout or error.
 *   'expand' — same LLM call but asks for 2 alternative phrasings in addition
 *              to the rule-cleaned query, enabling multi-query retrieval.
 *              The caller runs one retrieval pass per variant and re-fuses
 *              with RRF so each angle of the query can surface different hits.
 *
 * `CompleteFn` is a plain function type (not tied to SideCarClient) so callers
 * can adapt any backend's complete() without this module knowing about it.
 * Tests inject a simple async stub.
 */

export type QueryRewriteMode = 'off' | 'rule' | 'llm' | 'expand';

/**
 * Thin callable used for LLM-based rewrites. Matches the signature of
 * `SideCarClient.completeWithOverrides` so callers can pass it directly.
 */
export type CompleteFn = (
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  overrideModel: string | undefined,
  maxTokens: number,
  signal?: AbortSignal,
) => Promise<string>;

const REWRITE_SYSTEM = `You are a search query optimizer for a code assistant. \
Rewrite user questions as short technical search queries that maximise retrieval recall. \
Keep all identifiers, function names, file paths, and error messages intact. \
Remove conversational language. Output only the search query, no explanation.`;

const EXPAND_SYSTEM = `You are a search query optimizer for a code assistant. \
Write 2 alternative search queries for retrieving code relevant to the request below. \
Each should emphasise a different aspect (e.g. implementation details vs. related APIs or concepts). \
Output exactly 2 lines — one query per line — with no numbering, bullets, or explanation.`;

/** Timeout for LLM-based rewrites. Applies per call. */
const DEFAULT_TIMEOUT_MS = 3_000;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Rewrite `query` for retrieval according to `mode`.
 *
 * Always returns a non-empty array. 'expand' returns up to 3 items (the
 * rule-cleaned query + 2 LLM variants); all other modes return exactly 1.
 * Falls back silently to rule output when the LLM is unavailable or times out.
 */
export async function rewriteQuery(
  query: string,
  mode: QueryRewriteMode,
  complete?: CompleteFn,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string[]> {
  if (!query.trim()) return [query];

  const cleaned = mode === 'off' ? query.trim() : ruleRewrite(query);

  if (mode === 'off' || mode === 'rule' || !complete) return [cleaned];

  if (mode === 'llm') {
    const rewritten = await llmSingleRewrite(cleaned, complete, signal, timeoutMs);
    return [rewritten ?? cleaned];
  }

  if (mode === 'expand') {
    const variants = await llmExpand(cleaned, complete, signal, timeoutMs);
    return variants.length > 0 ? [cleaned, ...variants] : [cleaned];
  }

  return [cleaned];
}

/**
 * Rule-based rewrite: synchronous, zero-cost.
 *
 * 1. Strips leading conversational preambles iteratively until stable.
 * 2. Expands camelCase tokens into space-separated words so the embedding
 *    model can match partial terms (e.g. "streamChat" → "stream Chat").
 *    ALL_CAPS acronyms (URL, HTTP) and tokens containing special chars
 *    (@, /, .) are left intact.
 */
export function ruleRewrite(query: string): string {
  let q = query.trim();

  // Strip leading preambles, applied repeatedly until no more match.
  let prev = '';
  while (prev !== q) {
    prev = q;
    for (const re of PREAMBLES) {
      q = q.replace(re, '').trimStart();
    }
  }

  // Expand camelCase — only for pure alphabetic tokens (≥3 chars).
  q = q.replace(/\b([A-Za-z]{3,})\b/g, (word) => {
    if (word === word.toUpperCase()) return word; // ALL_CAPS: leave alone
    if (!/[a-z][A-Z]/.test(word)) return word; // already lowercase or single-case
    return word.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
  });

  return q.trim();
}

// ── Internal LLM helpers ──────────────────────────────────────────────────────

async function llmSingleRewrite(
  query: string,
  complete: CompleteFn,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string | null> {
  const messages = [{ role: 'user' as const, content: `Query: ${query}\nSearch query:` }];
  const raw = await callWithTimeout(complete, REWRITE_SYSTEM, messages, 60, signal, timeoutMs);
  if (!raw) return null;
  // Take only the first line and trim punctuation at the end.
  const line = raw
    .split('\n')[0]
    .trim()
    .replace(/[.!?]+$/, '');
  return line.length > 5 ? line : null;
}

async function llmExpand(
  query: string,
  complete: CompleteFn,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string[]> {
  const messages = [{ role: 'user' as const, content: `Request: ${query}` }];
  const raw = await callWithTimeout(complete, EXPAND_SYSTEM, messages, 80, signal, timeoutMs);
  if (!raw) return [];
  return raw
    .split('\n')
    .map((l) =>
      l
        .trim()
        .replace(/^[-*\d.)\s]+/, '')
        .trim(),
    ) // strip bullets/numbers
    .filter((l) => l.length > 5)
    .slice(0, 2);
}

/**
 * Call `complete` with an AbortController-based timeout. Returns null on
 * timeout, abort, or any error — all treated as a transparent fallback.
 */
async function callWithTimeout(
  complete: CompleteFn,
  systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  maxTokens: number,
  callerSignal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<string | null> {
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const cleanup = () => {
    clearTimeout(timer);
    timer = undefined;
  };

  // Forward caller abort into our controller.
  callerSignal?.addEventListener('abort', () => ac.abort(), { once: true });
  timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const result = await complete(systemPrompt, messages, undefined, maxTokens, ac.signal);
    return result;
  } catch {
    return null;
  } finally {
    cleanup();
  }
}

// ── Preamble patterns ─────────────────────────────────────────────────────────

// Applied case-insensitively at the start of the query. Ordered from longer to
// shorter so greedy patterns win (e.g. "can you help me with" before "can you").
// Verbs like "explain", "show me", "write" are intentionally absent: they can
// be legitimate technical queries on their own and would be over-stripped.
const PREAMBLES = [
  /^can\s+you\s+help\s+me\s+(with\s+)?/i,
  /^can\s+you\s+(please\s+)?/i,
  /^could\s+you\s+(please\s+)?/i,
  /^would\s+you\s+(please\s+)?/i,
  /^please\s+help\s+me\s+(with\s+)?/i,
  /^please\s+/i,
  /^help\s+me\s+(with\s+)?/i,
  // Contractions: "I'm"/"I'd" have no space before the apostrophe.
  /^i['']m\s+trying\s+to\s+/i,
  /^i\s+am\s+trying\s+to\s+/i,
  /^i['']d\s+like\s+to\s+/i,
  /^i\s+would\s+like\s+to\s+/i,
  /^i\s+want\s+to\s+/i,
  /^i\s+need\s+to\s+/i,
  /^i['']m\s+having\s+trouble\s+(with\s+)?/i,
  /^i\s+am\s+having\s+trouble\s+(with\s+)?/i,
  /^how\s+do\s+i\s+/i,
  /^how\s+can\s+i\s+/i,
  /^how\s+should\s+i\s+/i,
  /^how\s+would\s+i\s+/i,
  /^how\s+does\s+/i,
  /^how\s+to\s+/i,
  /^what\s+is\s+(a\s+|the\s+)?/i,
  /^what\s+are\s+(the\s+)?/i,
  /^what\s+does\s+/i,
  /^what\s+should\s+/i,
];
