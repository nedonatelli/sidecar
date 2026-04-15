/**
 * Per-provider circuit breaker for LLM backends.
 *
 * The goal is to fast-fail when a backend is demonstrably down instead of
 * letting the user discover it by typing into a dead textbox. The existing
 * fallback machinery in SideCarClient already switches to a secondary
 * backend after a few failures, but it only triggers when the user
 * actually sends a request — and if no fallback is configured, it does
 * nothing at all. This breaker complements that by holding an "open"
 * state across calls so subsequent requests throw immediately with a
 * clear error instead of hammering a dead provider.
 *
 * State machine:
 *
 *     closed  ─ N consecutive failures ─▶  open
 *     open    ─ cooldown elapsed        ─▶  half-open
 *     half-open ─ probe succeeds        ─▶  closed
 *     half-open ─ probe fails           ─▶  open (new cooldown)
 *
 * A single probe is allowed through during `half-open`; the breaker
 * flips back to `open` immediately if the probe fails, so a flaky
 * provider doesn't get to burn extra user requests.
 */

export type ProviderType = 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** How many consecutive failures trip the breaker. Default: 5. */
  failureThreshold?: number;
  /** How long the breaker stays open before transitioning to half-open. Default: 60_000 ms. */
  cooldownMs?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 60_000;

/**
 * Thrown by `guard()` when the breaker is open and no probe is allowed
 * yet. Callers should surface this to the user rather than treating it
 * as a backend error — the backend was never contacted.
 */
export class BackendCircuitOpenError extends Error {
  readonly provider: ProviderType;
  readonly cooldownRemainingMs: number;

  constructor(provider: ProviderType, cooldownRemainingMs: number) {
    super(
      `[SideCar] ${provider} backend is temporarily disabled after repeated failures. ` +
        `Retrying in ${Math.ceil(cooldownRemainingMs / 1000)}s.`,
    );
    this.name = 'BackendCircuitOpenError';
    this.provider = provider;
    this.cooldownRemainingMs = cooldownRemainingMs;
  }
}

interface BreakerEntry {
  state: CircuitState;
  consecutiveFailures: number;
  openedAt: number;
  probeInFlight: boolean;
}

export class CircuitBreaker {
  private entries = new Map<ProviderType, BreakerEntry>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  }

  private get(provider: ProviderType): BreakerEntry {
    let entry = this.entries.get(provider);
    if (!entry) {
      entry = { state: 'closed', consecutiveFailures: 0, openedAt: 0, probeInFlight: false };
      this.entries.set(provider, entry);
    }
    return entry;
  }

  /**
   * Returns true if the provider is currently accepting requests. Also
   * advances an `open` breaker to `half-open` if the cooldown has
   * elapsed. Side-effectful — meant to be called right before
   * dispatching a request and paired with `recordSuccess` / `recordFailure`.
   */
  allow(provider: ProviderType): boolean {
    const entry = this.get(provider);
    if (entry.state === 'closed') return true;
    if (entry.state === 'open') {
      if (Date.now() - entry.openedAt >= this.cooldownMs) {
        entry.state = 'half-open';
        entry.probeInFlight = false;
      } else {
        return false;
      }
    }
    // half-open: allow exactly one in-flight probe
    if (entry.probeInFlight) return false;
    entry.probeInFlight = true;
    return true;
  }

  /**
   * Guard variant that throws `BackendCircuitOpenError` when `allow()`
   * would return false. Use from request paths that expect to throw
   * rather than branch on a boolean.
   */
  guard(provider: ProviderType): void {
    if (this.allow(provider)) return;
    const entry = this.get(provider);
    const elapsed = Date.now() - entry.openedAt;
    throw new BackendCircuitOpenError(provider, Math.max(0, this.cooldownMs - elapsed));
  }

  recordSuccess(provider: ProviderType): void {
    const entry = this.get(provider);
    entry.consecutiveFailures = 0;
    entry.state = 'closed';
    entry.openedAt = 0;
    entry.probeInFlight = false;
  }

  recordFailure(provider: ProviderType): void {
    const entry = this.get(provider);
    if (entry.state === 'half-open') {
      // Probe failed — flip straight back to open with a fresh cooldown.
      entry.state = 'open';
      entry.openedAt = Date.now();
      entry.probeInFlight = false;
      return;
    }
    entry.consecutiveFailures++;
    if (entry.consecutiveFailures >= this.failureThreshold) {
      entry.state = 'open';
      entry.openedAt = Date.now();
      entry.probeInFlight = false;
    }
  }

  /** Read-only view of a provider's current state, for telemetry / UI. */
  describe(provider: ProviderType): { state: CircuitState; consecutiveFailures: number; cooldownRemainingMs: number } {
    const entry = this.get(provider);
    const remaining = entry.state === 'open' ? Math.max(0, this.cooldownMs - (Date.now() - entry.openedAt)) : 0;
    return {
      state: entry.state,
      consecutiveFailures: entry.consecutiveFailures,
      cooldownRemainingMs: remaining,
    };
  }

  /** Test / dev helper — clear all breaker state. */
  reset(): void {
    this.entries.clear();
  }
}

/** Process-wide singleton used by SideCarClient. */
export const circuitBreaker = new CircuitBreaker();
