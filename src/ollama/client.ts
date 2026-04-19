import type { ChatMessage, ToolDefinition, StreamEvent } from './types.js';
import type { ApiBackend } from './backend.js';
import { AnthropicBackend } from './anthropicBackend.js';
import { OllamaBackend } from './ollamaBackend.js';
import { OpenAIBackend } from './openaiBackend.js';
import { KickstandBackend, kickstandHeaders } from './kickstandBackend.js';
import { OpenRouterBackend } from './openrouterBackend.js';
import { GroqBackend } from './groqBackend.js';
import { FireworksBackend } from './fireworksBackend.js';
import { isLocalOllama, detectProvider, getConfig } from '../config/settings.js';
import { MODEL_CONTEXT_LENGTHS } from '../config/constants.js';
import { RateLimitStore } from './rateLimitState.js';
import { spendTracker } from './spendTracker.js';
import { circuitBreaker } from './circuitBreaker.js';
import { ModelRouter, type RouteSignals, type RouteDecision } from './modelRouter.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

const LIBRARY_MODELS = [
  'llama3',
  'llama3.1',
  'llama3.2',
  'mistral',
  'mixtral',
  'codellama',
  'phi3',
  'qwen2',
  'qwen2.5',
  'qwen3-coder',
  'deepseek-coder',
  'nomic-embed-text',
  'llava',
  'gemma',
  'gemma2',
  'phi',
];

// Fallback Claude model catalog for when /v1/models is unreachable or
// returns an empty list (older keys, proxies that don't expose it).
// Keep this roughly aligned with Anthropic's published current models.
const ANTHROPIC_FALLBACK_MODELS = [
  'claude-opus-4-5',
  'claude-opus-4-1',
  'claude-opus-4',
  'claude-sonnet-4-5',
  'claude-sonnet-4',
  'claude-haiku-4-5',
  'claude-3-7-sonnet-latest',
  'claude-3-5-sonnet-latest',
  'claude-3-5-haiku-latest',
  'claude-3-opus-latest',
];

export interface InstalledModel {
  name: string;
  model: string;
  size?: number;
  digest?: string;
  /**
   * Model context window in tokens, when the backend exposes it. Kickstand
   * reports the loaded `n_ctx` for loaded models and the native GGUF
   * `<arch>.context_length` for unloaded models; Ollama and others leave
   * this undefined (chat-path sizing goes through `getModelContextLength()`).
   */
  contextLength?: number | null;
}

export interface LibraryModel {
  name: string;
  installed: boolean;
  installing?: boolean;
  /** Optional context window (tokens) to surface in the picker. See InstalledModel.contextLength. */
  contextLength?: number | null;
}

export interface PullProgress {
  model: string;
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

/** One entry per LLM call — records which model handled which role in the session. */
export interface ModelUsageEntry {
  model: string;
  /** 'chat' for streaming turns, 'complete' for one-shot completions (commit msg, review, etc.) */
  role: 'chat' | 'complete';
  timestamp: Date;
}

export class SideCarClient {
  private model: string;
  private systemPrompt: string;
  private baseUrl: string;
  private apiKey: string;
  private backend: ApiBackend;

  /**
   * Optional Role-Based Model Router (v0.64). Owning the router at the
   * client layer means every dispatch site can consult it via
   * `routeForDispatch()` without plumbing a separate service through
   * chat handlers / completion provider / critic / summarizer. When
   * `null`, the client falls back to its static `model` field for every
   * call (legacy behavior).
   */
  private router: ModelRouter | null = null;
  /**
   * Last decision returned by `routeForDispatch`, held so the in-stream
   * spend hook can forward the cost of each usage event to
   * `router.recordSpend(matched, usd)` — closing the budget-tracking
   * loop without plumbing the decision through every dispatch site.
   */
  private lastDecision: RouteDecision | null = null;
  /**
   * One-turn model pin set by `@opus` / `@sonnet` / `@haiku` / `@local`
   * inline sentinels (v0.64 phase 4d.1). When non-null, every
   * `routeForDispatch` short-circuits and returns `null` so callers
   * fall back to `this.model` — which `setTurnOverride` has already
   * pinned to the sentinel's target. The chat handler clears this at
   * the end of the turn so the next user message resumes routing.
   */
  private turnOverride: string | null = null;
  /**
   * Model value captured just before a sentinel pin was applied, so
   * `setTurnOverride(null)` can restore it cleanly. Without this the
   * override would leak into non-chat dispatch paths (FIM completions
   * triggered by typing in unrelated files, background agents) that
   * don't go through `handleUserMessage`'s top-of-turn `updateModel`
   * reset.
   */
  private preOverrideModel: string | null = null;

