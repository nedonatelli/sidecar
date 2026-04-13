import type { RateLimitUpdate } from './rateLimitState.js';

// ---------------------------------------------------------------------------
// Response-header parsers for remote LLM providers' rate-limit state.
//
// These are pure decoders — they never invent limits, never hardcode
// ceilings, and return `{}` when headers are absent so callers can
// tell "no data" from "zero budget". Two providers, two formats:
//
//   Anthropic ships ISO-8601 timestamps for the reset field:
//     anthropic-ratelimit-tokens-limit:     "50000"
//     anthropic-ratelimit-tokens-remaining: "49850"
//     anthropic-ratelimit-tokens-reset:     "2026-04-13T12:34:56Z"
//
//   OpenAI ships duration strings like "1s" / "30s" / "1h30m15s" /
//   "500ms":
//     x-ratelimit-limit-tokens:     "30000"
//     x-ratelimit-remaining-tokens: "29850"
//     x-ratelimit-reset-tokens:     "1m30s"
//
// Anthropic docs: https://docs.anthropic.com/en/api/rate-limits#response-headers
// OpenAI docs:    https://platform.openai.com/docs/guides/rate-limits
// ---------------------------------------------------------------------------

/**
 * Parse an integer header value. Returns undefined when the headers
 * object is null, the header is missing, empty, or not a number — the
 * store will ignore undefined fields rather than clearing existing
 * data. Accepts a nullable `Headers` so mock `Response` objects
 * without headers (common in tests) report "no data" instead of
 * throwing.
 */
function intHeader(headers: Headers | null | undefined, name: string): number | undefined {
  const raw = headers?.get(name);
  if (!raw) return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Parse Anthropic's ISO-8601 reset timestamp into seconds-until-reset
 * (relative to now). Returns undefined if the header is missing or
 * unparseable. Negative results are clamped to 0 so stale headers
 * don't produce a negative "wait".
 */
function anthropicResetHeader(headers: Headers | null | undefined, name: string): number | undefined {
  const raw = headers?.get(name);
  if (!raw) return undefined;
  const d = new Date(raw);
  const t = d.getTime();
  if (Number.isNaN(t)) return undefined;
  return Math.max(0, Math.round((t - Date.now()) / 1000));
}

/**
 * Parse OpenAI's rate-limit duration format into seconds.
 *
 *   "30s"       → 30
 *   "1m30s"     → 90
 *   "1h30m15s"  → 5415
 *   "500ms"     → 1   (rounded up; we don't track sub-second resolution)
 *
 * Returns undefined if the string has no recognisable segments.
 *
 * Exported for the test suite — otherwise this would be file-local.
 */
export function parseOpenAIDuration(raw: string): number | undefined {
  // IMPORTANT: match `ms` before `s` — `500ms` must parse as milliseconds,
  // not as "500m + s" (which the `m` arm would misinterpret).
  const re = /(\d+)(ms|h|m|s)/g;
  let total = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(raw)) !== null) {
    matched = true;
    const n = parseInt(match[1], 10);
    switch (match[2]) {
      case 'h':
        total += n * 3600;
        break;
      case 'm':
        total += n * 60;
        break;
      case 's':
        total += n;
        break;
      case 'ms':
        total += n / 1000;
        break;
    }
  }
  if (!matched) return undefined;
  return Math.max(1, Math.round(total));
}

function openaiResetHeader(headers: Headers | null | undefined, name: string): number | undefined {
  const raw = headers?.get(name);
  if (!raw) return undefined;
  return parseOpenAIDuration(raw);
}

/** Decode Anthropic rate-limit headers into a store update. */
export function parseAnthropicRateLimitHeaders(headers: Headers | null | undefined): RateLimitUpdate {
  return {
    tokensLimit: intHeader(headers, 'anthropic-ratelimit-tokens-limit'),
    tokensRemaining: intHeader(headers, 'anthropic-ratelimit-tokens-remaining'),
    tokensResetSec: anthropicResetHeader(headers, 'anthropic-ratelimit-tokens-reset'),
    requestsLimit: intHeader(headers, 'anthropic-ratelimit-requests-limit'),
    requestsRemaining: intHeader(headers, 'anthropic-ratelimit-requests-remaining'),
    requestsResetSec: anthropicResetHeader(headers, 'anthropic-ratelimit-requests-reset'),
  };
}

/** Decode OpenAI (and OpenAI-compatible) rate-limit headers into a store update. */
export function parseOpenAIRateLimitHeaders(headers: Headers | null | undefined): RateLimitUpdate {
  return {
    tokensLimit: intHeader(headers, 'x-ratelimit-limit-tokens'),
    tokensRemaining: intHeader(headers, 'x-ratelimit-remaining-tokens'),
    tokensResetSec: openaiResetHeader(headers, 'x-ratelimit-reset-tokens'),
    requestsLimit: intHeader(headers, 'x-ratelimit-limit-requests'),
    requestsRemaining: intHeader(headers, 'x-ratelimit-remaining-requests'),
    requestsResetSec: openaiResetHeader(headers, 'x-ratelimit-reset-requests'),
  };
}
