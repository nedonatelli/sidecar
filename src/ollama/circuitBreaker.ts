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

export type ProviderType =
  | 'ollama'
  | 'anthropic'
  | 'openai'
  | 'kickstand'
  | 'openrouter'
  | 'groq'
  | 'fireworks'
  | 'gemini'
  | 'copilot'
  | 'bedrock';

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** How many consecutive failures trip the breaker. Default: 5. */
  failureThreshold?: number;
  /**
   * Initial cooldown after the first trip (ms). Subsequent trips double this
   * up to `maxCooldownMs`. Default: 15_000.
   */
  cooldownMs?: number;
  /** Ceiling for exponential backoff. Default: 120_000 ms. */
  maxCooldownMs?: number;
}

const DEFAULT_FAILURE_THRESHOLD = 5;
const DEFAULT_COOLDOWN_MS = 15_000;
const DEFAULT_MAX_COOLDOWN_MS = 120_000;

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
  /** Number of times the breaker has tripped open (resets on full success). Used for backoff tier. */
  openCount: number;
}

export class CircuitBreaker {
  private entries = new Map<ProviderType, BreakerEntry>();
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly maxCooldownMs: number;

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.maxCooldownMs = options.maxCooldownMs ?? DEFAULT_MAX_COOLDOWN_MS;
  }

  /** Cooldown for the current trip tier: doubles each open, capped at maxCooldownMs. */
  private tierCooldown(openCount: number): number {
    return Math.min(this.maxCooldownMs, this.cooldownMs * Math.pow(2, Math.max(0, openCount - 1)));
  }

  private get(provider: ProviderType): BreakerEntry {
    let entry = this.entries.get(provider);
    if (!entry) {
      entry = { state: 'closed', consecutiveFailures: 0, openedAt: 0, probeInFlight: false, openCount: 0 };
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
      if (Date.now() - entry.openedAt >= this.tierCooldown(entry.openCount)) {
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
    throw new BackendCircuitOpenError(provider, Math.max(0, this.tierCooldown(entry.openCount) - elapsed));
  }

  recordSuccess(provider: ProviderType): void {
    const entry = this.get(provider);
    entry.consecutiveFailures = 0;
    entry.openCount = 0;
    entry.state = 'closed';
    entry.openedAt = 0;
    entry.probeInFlight = false;
  }

  recordFailure(provider: ProviderType): void {
    const entry = this.get(provider);
    if (entry.state === 'half-open') {
      // Probe failed — flip straight back to open, advancing the backoff tier.
      entry.openCount++;
      entry.state = 'open';
      entry.openedAt = Date.now();
      entry.probeInFlight = false;
      return;
    }
    entry.consecutiveFailures++;
    if (entry.consecutiveFailures >= this.failureThreshold) {
      entry.openCount++;
      entry.state = 'open';
      entry.openedAt = Date.now();
      entry.probeInFlight = false;
    }
  }

  /** Read-only view of a provider's current state, for telemetry / UI. */
  describe(provider: ProviderType): { state: CircuitState; consecutiveFailures: number; cooldownRemainingMs: number } {
    const entry = this.get(provider);
    const remaining =
      entry.state === 'open' ? Math.max(0, this.tierCooldown(entry.openCount) - (Date.now() - entry.openedAt)) : 0;
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

/**
 * Thrown when a request fails due to a permanent configuration error
 * (wrong API key, connection refused, DNS failure) rather than a
 * transient backend outage. These errors should NOT trip the circuit
 * breaker — the user needs to fix their settings, not wait for a cooldown.
 */
export class BackendConfigError extends Error {
  readonly provider: ProviderType;

  constructor(provider: ProviderType, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`[SideCar] ${provider} configuration error: ${msg}. Check your API key and backend URL in Settings.`);
    this.name = 'BackendConfigError';
    this.provider = provider;
  }
}

/**
 * Returns true for errors that indicate a permanent configuration
 * problem — wrong API key, backend not running, bad hostname — where
 * tripping the circuit breaker would be counterproductive. The caller
 * should throw a `BackendConfigError` instead of calling `recordFailure`.
 */
export function isPermanentError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key')) return true;
  if (msg.includes('403') || msg.includes('forbidden')) return true;
  if (msg.includes('econnrefused') || msg.includes('connection refused')) return true;
  if (msg.includes('enotfound') || msg.includes('getaddrinfo')) return true;
  const status = (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode;
  if (status === 401 || status === 403) return true;
  return false;
}
