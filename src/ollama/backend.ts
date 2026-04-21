import type { ChatMessage, ToolDefinition, StreamEvent } from './types.js';

/**
 * Abstraction over different LLM API backends.
 * Implementations handle protocol differences (Anthropic Messages API vs Ollama native).
 */
export interface ApiBackend {
  streamChat(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent>;

  complete(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string>;

  /**
   * Fill-in-the-Middle (FIM) completion. Optional — only backends
   * with native FIM support (currently Ollama via /api/generate) or
   * backends that can emulate FIM via a prompt pattern implement this.
   * Callers check `backend.completeFIM` before calling.
   *
   * Used by inline code completion provider for fast, single-line
   * completions within the current editing context.
   */
  completeFIM?(model: string, prefix: string, suffix: string, maxTokens: number, signal?: AbortSignal): Promise<string>;

  /**
   * Declare per-backend native capabilities beyond the standard
   * streamChat + complete surface (v0.63.1). Optional — backends
   * without extra capabilities (Anthropic, Groq, Fireworks,
   * OpenRouter in its default config) simply don't implement this.
   *
   * Returning `undefined` is equivalent to not implementing the
   * method — both mean "this backend has no native surface worth
   * exposing." Callers that care about a specific capability check
   * `backend.nativeCapabilities?.()?.<key>` and treat missing as
   * "unsupported."
   *
   * See [`BackendCapabilities`](./backend.ts) for the full record
   * shape and [`docs/extending-sidecar.md`](../../docs/extending-sidecar.md)
   * for the guidance on when to add a new capability.
   */
  nativeCapabilities?(): BackendCapabilities | undefined;
}

/**
 * The v0.63.1 native-capabilities record. Each key is an optional
 * sub-interface scoped to one conceptual capability. Backends
 * populate only the keys they actually support — callers probe via
 * optional chaining (`caps?.lifecycle?.loadModel(...)`) and handle
 * the missing-capability case without throwing.
 *
 * Design rationale:
 * - ONE method on `ApiBackend` keeps the interface surface small.
 * - Grouping capabilities under named keys keeps the record
 *   self-describing — a future model-browser UI can introspect
 *   `caps` and render conditional controls without knowing method
 *   names in advance.
 * - Optional keys (not optional methods on ApiBackend directly)
 *   avoid forcing unrelated backends to implement no-op stubs just
 *   to satisfy TypeScript.
 *
 * Future capabilities land here as new keys (LoRA adapters,
 * registry listings, batch inference). The abstraction does not
 * need to evolve in lockstep with every new capability — adding a
 * key is a pure addition and the existing callers stay unchanged.
 */
export interface BackendCapabilities {
  /**
   * OAI-compat fallback (v0.63.1). When the backend is talking
   * `/v1/chat/completions` to a host that also speaks a richer
   * native protocol (canonically Ollama's `/api/chat`), this
   * capability lets `SideCarClient` retry a failing OAI-compat
   * request against the native endpoint before surfacing the error.
   *
   * Implementations gate on a lightweight host probe so backends
   * pointed at non-Ollama OAI-compat hosts (OpenAI, LM Studio,
   * together.ai) never attempt the fallback — `matches(err)` must
   * return false in those cases.
   */
  oaiCompatFallback?: {
    /**
     * Decide whether an error surfaced by the primary streamChat /
     * complete path should trigger a native-protocol retry.
     * Implementations return true for errors that plausibly indicate
     * "OAI-compat layer glitched on an otherwise-healthy host" —
     * typically 502 / 503 / 504 / malformed response — and false
     * for genuine failures like 401 auth errors or network timeouts
     * (those should propagate so the circuit breaker can do its job).
     */
    matches(err: unknown): boolean;
    /**
     * Retry `streamChat` against the native protocol. Same signature
     * as `ApiBackend.streamChat` so the client can just await-for-of
     * the result in place of the failed primary call.
     */
    fallbackStreamChat(
      model: string,
      systemPrompt: string,
      messages: ChatMessage[],
      signal?: AbortSignal,
      tools?: ToolDefinition[],
    ): AsyncGenerator<StreamEvent>;
    /** Matching fallback for the non-streaming `complete` path. */
    fallbackComplete(
      model: string,
      systemPrompt: string,
      messages: ChatMessage[],
      maxTokens: number,
      signal?: AbortSignal,
    ): Promise<string>;
  };

  /**
   * Model-lifecycle management (v0.63.1). Canonical implementation
   * is Kickstand — its `/api/v1/models/{id}/load` and `/unload`
   * endpoints let users hot-swap which model is loaded without
   * leaving VS Code. The abstraction leaves room for Ollama
   * (`ollama run` / `ollama stop`) and future backends with
   * similar semantics.
   *
   * Not every lifecycle method is available on every backend that
   * has SOME lifecycle support — `listLoadable` is optional because
   * some backends can only load by exact ID without a discovery API.
   */
  lifecycle?: {
    /**
     * Load a model into memory / make it ready to serve. Returns
     * a human-readable status line the caller can surface in the
     * UI (e.g., "Loaded qwen3-coder:30b in 2.3s"). Implementations
     * throw on failure — the caller wraps in vscode.window.withProgress
     * and catches for toast / log display.
     */
    loadModel(id: string, opts?: { timeoutMs?: number }): Promise<string>;
    /** Unload a model to free memory / GPU resources. */
    unloadModel(id: string): Promise<string>;
    /**
     * Optional: enumerate models known to the backend that can be
     * loaded on demand. When present, the command-palette flow shows
     * these in a QuickPick; when absent, the flow falls back to
     * free-text model-ID input.
     */
    listLoadable?(): Promise<{ id: string; loaded: boolean; sizeBytes?: number }[]>;
  };

  /**
   * LoRA adapter management (v0.65.2). Lets users hot-swap fine-tuning
   * adapters on a loaded model without leaving VS Code.
   * Currently implemented by Kickstand via its /api/v1/models/{id}/lora endpoints.
   */
  loraAdapters?: {
    /** List adapters currently loaded on a model. */
    listAdapters(modelId: string): Promise<{ id: string; path: string; scale: number }[]>;
    /** Load a LoRA adapter onto a loaded model. Returns a human-readable status. */
    loadAdapter(modelId: string, adapterPath: string, scale?: number): Promise<string>;
    /** Unload a LoRA adapter from a model. */
    unloadAdapter(modelId: string, adapterId: string): Promise<string>;
  };

  /**
   * Model browser / discovery (v0.65.2). Search HuggingFace and pull
   * models directly from VS Code. Kickstand wraps HuggingFace Hub.
   */
  modelBrowser?: {
    /** Browse files in a HuggingFace repo. */
    browseRepo(repo: string): Promise<{ filename: string; sizeBytes: number; quant?: string; format: string }[]>;
    /** Search HuggingFace for models. */
    searchModels?(query: string): Promise<{ id: string; downloads: number; description?: string }[]>;
  };
}