  /**
   * Running log of every model used in this client's lifetime, bounded
   * at `MAX_MODEL_USAGE_LOG_ENTRIES`. Audit #8 (v0.65): the array
   * previously grew without bound in long-running sessions. The cap
   * protects memory via drop-oldest (ring-buffer semantics); the only
   * observable effect is that `buildModelTrailers()` may miss a model
   * that was used exactly once more than `MAX_MODEL_USAGE_LOG_ENTRIES`
   * entries ago — an acceptable cost for bounded memory, and the model
   * trailer aggregation still deduplicates, so any currently-active
   * model keeps appearing.
   */
  private _modelUsageLog: ModelUsageEntry[] = [];
  /** Public so tests can reference the same constant instead of hardcoding. */
  static readonly MAX_MODEL_USAGE_LOG_ENTRIES = 1000;

  // Rate-limit state — one store per provider, so switching profiles
  // mid-session preserves each provider's accumulated budget info AND
  // keeps them isolated. A shared store would merge fields across
  // providers (update() keeps old values when new ones are absent),
  // leaking one provider's remaining-token counts into another's view.
  private rateLimitsByProvider = new Map<
    'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks',
    RateLimitStore
  >();

  // Fallback state
  private consecutiveFailures = 0;
  private usingFallback = false;
  private primaryBaseUrl: string;
  private primaryApiKey: string;
  private primaryModel: string;
  private static readonly FALLBACK_THRESHOLD = 2;

  constructor(model: string, baseUrl?: string, apiKey?: string) {
    this.model = model;
    this.systemPrompt = '';
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
    this.apiKey = apiKey || 'ollama';
    this.primaryBaseUrl = this.baseUrl;
    this.primaryApiKey = this.apiKey;
    this.primaryModel = this.model;
    this.backend = this.createBackend();
  }

  private createBackend(): ApiBackend {
    const provider = detectProvider(this.baseUrl, getConfig().provider);
    switch (provider) {
      case 'ollama':
        return new OllamaBackend(this.baseUrl);
      case 'anthropic':
        return new AnthropicBackend(this.baseUrl, this.apiKey, this.rateLimitsFor('anthropic'));
      case 'kickstand':
        return new KickstandBackend(this.baseUrl, this.rateLimitsFor('kickstand'), getConfig().kickstandNCtx);
      case 'openrouter':
        return new OpenRouterBackend(this.baseUrl, this.apiKey, this.rateLimitsFor('openrouter'));
      case 'groq':
        return new GroqBackend(this.baseUrl, this.apiKey, this.rateLimitsFor('groq'));
      case 'fireworks':
        return new FireworksBackend(this.baseUrl, this.apiKey, this.rateLimitsFor('fireworks'));
      case 'openai':
        return new OpenAIBackend(this.baseUrl, this.apiKey, this.rateLimitsFor('openai'));
    }
  }

  private rateLimitsFor(
    provider: 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks',
  ): RateLimitStore {
    let store = this.rateLimitsByProvider.get(provider);
    if (!store) {
      store = new RateLimitStore();
      this.rateLimitsByProvider.set(provider, store);
    }
    return store;
  }

  /** Access the rate-limit store for the currently active provider. */
  getRateLimits(): RateLimitStore {
    return this.rateLimitsFor(detectProvider(this.baseUrl, getConfig().provider));
  }

  private get tagsUrl(): string {
    return `${this.baseUrl}/api/tags`;
  }

