// ---------------------------------------------------------------------------
// Runtime rate-limit tracking for remote LLM backends.
//
// Every major provider (Anthropic, OpenAI, Kickstand's OpenAI-compatible
// servers) returns rate-limit state in response headers on every request:
// current tokens-per-minute budget, remaining tokens, and when the pool
// resets. We capture those headers into a RateLimitStore, and pre-check
// the estimated cost of the next request before issuing it. That turns
// the cryptic "API cannot be reached after 3 retries" message into a
// specific "waiting 38s, 12K tokens left this minute" surface, and
// prevents burning retries on requests the server is guaranteed to
// reject.
//
// Limits themselves are NEVER hardcoded — the store is empty until the
// first response populates it, and it reports null until it has real
// data. Providers that don't emit headers (Ollama, Kickstand without
// rate-limiting enabled) simply never populate the store and `waitMs`
// always returns 0 for them.
// ---------------------------------------------------------------------------

export interface RateLimitSnapshot {
  /** Tokens per minute ceiling for this key, as reported by the provider. */
  readonly tokensLimit?: number;
  /** Tokens still available in the current window. */
  readonly tokensRemaining?: number;
  /** Seconds until the token bucket refills (absolute time minus now). */
  readonly tokensResetSec?: number;
  /** Requests per minute ceiling. */
  readonly requestsLimit?: number;
  /** Requests still available in the current window. */
  readonly requestsRemaining?: number;
  /** Seconds until the request bucket refills. */
  readonly requestsResetSec?: number;
  /** `Date.now()` when the last update landed. */
  readonly updatedAt: number;
}

export type RateLimitUpdate = Omit<Partial<RateLimitSnapshot>, 'updatedAt'>;

/**
 * Holds the most recent rate-limit state reported by a remote backend.
 * Each backend instance holds its own store so Anthropic and OpenAI
 * don't share a bucket.
 *
 * Thread safety: JavaScript is single-threaded but async interleaving
 * can race. `update()` is synchronous and `waitMs()` reads a snapshot —
 * we accept that a concurrent update between check and wait is fine
 * (the worst case is a slightly-too-long or slightly-too-short wait).
 */
export class RateLimitStore {
  private snapshot: RateLimitSnapshot | null = null;

  /**
   * Merge new header-derived fields into the snapshot. Only fields
   * explicitly set in `update` overwrite — absent keys keep the prior
   * value. Completely empty updates are ignored so we don't stamp
   * `updatedAt` for a no-op.
   */
  update(update: RateLimitUpdate): void {
    const hasAny = Object.values(update).some((v) => v !== undefined);
    if (!hasAny) return;
    const base: RateLimitSnapshot = this.snapshot ?? { updatedAt: 0 };
    this.snapshot = {
      tokensLimit: update.tokensLimit ?? base.tokensLimit,
      tokensRemaining: update.tokensRemaining ?? base.tokensRemaining,
      tokensResetSec: update.tokensResetSec ?? base.tokensResetSec,
      requestsLimit: update.requestsLimit ?? base.requestsLimit,
      requestsRemaining: update.requestsRemaining ?? base.requestsRemaining,
      requestsResetSec: update.requestsResetSec ?? base.requestsResetSec,
      updatedAt: Date.now(),
    };
  }

  /** Current snapshot, or `null` if nothing has been reported yet. */
  getSnapshot(): RateLimitSnapshot | null {
    return this.snapshot;
  }

  /** Forget everything — used on backend swap or when the test harness resets state. */
  reset(): void {
    this.snapshot = null;
  }

  /**
   * Compute how long to wait (in milliseconds) before sending a request
   * that is estimated to consume `estimatedTokens`. Returns 0 when the
   * request is safe to send immediately, either because we have no data
   * yet or because the remaining budget comfortably covers the cost.
   *
   * The wait is sized by the smaller of the two blockers (token bucket
   * or request bucket) so we don't wait longer than necessary when only
   * one is exhausted.
   */
  waitMs(estimatedTokens: number): number {
    const s = this.snapshot;
    if (!s) return 0;

    // Apply elapsed time since the snapshot was captured. The server's
    // reset counter counts down in real time, so an old snapshot with
    // "resets in 30s" captured 20s ago really means "resets in 10s".
    const elapsedSec = Math.floor((Date.now() - s.updatedAt) / 1000);

    let blockingWaitSec = 0;

    if (s.tokensRemaining !== undefined && s.tokensRemaining < estimatedTokens) {
      const reset = (s.tokensResetSec ?? 60) - elapsedSec;
      blockingWaitSec = Math.max(blockingWaitSec, reset);
    }
    if (s.requestsRemaining !== undefined && s.requestsRemaining <= 0) {
      const reset = (s.requestsResetSec ?? 60) - elapsedSec;
      blockingWaitSec = Math.max(blockingWaitSec, reset);
    }

    if (blockingWaitSec <= 0) return 0;
    // Add a small safety margin so we don't land exactly on the edge
    // (servers reset *approximately* on the advertised boundary).
    return (blockingWaitSec + 1) * 1000;
  }

