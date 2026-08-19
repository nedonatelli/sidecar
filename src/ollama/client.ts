import type { ChatMessage, ToolDefinition, StreamEvent } from './types.js';
import { logger } from '../system/logger.js';
import type { ApiBackend, ResponseFormat } from './backend.js';
import { AnthropicBackend } from './anthropicBackend.js';
import { OllamaBackend } from './ollamaBackend.js';
import { OpenAIBackend } from './openaiBackend.js';
import { KickstandBackend } from './kickstandBackend.js';
import { OpenRouterBackend } from './openrouterBackend.js';
import { GroqBackend } from './groqBackend.js';
import { FireworksBackend } from './fireworksBackend.js';
import { GeminiBackend } from './geminiBackend.js';
import { CopilotBackend } from './copilotBackend.js';
import { BedrockBackend } from './bedrockBackend.js';
import { isLocalOllama, detectProvider, getConfig } from '../config/settings.js';
import { MODEL_CONTEXT_LENGTHS } from '../config/constants.js';
import { RateLimitStore } from './rateLimitState.js';
import { spendTracker } from './spendTracker.js';
import { circuitBreaker, isPermanentError, BackendConfigError } from './circuitBreaker.js';
import { ModelRouter, type RouteSignals, type RouteDecision } from './modelRouter.js';
import { ModelUsageLog, type ModelUsageEntry } from './modelUsageLog.js';
export type { ModelUsageEntry } from './modelUsageLog.js';
import {
  type InstalledModel,
  type LibraryModel,
  type PullProgress,
  listInstalledModelsInner,
  buildLibraryModels,
  pullModelStream,
  discoverAllAvailableModels as discoverAllModels,
} from './client/modelCatalog.js';
export type { InstalledModel, LibraryModel, PullProgress } from './client/modelCatalog.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

/** Returns true when a URL targets a local host (Ollama/Kickstand pattern). */
function isLocalUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname === '0.0.0.0';
  } catch {
    return false;
  }
}

/**
 * Lightweight reachability probe for local backends. Sends a GET request with
 * a 2-second timeout — any HTTP response (including 4xx/5xx) counts as
 * "reachable"; a network error (ECONNREFUSED, ENOTFOUND, timeout) returns false.
 */