  private get pullUrl(): string {
    return `${this.baseUrl}/api/pull`;
  }

  private get generateUrl(): string {
    return `${this.baseUrl}/api/generate`;
  }

  async *streamChat(
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    this.pushModelUsageLog({ model: this.model, role: 'chat', timestamp: new Date() });
    // Fast-fail when the breaker is open so the user sees a clear error
    // instead of the request hanging on a dead provider. Advances an
    // open breaker to half-open once the cooldown has elapsed.
    circuitBreaker.guard(this.getProviderType());
    try {
      for await (const event of this.backend.streamChat(this.model, this.systemPrompt, messages, signal, tools)) {
        if (event.type === 'usage') this.chargeLastDecision(spendTracker.record(event.model, event.usage));
        yield event;
      }
      this.recordSuccess();
      circuitBreaker.recordSuccess(this.getProviderType());
    } catch (err) {
      // Don't count user aborts as failures
      if (err instanceof Error && err.name === 'AbortError') throw err;

      // v0.63.1 — native backend-capability retry. Gives the active
      // backend a chance to retry the request against a native
      // protocol (canonically Ollama's /api/chat when the OAI-compat
      // /v1/chat/completions layer glitched) BEFORE we tear down the
      // provider via circuit breaker + fallback profile. Only fires
      // when the backend advertises oaiCompatFallback AND its
      // matches() says the error is retry-eligible. On retry success,
      // the provider's circuit stays healthy — this isn't a provider
      // outage, just a protocol-level blip.
      const nativeRetry = this.backend.nativeCapabilities?.()?.oaiCompatFallback;
      if (nativeRetry && nativeRetry.matches(err)) {
        try {
          yield { type: 'warning', message: 'Retrying against native protocol…' };
          for await (const event of nativeRetry.fallbackStreamChat(
            this.model,
            this.systemPrompt,
            messages,
            signal,
            tools,
          )) {
            if (event.type === 'usage') this.chargeLastDecision(spendTracker.record(event.model, event.usage));
            yield event;
          }
          this.recordSuccess();
          circuitBreaker.recordSuccess(this.getProviderType());
          return;
        } catch (retryErr) {
          if (retryErr instanceof Error && retryErr.name === 'AbortError') throw retryErr;
          // Fall through to provider-fallback logic with the ORIGINAL
          // error so the circuit breaker sees the failure that
          // actually warrants switching providers. Log the retry
          // failure so users can diagnose.
          console.warn(
            `[SideCar] Native fallback also failed: ${(retryErr as Error).message}. Falling through to provider fallback.`,
          );
        }
      }

      circuitBreaker.recordFailure(this.getProviderType());
      if (this.switchToFallback()) {
        console.warn(`[SideCar] Primary backend failed, switching to fallback: ${(err as Error).message}`);
        yield { type: 'warning', message: 'Primary backend unavailable — using fallback.' };
        circuitBreaker.guard(this.getProviderType());
        for await (const event of this.backend.streamChat(this.model, this.systemPrompt, messages, signal, tools)) {
          if (event.type === 'usage') this.chargeLastDecision(spendTracker.record(event.model, event.usage));
          yield event;
        }
        circuitBreaker.recordSuccess(this.getProviderType());
        return;
      }
      throw err;
    }
  }