  /**
   * Render a one-line human summary of the current budget state.
   * Returns `null` if nothing has been reported yet.
   *
   * Format is `used/limit` to match the conventional progress-bar
   * reading of `X/Y` — the provider headers report `remaining`, we
   * subtract to get `used`. Previously this displayed `remaining/limit`
   * which read the wrong way (`7,902/200,000 tokens` looks like "only
   * 7.9k consumed" when it actually meant "only 7.9k left").
   *
   * Reset time reflects the *blocking* bucket if one is near
   * exhausted, not the min of both — so users don't see "reset in 1s"
   * while actually waiting 10 minutes for the token bucket to refill.
   */
  describe(): string | null {
    const s = this.snapshot;
    if (!s) return null;
    const parts: string[] = [];

    if (s.tokensRemaining !== undefined && s.tokensLimit !== undefined) {
      const used = Math.max(0, s.tokensLimit - s.tokensRemaining);
      parts.push(`${used.toLocaleString()}/${s.tokensLimit.toLocaleString()} tokens`);
    } else if (s.tokensRemaining !== undefined) {
      parts.push(`${s.tokensRemaining.toLocaleString()} tokens remaining`);
    }

    if (s.requestsRemaining !== undefined && s.requestsLimit !== undefined) {
      const used = Math.max(0, s.requestsLimit - s.requestsRemaining);
      parts.push(`${used}/${s.requestsLimit} requests`);
    }

    // Pick the reset that actually matters. If one bucket is
    // near-exhausted, its reset time is the one the user is waiting
    // on; the other bucket's sooner reset is misleading noise.
    const tokensNearExhausted =
      s.tokensRemaining !== undefined && s.tokensLimit !== undefined && s.tokensRemaining <= s.tokensLimit * 0.05;
    const requestsNearExhausted = s.requestsRemaining !== undefined && s.requestsRemaining <= 1;

    let resetSec: number | undefined;
    if (tokensNearExhausted && s.tokensResetSec !== undefined) {
      resetSec = s.tokensResetSec;
    } else if (requestsNearExhausted && s.requestsResetSec !== undefined) {
      resetSec = s.requestsResetSec;
    } else {
      const candidates = [s.tokensResetSec, s.requestsResetSec].filter((n): n is number => n !== undefined);
      if (candidates.length > 0) resetSec = Math.min(...candidates);
    }
    if (resetSec !== undefined) {
      parts.push(`reset in ${resetSec}s`);
    }

    return parts.length > 0 ? parts.join(' · ') : null;
  }
}

/**
 * Wait for rate-limit budget to clear before sending a request.
 * Honors abort signals so `/abort` / webview reload doesn't leave the
 * promise hanging.
 *
 * If the required wait exceeds `maxWaitMs`, throws a
 * `RateLimitWaitTooLongError` so the caller can surface a specific,
 * user-actionable error instead of silently stalling the chat.
 *
 * Providers that don't emit rate-limit headers (Ollama local) never
 * populate the store, so this returns immediately for them.
 */
export async function maybeWaitForRateLimit(
  store: RateLimitStore,
  estimatedTokens: number,
  maxWaitMs: number,
  signal?: AbortSignal,
): Promise<void> {
  const waitMs = store.waitMs(estimatedTokens);
  if (waitMs <= 0) return;
  if (waitMs > maxWaitMs) {
    const budget = store.describe() ?? 'unknown';
    throw new RateLimitWaitTooLongError(
      `Rate limit: would need to wait ${Math.round(waitMs / 1000)}s before the next request. ` +
        `Current budget: ${budget}. Try again in a moment, or switch to a different backend.`,
      waitMs,
    );
  }
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(resolve, waitMs);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

export class RateLimitWaitTooLongError extends Error {
  constructor(
    message: string,
    public readonly waitMs: number,
  ) {
    super(message);
    this.name = 'RateLimitWaitTooLongError';
  }
}