async function probeFallbackHealth(baseUrl: string, timeoutMs = 2000): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      await fetch(`${baseUrl}/api/tags`, { method: 'GET', signal: controller.signal });
      return true;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export class SideCarClient {
  private model: string;
  private systemPrompt: string;
  private baseUrl: string;
  private apiKey: string;
  private backend: ApiBackend;

  /**
   * Optional Role-Based Model Router. Owning the router at the
   * client layer means every dispatch site can consult it via
   * `routeForDispatch()` without plumbing a separate service through
   * chat handlers / completion provider / summarizer. When
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
   * inline sentinels . When non-null, every
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
   * Cache of known-installed model names. Populated as a side-effect of
   * every `listInstalledModels()` call so routing availability checks can
   * use it synchronously without a separate async fetch. `undefined` until
   * the first `listInstalledModels()` call completes.
   */
  private _cachedModelNames: Set<string> | undefined = undefined;

  private _usageLog = new ModelUsageLog();
  /** Public so tests can reference the same constant instead of hardcoding. */
  static readonly MAX_MODEL_USAGE_LOG_ENTRIES = ModelUsageLog.MAX_ENTRIES;

  // Rate-limit state — one store per provider, so switching profiles
  // mid-session preserves each provider's accumulated budget info AND
  // keeps them isolated. A shared store would merge fields across
  // providers (update() keeps old values when new ones are absent),
  // leaking one provider's remaining-token counts into another's view.
  private rateLimitsByProvider = new Map<
    | 'ollama'
    | 'anthropic'
    | 'openai'
    | 'kickstand'
    | 'openrouter'
    | 'groq'
    | 'fireworks'
    | 'gemini'
    | 'copilot'
    | 'bedrock'
    | 'openai-compat',
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
      case 'kickstand': {
        const cfg = getConfig();
        return new KickstandBackend(this.baseUrl, this.rateLimitsFor('kickstand'), cfg.kickstandNCtx, {
          rope_freq_base: cfg.kickstandRopeFreqBase || undefined,
          rope_freq_scale: cfg.kickstandRopeFreqScale || undefined,
          yarn_ext_factor: cfg.kickstandYarnExtFactor !== -1 ? cfg.kickstandYarnExtFactor : undefined,
          yarn_orig_ctx: cfg.kickstandYarnOrigCtx || undefined,
          flash_attn: cfg.kickstandFlashAttn || undefined,
        });
      }
      case 'openrouter':
        return new OpenRouterBackend(this.baseUrl, this.apiKey, this.rateLimitsFor('openrouter'));
      case 'groq':
        return new GroqBackend(this.baseUrl, this.apiKey, this.rateLimitsFor('groq'));
      case 'fireworks':
        return new FireworksBackend(this.baseUrl, this.apiKey, this.rateLimitsFor('fireworks'));
      case 'gemini':
        return new GeminiBackend(this.baseUrl, this.apiKey, this.rateLimitsFor('gemini'));
      case 'copilot':
        return new CopilotBackend();
      case 'bedrock':
        return new BedrockBackend(
          getConfig().bedrockRegion,
          { bearerToken: this.apiKey },
          this.rateLimitsFor('bedrock'),
          getConfig().bedrockFips,
        );
      case 'openai':
      case 'openai-compat':
        // Same wire protocol; the two differ only in what the user is telling us.
        // 'openai-compat' exists so a self-hosted or gateway endpoint is a
        // first-class choice in the UI instead of something you get by setting
        // provider='openai' and hoping the URL sniffing does not reclassify it.
        return new OpenAIBackend(this.baseUrl, this.apiKey, this.rateLimitsFor('openai'));
    }
  }

  private rateLimitsFor(
    provider:
      | 'ollama'
      | 'anthropic'
      | 'openai'
      | 'kickstand'
      | 'openrouter'
      | 'groq'
      | 'fireworks'
      | 'gemini'
      | 'copilot'
      | 'bedrock'
      | 'openai-compat',
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
    systemPromptOverride?: string,
    modelOverride?: string,
  ): AsyncGenerator<StreamEvent> {
    const effectiveModel = modelOverride ?? this.model;
    const effectiveSystemPrompt = systemPromptOverride ?? this.systemPrompt;
    this.pushModelUsageLog({ model: effectiveModel, role: 'chat', timestamp: new Date() });
    // Fast-fail when the breaker is open so the user sees a clear error
    // instead of the request hanging on a dead provider. Advances an
    // open breaker to half-open once the cooldown has elapsed.
    circuitBreaker.guard(this.getProviderType());
    try {
      for await (const event of this.backend.streamChat(
        effectiveModel,
        effectiveSystemPrompt,
        messages,
        signal,
        tools,
      )) {
        if (event.type === 'usage') this.chargeLastDecision(spendTracker.record(event.model, event.usage));
        yield event;
      }
      this.recordSuccess();
      circuitBreaker.recordSuccess(this.getProviderType());
    } catch (err) {
      // Don't count user aborts as failures
      if (err instanceof Error && err.name === 'AbortError') throw err;

      // native backend-capability retry. Gives the active
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
            effectiveModel,
            effectiveSystemPrompt,
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
          logger.warn(
            `[SideCar] Native fallback also failed: ${(retryErr as Error).message}. Falling through to provider fallback.`,
          );
        }
      }

      if (isPermanentError(err)) throw new BackendConfigError(this.getProviderType(), err);
      circuitBreaker.recordFailure(this.getProviderType());
      if (await this.switchToFallback()) {
        logger.warn(`[SideCar] Primary backend failed, switching to fallback: ${(err as Error).message}`);
        yield { type: 'warning', message: 'Primary backend unavailable — using fallback.' };
        circuitBreaker.guard(this.getProviderType());
        try {
          for await (const event of this.backend.streamChat(
            effectiveModel,
            effectiveSystemPrompt,
            messages,
            signal,
            tools,
          )) {
            if (event.type === 'usage') this.chargeLastDecision(spendTracker.record(event.model, event.usage));
            yield event;
          }
          circuitBreaker.recordSuccess(this.getProviderType());
          return;
        } catch (fallbackErr) {
          if (fallbackErr instanceof Error && fallbackErr.name === 'AbortError') throw fallbackErr;
          circuitBreaker.recordFailure(this.getProviderType());
          throw fallbackErr;
        }
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
    // router so per-rule budget caps still trip on summarize /
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

      // native backend-capability retry (see streamChat
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
          logger.warn(
            `[SideCar] Native fallback also failed: ${(retryErr as Error).message}. Falling through to provider fallback.`,
          );
        }
      }

      if (isPermanentError(err)) throw new BackendConfigError(this.getProviderType(), err);
      circuitBreaker.recordFailure(this.getProviderType());
      if (await this.switchToFallback()) {
        logger.warn(`[SideCar] Primary backend failed, switching to fallback: ${(err as Error).message}`);
        circuitBreaker.guard(this.getProviderType());
        try {
          const result = await this.backend.complete(this.model, this.systemPrompt, messages, maxTokens, signal);
          this.chargeLastDecision(spendTracker.snapshot().totalUsd - preSpend);
          circuitBreaker.recordSuccess(this.getProviderType());
          return result;
        } catch (fallbackErr) {
          if (fallbackErr instanceof Error && fallbackErr.name === 'AbortError') throw fallbackErr;
          circuitBreaker.recordFailure(this.getProviderType());
          throw fallbackErr;
        }
      }
      throw err;
    }
  }

  /**
   * One-shot completion with per-call overrides for model and system prompt.
   * Used by opportunistic side dispatches (FIM, doc-test synthesis, tool-call
   * repair, query rewrite, adaptive paste) so they can run under their own
   * prompt / model without disturbing the main agent's client state. Does not
   * participate in the fallback-switching machinery — these are opportunistic.
   */
  async completeWithOverrides(
    systemPrompt: string,
    messages: ChatMessage[],
    overrideModel?: string,
    maxTokens: number = 1024,
    signal?: AbortSignal,
    responseFormat?: ResponseFormat,
  ): Promise<string> {
    const model = overrideModel && overrideModel.trim().length > 0 ? overrideModel : this.model;
    // Mirror the spend-delta hook from `complete()` so router budget
    // tracking works for override dispatches too.
    const preSpend = spendTracker.snapshot().totalUsd;
    try {
      const result = await this.backend.complete(model, systemPrompt, messages, maxTokens, signal, responseFormat);
      this.chargeLastDecision(spendTracker.snapshot().totalUsd - preSpend);
      return result;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      circuitBreaker.recordFailure(this.getProviderType());
      throw err;
    }
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
   *
   * For local fallback URLs (Ollama/Kickstand on localhost) a lightweight
   * connectivity probe fires first — if the fallback is also unreachable we
   * skip the switch immediately rather than wasting a full round-trip.
   */
  private async switchToFallback(): Promise<boolean> {
    this.consecutiveFailures++;
    if (this.consecutiveFailures < SideCarClient.FALLBACK_THRESHOLD) return false;

    const config = getConfig();
    if (!config.fallbackBaseUrl || this.usingFallback) return false;

    if (isLocalUrl(config.fallbackBaseUrl)) {
      const reachable = await probeFallbackHealth(config.fallbackBaseUrl);
      if (!reachable) {
        logger.warn(`[SideCar] Fallback backend unreachable (health probe failed): ${config.fallbackBaseUrl}`);
        return false;
      }
    }

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
    logger.info(`[SideCar] Switched to fallback backend: ${this.baseUrl}`);
    return true;
  }

  private switchToPrimary(): void {
    this.baseUrl = this.primaryBaseUrl;
    this.apiKey = this.primaryApiKey;
    this.model = this.primaryModel;
    this.backend = this.createBackend();
    this.usingFallback = false;
    logger.info('[SideCar] Switched back to primary backend');
  }

  async completeFIM(
    prefix: string,
    suffix: string,
    model?: string,
    maxTokens: number = 256,
    signal?: AbortSignal,
  ): Promise<string> {
    const activeModel = model || this.model;

    // Delegate to backend if it implements FIM natively (e.g. Ollama's /api/generate, Anthropic prompt-wrapped)
    if (this.backend.completeFIM) {
      return this.backend.completeFIM(activeModel, prefix, suffix, maxTokens, signal);
    }

    // Fallback for Ollama: direct fetch to /api/generate (for backends that don't implement the interface method yet)
    const response = await fetch(this.generateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: activeModel,
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
   * Attach a Role-Based Model Router. Pass `null` to detach and
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
  /**
   * Synchronous snapshot of the last-known installed model names, populated
   * as a side-effect of `listInstalledModels()`. Used by `routeForDispatch`
   * to skip routing rules whose target model is not currently available.
   * Returns `undefined` until the first `listInstalledModels()` call completes.
   */
  getKnownModelNames(): Set<string> | undefined {
    return this._cachedModelNames;
  }

  routeForDispatch(signals: RouteSignals): RouteDecision | null {
    // Sentinel-pinned turn takes precedence over the router. Returning
    // null signals callers to use `this.model` directly — which
    // `setTurnOverride` has already set to the target.
    if (this.turnOverride) return null;
    if (!this.router) return null;
    const decision = this.router.route(signals, this._cachedModelNames);
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
   * inline sentinels . Passing `null` clears the pin
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
   * Introspect the active backend's native capabilities.
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

  private pushModelUsageLog(entry: ModelUsageEntry): void {
    this._usageLog.push(entry);
  }

  /** Return a copy of every model call recorded in this session (up to `MAX_MODEL_USAGE_LOG_ENTRIES`), oldest-first. */
  getModelUsageLog(): ModelUsageEntry[] {
    return this._usageLog.getAll();
  }

  /** Reset the log — call after a commit so the next session starts clean. */
  clearModelUsageLog(): void {
    this._usageLog.clear();
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
    return this._usageLog.buildTrailers(this.model);
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

  async getModelContextLength(signal?: AbortSignal): Promise<number | null> {
    const provider = this.getProviderType();

    if (provider === 'copilot') {
      return CopilotBackend.getModelContextLength(this.model);
    }

    if (provider === 'kickstand') {
      // Kickstand reports the loaded handle's n_ctx on the OAI card
      // (post-v0.6 patch). Query /v1/models, find our model, return
      // context_length. Returns null for models not currently loaded.
      try {
        const kickstandTimeout = AbortSignal.timeout(10_000);
        const response = await fetch(`${this.baseUrl}/v1/models`, {
          signal: signal ? AbortSignal.any([signal, kickstandTimeout]) : kickstandTimeout,
        });
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
      const known = MODEL_CONTEXT_LENGTHS[this.model];
      if (known === undefined) {
        logger.warn(
          `[SideCar] Context window for "${this.model}" not in lookup table — compression thresholds may be inaccurate. Add it to MODEL_CONTEXT_LENGTHS in constants.ts.`,
        );
      }
      return known ?? null;
    }
    try {
      // Hard-capped and abortable: this runs BEFORE the agent loop's first
      // iteration, so an unsignalled hang here wedges the whole run with the
      // spinner up and Stop dead (observed live in the v0.119 dogfood pass —
      // a rename run hung 9+ minutes pre-iteration and abort had no effect).
      // A stale probe is harmless (we fall back to 32K); a hung probe is not.
      const timeout = AbortSignal.timeout(10_000);
      const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model }),
        signal: composed,
      });
      if (!response.ok) return 32_768;
      const data = (await response.json()) as Record<string, unknown>;

      // Prefer the actual runtime num_ctx from model parameters — this reflects
      // what Ollama will actually use, not the model's theoretical max.
      let probed: number | null = null;
      const params = data.parameters as string | undefined;
      if (params) {
        const match = params.match(/^num_ctx\s+(\d+)/m);
        if (match) probed = parseInt(match[1], 10);
      }

      // Fall back to the model_info advertised context length
      if (probed === null) {
        const modelInfo = data.model_info as Record<string, unknown> | undefined;
        if (modelInfo) {
          for (const [key, value] of Object.entries(modelInfo)) {
            if (key.toLowerCase().includes('context_length') && typeof value === 'number') {
              probed = value;
              break;
            }
          }
        }
      }

      return Math.max(probed ?? 0, 32_768);
    } catch {
      return 32_768;
    }
  }

  isLocalOllama(): boolean {
    return isLocalOllama(this.baseUrl);
  }

  isOpenAI(): boolean {
    const provider = detectProvider(this.baseUrl, getConfig().provider);
    return provider === 'openai';
  }

  getProviderType():
    | 'ollama'
    | 'anthropic'
    | 'openai'
    | 'kickstand'
    | 'openrouter'
    | 'groq'
    | 'fireworks'
    | 'gemini'
    | 'copilot'
    | 'bedrock'
    | 'openai-compat' {
    return detectProvider(this.baseUrl, getConfig().provider);
  }

  async listInstalledModels(): Promise<InstalledModel[]> {
    const result = await this._listInstalledModelsInner();
    this._cachedModelNames = new Set(result.map((m) => m.name));
    return result;
  }

  private _listInstalledModelsInner(): Promise<InstalledModel[]> {
    return listInstalledModelsInner({
      provider: this.getProviderType(),
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      backend: this.backend,
    });
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
    return buildLibraryModels(installed, this.getProviderType(), includeSuggestions);
  }

  async *pullModel(model: string, signal?: AbortSignal): AsyncGenerator<PullProgress> {
    yield* pullModelStream(this.pullUrl, model, signal);
  }

  /**
   * Discover and merge available models from both Ollama and Kickstand backends.
   * Probes each at its base URL with a 2-second timeout; an unreachable backend
   * is skipped silently. Deduplicates by model name.
   *
   * @param ollamaUrl   Base URL for Ollama (default: http://localhost:11434)
   * @param kickstandUrl Base URL for Kickstand (default: http://localhost:11435)
   */
  static discoverAllAvailableModels(
    ollamaUrl = 'http://localhost:11434',
    kickstandUrl = 'http://localhost:11435',
  ): Promise<InstalledModel[]> {
    return discoverAllModels(ollamaUrl, kickstandUrl);
  }
}