  async complete(messages: ChatMessage[], maxTokens: number = 256, signal?: AbortSignal): Promise<string> {
    this.pushModelUsageLog({ model: this.model, role: 'complete', timestamp: new Date() });
    circuitBreaker.guard(this.getProviderType());
    // v0.64 phase 4c.2 — the backend records spend directly for
    // one-shot `complete()` dispatches (AnthropicBackend.complete
    // writes usage into spendTracker as part of its response-parse).
    // We can't see the usage event from here, but we CAN observe the
    // total-spend delta across the call boundary and forward it to the
    // router so per-rule budget caps still trip on critic / summarize /
    // other non-streaming dispatches.
    const preSpend = spendTracker.snapshot().totalUsd;
    try {
      const result = await this.backend.complete(this.model, this.systemPrompt, messages, maxTokens, signal);
      this.chargeLastDecision(spendTracker.snapshot().totalUsd - preSpend);
      this.recordSuccess();
      circuitBreaker.recordSuccess(this.getProviderType());
      return result;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;

      // v0.63.1 — native backend-capability retry (see streamChat
      // for the full rationale). Non-streaming complete() mirrors
      // the streaming path: try native fallback first, then fall
      // through to provider fallback on failure.
      const nativeRetry = this.backend.nativeCapabilities?.()?.oaiCompatFallback;
      if (nativeRetry && nativeRetry.matches(err)) {
        try {
          const retryResult = await nativeRetry.fallbackComplete(
            this.model,
            this.systemPrompt,
            messages,
            maxTokens,
            signal,
          );
          this.recordSuccess();
          circuitBreaker.recordSuccess(this.getProviderType());
          return retryResult;
        } catch (retryErr) {
          if (retryErr instanceof Error && retryErr.name === 'AbortError') throw retryErr;
          console.warn(
            `[SideCar] Native fallback also failed: ${(retryErr as Error).message}. Falling through to provider fallback.`,
          );
        }
      }

      circuitBreaker.recordFailure(this.getProviderType());
      if (this.switchToFallback()) {
        console.warn(`[SideCar] Primary backend failed, switching to fallback: ${(err as Error).message}`);
        circuitBreaker.guard(this.getProviderType());
        const result = await this.backend.complete(this.model, this.systemPrompt, messages, maxTokens, signal);
        circuitBreaker.recordSuccess(this.getProviderType());
        return result;
      }
      throw err;
    }
  }

  /**
   * One-shot completion with per-call overrides for model and system prompt.
   * Used by the adversarial critic so it can run under its own prompt /
   * model without disturbing the main agent's client state. Does not
   * participate in the fallback-switching machinery — critic is opportunistic.
   */
  async completeWithOverrides(
    systemPrompt: string,
    messages: ChatMessage[],
    overrideModel?: string,
    maxTokens: number = 1024,
    signal?: AbortSignal,
  ): Promise<string> {
    const model = overrideModel && overrideModel.trim().length > 0 ? overrideModel : this.model;
    // Mirror the spend-delta hook from `complete()` so router budget
    // tracking works for critic dispatches too (v0.64 phase 4c.2).
    const preSpend = spendTracker.snapshot().totalUsd;
    const result = await this.backend.complete(model, systemPrompt, messages, maxTokens, signal);
    this.chargeLastDecision(spendTracker.snapshot().totalUsd - preSpend);
    return result;
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    // If on fallback and primary succeeded, switch back
    if (this.usingFallback) {
      this.switchToPrimary();
    }
  }

  /**
   * Try switching to the fallback backend after consecutive failures.
   * Returns true if switched (caller should retry), false if no fallback available.
   */
  private switchToFallback(): boolean {
    this.consecutiveFailures++;
    if (this.consecutiveFailures < SideCarClient.FALLBACK_THRESHOLD) return false;

    const config = getConfig();
    if (!config.fallbackBaseUrl || this.usingFallback) return false;

    // Save primary state and switch
    this.primaryBaseUrl = this.baseUrl;
    this.primaryApiKey = this.apiKey;
    this.primaryModel = this.model;

    this.baseUrl = config.fallbackBaseUrl;
    this.apiKey = config.fallbackApiKey || 'ollama';
    this.model = config.fallbackModel || this.primaryModel;
    this.backend = this.createBackend();
    this.usingFallback = true;
    this.consecutiveFailures = 0;
    console.log(`[SideCar] Switched to fallback backend: ${this.baseUrl}`);
    return true;
  }

  private switchToPrimary(): void {
    this.baseUrl = this.primaryBaseUrl;
    this.apiKey = this.primaryApiKey;
    this.model = this.primaryModel;
    this.backend = this.createBackend();
    this.usingFallback = false;
    console.log('[SideCar] Switched back to primary backend');
  }

