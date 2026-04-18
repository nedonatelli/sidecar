// ---------------------------------------------------------------------------
// sidecarFetch — unified outbound HTTP helper for every backend.
//
// Before v0.64, each backend hand-wired the same four-step dance around
// `fetch`:
//
//     await maybeWaitForRateLimit(store, estTokens, MAX_WAIT, signal);
//     const res = await fetchWithRetry(url, init);
//     store.update(parseXRateLimitHeaders(res.headers));
//     if (!res.ok) throw ...
//
// `sidecarFetch` collapses that into a single call and adds two new
// capabilities shared by everyone:
//
//   1. **Outbound allowlist enforcement** — when a caller passes a
//      non-empty `allowlist`, the URL's hostname is matched against it
//      *before* the network is touched. Empty / omitted = allow all
//      (preserves current behavior for backends whose hosts aren't in
//      the user's curated list). The allowlist pattern semantics match
//      `matchAllowlistHost()` so tool-path fetches and backend-path
//      fetches can share the same user config.
//
//   2. **Consistent composition order** — allowlist → rate-limit
//      pre-flight → retry/fetch → rate-limit post-flight. Doing the
//      allowlist check first means a denied URL never contributes to
//      the token budget wait, and doing the rate-limit update last
//      captures headers even when the caller handles a non-OK status
//      upstream.
//
// Circuit breaking intentionally stays at `SideCarClient`-level — it
// is a cross-request concern per provider (carries state across many
// sidecarFetch calls) and rolling it into the per-fetch helper would
// lose that scope.
// ---------------------------------------------------------------------------

import { fetchWithRetry, type RetryOptions } from './retry.js';
import { maybeWaitForRateLimit, RateLimitStore, type RateLimitUpdate } from './rateLimitState.js';
import { matchAllowlistHost } from '../config/workspace.js';

export const DEFAULT_MAX_RATE_LIMIT_WAIT_MS = 60_000;

export interface SidecarFetchOptions {
  /** Retry configuration. Defaults documented in retry.ts. */
  retry?: RetryOptions;

  /**
   * RateLimitStore to pre-check against and update from response headers.
   * Omit for backends that don't emit rate-limit headers (local Ollama).
   */
  rateLimits?: RateLimitStore;

  /**
   * Estimated tokens the request will consume. Used to decide whether
   * the current budget can service the request; required when
   * `rateLimits` is set, ignored otherwise.
   */
  estimatedTokens?: number;

  /** Cap on how long the pre-flight will wait. Default 60s. */
  maxRateLimitWaitMs?: number;

  /**
   * Parser that converts a response's headers into a RateLimitUpdate.
   * When set alongside `rateLimits`, the store is updated after every
   * response regardless of status code.
   */
  parseRateLimitHeaders?: (headers: Headers) => RateLimitUpdate;

  /**
   * Outbound-host allowlist. Empty / undefined → no host restriction
   * (matches current backend behavior pre-v0.64). When non-empty, the
   * URL's hostname must match at least one pattern or the call throws
   * `OutboundAllowlistError` before any network activity.
   *
   * Pattern syntax matches `config/workspace.matchAllowlistHost`:
   * exact hostnames (`api.openai.com`) or `*.`-prefixed subdomain globs
   * (`*.openrouter.ai`).
   */
  allowlist?: readonly string[];

  /** Short label for errors/telemetry — typically the provider key. */
  label?: string;
}

/**
 * Thrown when the target URL's hostname does not appear in a non-empty
 * `allowlist`. Callers should surface this as a user-actionable error
 * ("this host is not in your sidecar.outboundAllowlist") rather than a
 * generic network failure.
 */
export class OutboundAllowlistError extends Error {
  readonly host: string;
  readonly label: string | undefined;

  constructor(url: string, label?: string) {
    let host = url;
    try {
      host = new URL(url).hostname || url;
    } catch {
      // keep raw string — URL parsing failed
    }
    const prefix = label ? `[${label}] ` : '';
    super(`${prefix}Outbound host ${host} blocked by allowlist.`);
    this.name = 'OutboundAllowlistError';
    this.host = host;
    this.label = label;
  }
}

/**
 * One call that replaces the {rate-limit wait → fetchWithRetry →
 * rate-limit update} pattern every remote backend was open-coding. See
 * the file header for the motivation; callers should prefer this over
 * `fetchWithRetry` + manual `maybeWaitForRateLimit` once migrated.
 */
export async function sidecarFetch(
  url: string,
  init: RequestInit = {},
  options: SidecarFetchOptions = {},
): Promise<Response> {
  // 1. Allowlist — check before any network or rate-limit wait, so a
  //    denied host doesn't eat budget or burn a retry slot.
  if (options.allowlist && options.allowlist.length > 0) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      throw new OutboundAllowlistError(url, options.label);
    }
    if (!matchAllowlistHost(host, options.allowlist)) {
      throw new OutboundAllowlistError(url, options.label);
    }
  }

  // 2. Rate-limit pre-flight.
  if (options.rateLimits && options.estimatedTokens !== undefined) {
    await maybeWaitForRateLimit(
      options.rateLimits,
      options.estimatedTokens,
      options.maxRateLimitWaitMs ?? DEFAULT_MAX_RATE_LIMIT_WAIT_MS,
      init.signal as AbortSignal | undefined,
    );
  }

  // 3. fetch + retry — returns the final response whether OK or not;
  //    caller decides how to surface non-OK statuses.
  const response = await fetchWithRetry(url, init, options.retry);

  // 4. Rate-limit post-flight — parse response headers into the store
  //    so the next pre-flight has fresh budget data.
  if (options.rateLimits && options.parseRateLimitHeaders) {
    options.rateLimits.update(options.parseRateLimitHeaders(response.headers));
  }

  return response;
}