  async completeFIM(
    prefix: string,
    suffix: string,
    model?: string,
    maxTokens: number = 256,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await fetch(this.generateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || this.model,
        prompt: prefix,
        suffix,
        stream: false,
        options: { num_predict: maxTokens },
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`FIM request failed: ${response.status}${errorText ? ` — ${errorText}` : ''}`);
    }

    const data = (await response.json()) as { response: string };
    return data.response ?? '';
  }

  getModel(): string {
    return this.model;
  }

  updateModel(model: string) {
    this.model = model;
  }

  /**
   * Attach a Role-Based Model Router (v0.64). Pass `null` to detach and
   * revert to static-model dispatch. The router's internal `activeModel`
   * is synced to the client's current `model` so the first routing
   * decision doesn't spuriously flag a swap when the resolved rule model
   * happens to match what the client is already using.
   */
  setRouter(router: ModelRouter | null): void {
    this.router = router;
    if (router) router.setInitialActiveModel(this.model);
  }

  /** Current router, or `null` if routing is off. */
  getRouter(): ModelRouter | null {
    return this.router;
  }

  /**
   * Ask the router for a dispatch model, update the active `model` if
   * the decision changed it, and return the decision. When no router is
   * attached returns `null` and the client keeps using its static
   * `model` — which is the legacy behavior for every dispatch site
   * that hasn't yet been role-tagged.
   *
   * Callers should invoke this BEFORE issuing the actual dispatch (so
   * the backend call picks up the swapped model), then consult the
   * return value to decide whether to surface a visible-swap toast.
   */
  routeForDispatch(signals: RouteSignals): RouteDecision | null {
    // Sentinel-pinned turn takes precedence over the router. Returning
    // null signals callers to use `this.model` directly — which
    // `setTurnOverride` has already set to the target.
    if (this.turnOverride) return null;
    if (!this.router) return null;
    const decision = this.router.route(signals);
    if (decision.model !== this.model) {
      this.model = decision.model;
    }
    this.lastDecision = decision;
    return decision;
  }

  /**
   * Pin the active model for a single user turn, bypassing the router
   * for every dispatch until the chat handler calls `setTurnOverride(null)`
   * at end-of-turn. Used by the `@opus` / `@sonnet` / `@haiku` / `@local`
   * inline sentinels (v0.64 phase 4d.1). Passing `null` clears the pin
   * and restores normal routing.
   */
  setTurnOverride(model: string | null): void {
    if (model) {
      // Capture the pre-override model so `setTurnOverride(null)` can
      // restore it. Guarded to avoid double-captures if the caller
      // pins twice in a row without clearing.
      if (this.turnOverride === null) {
        this.preOverrideModel = this.model;
      }
      this.turnOverride = model;
      this.model = model;
    } else {
      this.turnOverride = null;
      if (this.preOverrideModel !== null) {
        this.model = this.preOverrideModel;
        this.preOverrideModel = null;
      }
    }
  }

  /** Current turn-override target, or `null` when no sentinel is active. */
  getTurnOverride(): string | null {
    return this.turnOverride;
  }

  /**
   * Forward the USD cost of a just-recorded spend event to the router
   * so it can apply budget caps to the rule that produced the last
   * decision. No-op when no router is attached or when no rule matched
   * (default-model dispatches aren't budgeted). Exposed as a public
   * method so the in-stream spend hook can call it without needing
   * access to internal state.
   */
  private chargeLastDecision(costUsd: number): void {
    if (costUsd <= 0) return;
    if (!this.router || !this.lastDecision?.matched) return;
    this.router.recordSpend(this.lastDecision.matched, costUsd);
  }

  /**
   * Introspect the active backend's native capabilities (v0.63.1).
   * Returns `undefined` when the backend implements only the baseline
   * `streamChat` + `complete` surface. Callers (command-palette
   * actions, the future model-browser UI, feature tests) use this to
   * gate conditional functionality without leaking the raw backend
   * instance.
   *
   * Narrower-than-raw-backend accessor intentional — exposing
   * `this.backend` directly would tempt callers into bypassing
   * `SideCarClient`'s circuit-breaker / retry / spend-tracking
   * machinery.
   */
  getBackendCapabilities(): import('./backend.js').BackendCapabilities | undefined {
    return this.backend.nativeCapabilities?.();
  }

  /**
   * Append an entry to the model-usage log, respecting the
   * drop-oldest cap set by `MAX_MODEL_USAGE_LOG_ENTRIES`. Single
   * write point so the cap is enforced uniformly for every caller.
   */
  private pushModelUsageLog(entry: ModelUsageEntry): void {
    this._modelUsageLog.push(entry);
    if (this._modelUsageLog.length > SideCarClient.MAX_MODEL_USAGE_LOG_ENTRIES) {
      // Array.shift is O(n) but the cap keeps n small (~1000). A
      // head-index ring would be faster asymptotically; the direct
      // shift is simpler and fast enough for this workload.
      this._modelUsageLog.shift();
    }
  }

  /** Return a copy of every model call recorded in this session (up to `MAX_MODEL_USAGE_LOG_ENTRIES`). */
  getModelUsageLog(): ModelUsageEntry[] {
    return [...this._modelUsageLog];
  }

  /** Reset the log — call after a commit so the next session starts clean. */
  clearModelUsageLog(): void {
    this._modelUsageLog = [];
  }

  /**
   * Build the git trailer block that describes which models contributed.
   * Deduplicates by model name and emits one `X-AI-Model` trailer per unique
   * model, plus a `X-AI-Model-Count` summary when more than one was used.
   *
   * Example output (two models):
   *   X-AI-Model: claude-sonnet-4-5 (chat, 3 calls)
   *   X-AI-Model: qwen3-coder:30b (complete, 1 call)
   *   X-AI-Model-Count: 2
   */
  buildModelTrailers(): string {
    if (this._modelUsageLog.length === 0) {
      // Fall back to the currently configured model so there's always a trailer.
      return `X-AI-Model: ${this.model}`;
    }

    // Aggregate: model → { roles, count }
    const agg = new Map<string, { roles: Set<string>; count: number }>();
    for (const entry of this._modelUsageLog) {
      const existing = agg.get(entry.model);
      if (existing) {
        existing.roles.add(entry.role);
        existing.count++;
      } else {
        agg.set(entry.model, { roles: new Set([entry.role]), count: 1 });
      }
    }

    const lines: string[] = [];
    for (const [model, { roles, count }] of agg) {
      const roleStr = [...roles].join(', ');
      const callStr = count === 1 ? '1 call' : `${count} calls`;
      lines.push(`X-AI-Model: ${model} (${roleStr}, ${callStr})`);
    }
    if (agg.size > 1) {
      lines.push(`X-AI-Model-Count: ${agg.size}`);
    }
    return lines.join('\n');
  }

  updateSystemPrompt(prompt: string) {
    this.systemPrompt = prompt;
  }

  updateConnection(baseUrl: string, apiKey: string) {
    const newBaseUrl = baseUrl || DEFAULT_BASE_URL;
    this.baseUrl = newBaseUrl;
    this.apiKey = apiKey || 'ollama';
    this.primaryBaseUrl = this.baseUrl;
    this.primaryApiKey = this.apiKey;
    this.primaryModel = this.model;
    this.usingFallback = false;
    this.consecutiveFailures = 0;
    this.backend = this.createBackend();
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  async getModelContextLength(): Promise<number | null> {
    const provider = this.getProviderType();

    if (provider === 'kickstand') {
      // Kickstand reports the loaded handle's n_ctx on the OAI card
      // (post-v0.6 patch). Query /v1/models, find our model, return
      // context_length. Returns null for models not currently loaded.
      try {
        const response = await fetch(`${this.baseUrl}/v1/models`);
        if (!response.ok) return MODEL_CONTEXT_LENGTHS[this.model] ?? null;
        const data = (await response.json()) as {
          data?: { id: string; context_length?: number | null }[];
        };
        const entry = (data.data || []).find((m) => m.id === this.model);
        return typeof entry?.context_length === 'number'
          ? entry.context_length
          : (MODEL_CONTEXT_LENGTHS[this.model] ?? null);
      } catch {
        return MODEL_CONTEXT_LENGTHS[this.model] ?? null;
      }
    }

    // For cloud providers, check the well-known context lengths lookup table.
    // This covers Anthropic, OpenAI, Groq, Fireworks, OpenRouter, etc.
    if (!this.isLocalOllama()) {
      return MODEL_CONTEXT_LENGTHS[this.model] ?? null;
    }
    try {
      const response = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model }),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as Record<string, unknown>;

      // Prefer the actual runtime num_ctx from model parameters — this reflects
      // what Ollama will actually use, not the model's theoretical max.
      const params = data.parameters as string | undefined;
      if (params) {
        const match = params.match(/^num_ctx\s+(\d+)/m);
        if (match) return parseInt(match[1], 10);
      }

      // Fall back to the model_info advertised context length
      const modelInfo = data.model_info as Record<string, unknown> | undefined;
      if (!modelInfo) return null;
      for (const [key, value] of Object.entries(modelInfo)) {
        if (key.toLowerCase().includes('context_length') && typeof value === 'number') {
          return value;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  isLocalOllama(): boolean {
    return isLocalOllama(this.baseUrl);
  }

  isOpenAI(): boolean {
    const provider = detectProvider(this.baseUrl, getConfig().provider);
    return provider === 'openai';
  }

  getProviderType(): 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks' {
    return detectProvider(this.baseUrl, getConfig().provider);
  }

  async listInstalledModels(): Promise<InstalledModel[]> {
    const provider = this.getProviderType();

    if (provider === 'anthropic') {
      const fallback = (): InstalledModel[] =>
        ANTHROPIC_FALLBACK_MODELS.map((id) => ({ name: id, model: id, size: 0 }));
      try {
        const response = await fetch(`${this.baseUrl}/v1/models`, {
          headers: {
            'x-api-key': this.apiKey,
            'anthropic-version': '2023-06-01',
          },
        });
        if (!response.ok) return fallback();
        const data = (await response.json()) as { data?: { id: string; display_name?: string }[] };
        const fetched = (data.data || []).map((m) => ({ name: m.id, model: m.id, size: 0 }));
        return fetched.length > 0 ? fetched : fallback();
      } catch {
        return fallback();
      }
    }

    if (provider === 'kickstand') {
      // Kickstand's full registry — `/api/v1/models` — surfaces every
      // downloaded model (loaded or not) plus GGUF-derived
      // `context_length` for unloaded entries. The OAI `/v1/models`
      // only reports loaded models, which would hide the user's real
      // library in the picker. We filter on `status === 'ready'` so
      // in-flight downloads don't pollute the dropdown.
      try {
        const response = await fetch(`${this.baseUrl}/api/v1/models`, {
          headers: kickstandHeaders(),
        });
        if (!response.ok) return [];
        const data = (await response.json()) as Array<{
          model_id: string;
          size_bytes?: number | null;
          status?: string;
          context_length?: number | null;
        }>;
        return (data || [])
          .filter((m) => m.status === 'ready' || m.status === undefined)
          .map((m) => ({
            name: m.model_id,
            model: m.model_id,
            size: m.size_bytes ?? 0,
            contextLength: typeof m.context_length === 'number' ? m.context_length : null,
          }));
      } catch {
        return [];
      }
    }

    if (provider === 'openai' || provider === 'openrouter' || provider === 'groq' || provider === 'fireworks') {
      // OpenAI-compatible servers all use GET /v1/models. OpenRouter
      // enriches each entry with `top_provider` + `pricing` fields, but
      // we only surface the id in the basic model picker here — the
      // richer catalog is exposed via OpenRouterBackend.listOpenRouterModels()
      // for features that need the pricing overlay.
      try {
        const headers: Record<string, string> = {};
        if (this.apiKey && this.apiKey !== 'ollama') {
          headers['Authorization'] = `Bearer ${this.apiKey}`;
        }
        const response = await fetch(`${this.baseUrl}/v1/models`, { headers });
        if (!response.ok) return [];
        const data = (await response.json()) as {
          data: { id: string; name?: string; owned_by?: string; top_provider?: { name?: string } }[];
        };
        return (data.data || []).map((m) => ({
          name: m.id,
          model: m.id,
          size: 0,
          details: {
            parameter_size: '',
            quantization_level: '',
            family: m.owned_by || m.top_provider?.name || '',
          },
        }));
      } catch {
        return [];
      }
    }

    // Ollama uses /api/tags
    const response = await fetch(this.tagsUrl);
    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status}`);
    }
    const data = (await response.json()) as { models: InstalledModel[] };
    return data.models ?? [];
  }

  /**
   * List models available to the current backend.
   *
   * For Ollama this is driven entirely by `/api/tags` — whatever Ollama
   * reports as locally installed is what the user can actually use. By
   * default we *also* append a small hardcoded list of popular library
   * models marked `installed: false` so brand-new users with an empty
   * Ollama have something to click. Callers that render the main chat
   * dropdown should pass `{ includeSuggestions: false }` so uninstalled
   * suggestions don't pollute the "active model" picker — the chat UX
   * should only surface models Ollama can actually run right now.
   */
  async listLibraryModels(options: { includeSuggestions?: boolean } = {}): Promise<LibraryModel[]> {
    const { includeSuggestions = true } = options;
    const installed = await this.listInstalledModels();
    const installedNames = new Set(installed.map((m) => m.name.split(':')[0]));

    const results: LibraryModel[] = installed.map((m) => ({
      name: m.name,
      installed: true,
      contextLength: m.contextLength ?? null,
    }));

    if (includeSuggestions && this.getProviderType() === 'ollama') {
      for (const name of LIBRARY_MODELS) {
        if (!installedNames.has(name)) {
          results.push({ name, installed: false });
        }
      }
    }

    return results;
  }

  async *pullModel(model: string, signal?: AbortSignal): AsyncGenerator<PullProgress> {
    const response = await fetch(this.pullUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to pull model: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Pull returned an empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder
          .decode(value, { stream: true })
          .split('\n')
          .filter((line) => line.trim());

        for (const line of lines) {
          try {
            yield JSON.parse(line) as PullProgress;
          } catch {
            // Skip malformed lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  /**
   * Discover and merge available models from both Ollama and Kickstand backends.
   * Uses the configured base URL for the active provider and probes the other
   * backend at its default port only if the active provider isn't already pointing there.
   *
   * @param ollamaUrl   Base URL for Ollama (default: http://localhost:11434)
   * @param kickstandUrl Base URL for Kickstand (default: http://localhost:11435)
   * @param apiKey      Optional API key for Kickstand authentication
   */
  static async discoverAllAvailableModels(
    ollamaUrl = 'http://localhost:11434',
    kickstandUrl = 'http://localhost:11435',
  ): Promise<InstalledModel[]> {
    const models: InstalledModel[] = [];
    const seen = new Set<string>();

    // Try Ollama
    try {
      const url = ollamaUrl.replace(/\/+$/, '');
      const ollamaResponse = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (ollamaResponse.ok) {
        const data = (await ollamaResponse.json()) as { models: InstalledModel[] };
        if (data.models) {
          for (const m of data.models) {
            if (!seen.has(m.name)) {
              models.push(m);
              seen.add(m.name);
            }
          }
        }
      }
    } catch {
      // Ollama not available, continue
    }

    // Try Kickstand
    try {
      const url = kickstandUrl.replace(/\/+$/, '');
      const llmmResponse = await fetch(`${url}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (llmmResponse.ok) {
        const data = (await llmmResponse.json()) as { data: { id: string; owned_by?: string }[] };
        if (data.data) {
          for (const m of data.data) {
            if (!seen.has(m.id)) {
              models.push({
                name: m.id,
                model: m.id,
              });
              seen.add(m.id);
            }
          }
        }
      }
    } catch {
      // Kickstand not available, continue
    }

    return models;
  }
}
