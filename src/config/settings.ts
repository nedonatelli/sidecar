import { workspace, type ExtensionContext } from 'vscode';

// ---------------------------------------------------------------------------
// Secret storage for API keys
// ---------------------------------------------------------------------------
// API keys are stored in VS Code's SecretStorage instead of plaintext
// settings.json. On first activation we migrate any plaintext value into
// SecretStorage and clear it from settings.

const SECRET_KEY_API = 'sidecar.apiKey';
const SECRET_KEY_FALLBACK_API = 'sidecar.fallbackApiKey';
const SECRET_KEY_HF_TOKEN = 'sidecar.huggingfaceToken';

let _secretContext: ExtensionContext | null = null;
let _cachedApiKey: string | null = null;
let _cachedFallbackApiKey: string | null = null;

/**
 * Initialize SecretStorage from extension context. Reads existing secrets,
 * migrates any plaintext values from settings.json into SecretStorage,
 * and caches them for synchronous access via getConfig().
 */
export async function initSecrets(context: ExtensionContext): Promise<void> {
  _secretContext = context;
  const cfg = workspace.getConfiguration('sidecar');

  // Migrate apiKey: if a non-default plaintext value exists, move it
  const existing = await context.secrets.get(SECRET_KEY_API);
  if (existing) {
    _cachedApiKey = existing;
  } else {
    const plaintext = cfg.get<string>('apiKey', 'ollama');
    if (plaintext && plaintext !== 'ollama') {
      await context.secrets.store(SECRET_KEY_API, plaintext);
      _cachedApiKey = plaintext;
      // Clear plaintext value
      await cfg.update('apiKey', undefined, true).then(undefined, () => undefined);
    } else {
      _cachedApiKey = plaintext;
    }
  }

  // Migrate fallbackApiKey similarly
  const existingFb = await context.secrets.get(SECRET_KEY_FALLBACK_API);
  if (existingFb) {
    _cachedFallbackApiKey = existingFb;
  } else {
    const plaintextFb = cfg.get<string>('fallbackApiKey', '');
    if (plaintextFb) {
      await context.secrets.store(SECRET_KEY_FALLBACK_API, plaintextFb);
      _cachedFallbackApiKey = plaintextFb;
      await cfg.update('fallbackApiKey', undefined, true).then(undefined, () => undefined);
    } else {
      _cachedFallbackApiKey = plaintextFb;
    }
  }

  _cachedConfig = null; // invalidate config cache to pick up the secrets
}

/** Update the API key in SecretStorage and refresh the cache. Used by the "Set API Key" command. */
export async function setApiKeySecret(value: string): Promise<void> {
  if (!_secretContext) throw new Error('SecretStorage not initialized');
  await _secretContext.secrets.store(SECRET_KEY_API, value);
  _cachedApiKey = value;
  _cachedConfig = null;
}

/** Update the fallback API key in SecretStorage and refresh the cache. */
export async function setFallbackApiKeySecret(value: string): Promise<void> {
  if (!_secretContext) throw new Error('SecretStorage not initialized');
  await _secretContext.secrets.store(SECRET_KEY_FALLBACK_API, value);
  _cachedFallbackApiKey = value;
  _cachedConfig = null;
}

/**
 * Fetch the HuggingFace token from SecretStorage. Used by the safetensors
 * import flow to authenticate downloads of gated models (Llama, Gemma, etc.).
 * Returns undefined if no token has been set.
 */
export async function getHuggingFaceToken(): Promise<string | undefined> {
  if (!_secretContext) return undefined;
  return (await _secretContext.secrets.get(SECRET_KEY_HF_TOKEN)) ?? undefined;
}

/** Store the HuggingFace token in SecretStorage. */
export async function setHuggingFaceToken(value: string): Promise<void> {
  if (!_secretContext) throw new Error('SecretStorage not initialized');
  await _secretContext.secrets.store(SECRET_KEY_HF_TOKEN, value);
}

/** Remove the HuggingFace token from SecretStorage. */
export async function clearHuggingFaceToken(): Promise<void> {
  if (!_secretContext) return;
  await _secretContext.secrets.delete(SECRET_KEY_HF_TOKEN);
}

// ---------------------------------------------------------------------------
// Backend profiles — one-click switching between Ollama / Anthropic /
// Kickstand without hand-editing four separate settings.
// ---------------------------------------------------------------------------

export interface BackendProfile {
  /** Stable identifier used in messages and SecretStorage keys. */
  id: string;
  /** Human-readable label shown in the chat menu. */
  name: string;
  /** Provider type the client will instantiate. */
  provider: 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks';
  /** API base URL to bake into sidecar.baseUrl. */
  baseUrl: string;
  /** Default model to select when switching to this profile. */
  defaultModel: string;
  /** SecretStorage key for this profile's API key. `null` means no key (local Ollama). */
  secretKey: string | null;
  /** Short description shown in the menu under the name. */
  description: string;
}

export const BUILT_IN_BACKEND_PROFILES: readonly BackendProfile[] = [
  {
    id: 'local-ollama',
    name: 'Local Ollama',
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'qwen2.5-coder:7b',
    secretKey: null,
    description: 'Self-hosted models via Ollama (free, private, no API key required)',
  },
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-sonnet-4-6',
    secretKey: 'sidecar.profileKey.anthropic',
    description: 'Claude via the Anthropic API (pay-per-token, requires API key from platform.claude.com)',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    provider: 'openai',
    baseUrl: 'https://api.openai.com',
    defaultModel: 'gpt-4o',
    secretKey: 'sidecar.profileKey.openai',
    description: 'GPT models via the OpenAI API (pay-per-token, requires API key from platform.openai.com)',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'anthropic/claude-sonnet-4.5',
    secretKey: 'sidecar.profileKey.openrouter',
    description:
      'One key unlocks hundreds of models across providers (Anthropic, OpenAI, Google, Mistral, Meta, and more). Requires an API key from openrouter.ai/keys. Per-model pricing pulled live from their catalog.',
  },
  {
    id: 'groq',
    name: 'Groq',
    provider: 'groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    secretKey: 'sidecar.profileKey.groq',
    description:
      'Groq LPU inference — thousands of tokens/sec on open-weight models like Llama 3.3, Mixtral, DeepSeek R1 distills. Free tier with rate limits; paid tier for higher throughput. Requires an API key from console.groq.com.',
  },
  {
    id: 'fireworks',
    name: 'Fireworks',
    provider: 'fireworks',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    defaultModel: 'accounts/fireworks/models/qwen2p5-coder-32b-instruct',
    secretKey: 'sidecar.profileKey.fireworks',
    description:
      'Fireworks serves open-weight models (DeepSeek V3, Qwen 2.5 Coder, Llama 3.3, Mixtral) via a fast OpenAI-compatible endpoint. Cheaper than OpenAI for comparable capability. Requires an API key from fireworks.ai.',
  },
  {
    id: 'kickstand',
    name: 'Kickstand (coming soon)',
    provider: 'kickstand',
    baseUrl: 'http://localhost:11435',
    defaultModel: '',
    secretKey: null,
    description:
      'Self-hosted Kickstand LLM client backend — not yet officially released. The backend code ships today for anyone running a local dev build, but the first-party Kickstand release is still in progress.',
  },
] as const;

/** Match the current baseUrl against a built-in profile, if any. */
export function detectActiveProfile(baseUrl: string): BackendProfile | null {
  return BUILT_IN_BACKEND_PROFILES.find((p) => p.baseUrl === baseUrl) ?? null;
}

/**
 * Apply a backend profile: write baseUrl / provider / model into workspace
 * config and copy the profile's stored secret (if any) into the active
 * `sidecar.apiKey` secret so runtime picks it up. Returns a status hint
 * the caller can surface to the user.
 */
export async function applyBackendProfile(
  profile: BackendProfile,
): Promise<{ status: 'applied' | 'missing-key'; message: string }> {
  if (!_secretContext) throw new Error('SecretStorage not initialized');
  const cfg = workspace.getConfiguration('sidecar');

  await cfg.update('provider', profile.provider, true);
  await cfg.update('baseUrl', profile.baseUrl, true);
  if (profile.defaultModel) {
    await cfg.update('model', profile.defaultModel, true);
  }

  if (profile.secretKey) {
    const stored = await _secretContext.secrets.get(profile.secretKey);
    if (!stored) {
      return {
        status: 'missing-key',
        message: `Switched to ${profile.name}, but no API key is stored for this profile yet. Run "SideCar: Set API Key" to set it, then switch again.`,
      };
    }
    await _secretContext.secrets.store(SECRET_KEY_API, stored);
    _cachedApiKey = stored;
  } else {
    // Local profiles with no key — reset to the harmless default string
    await _secretContext.secrets.store(SECRET_KEY_API, 'ollama');
    _cachedApiKey = 'ollama';
  }

  _cachedConfig = null;
  return { status: 'applied', message: `Switched to ${profile.name} (${profile.defaultModel || 'no default model'})` };
}

/**
 * Save an API key for a specific profile. Used by the "Set API Key" flow
 * when the user is currently on a profile with a non-null `secretKey`.
 * Also copies it into the active slot so it takes effect immediately.
 */
export async function setProfileApiKey(profile: BackendProfile, value: string): Promise<void> {
  if (!_secretContext) throw new Error('SecretStorage not initialized');
  if (!profile.secretKey) return;
  await _secretContext.secrets.store(profile.secretKey, value);
  await _secretContext.secrets.store(SECRET_KEY_API, value);
  _cachedApiKey = value;
  _cachedConfig = null;
}

/**
 * Check whether a base URL points to a local Ollama instance.
 */
export function isLocalOllama(baseUrl: string): boolean {
  return baseUrl.includes('localhost:11434') || baseUrl.includes('127.0.0.1:11434');
}

export function isAnthropic(baseUrl: string): boolean {
  return baseUrl.includes('anthropic.com');
}

export function isKickstand(baseUrl: string): boolean {
  return baseUrl.includes('localhost:11435') || baseUrl.includes('127.0.0.1:11435');
}

/**
 * Check whether a base URL points at OpenRouter. Matches both the
 * canonical `openrouter.ai` host and any user-supplied proxy that
 * contains `openrouter` in the hostname.
 */
export function isOpenRouter(baseUrl: string): boolean {
  return baseUrl.includes('openrouter.ai');
}

/**
 * Check whether a base URL points at Groq. Matches `api.groq.com`
 * and any user-supplied proxy containing `groq.com`.
 */
export function isGroq(baseUrl: string): boolean {
  return baseUrl.includes('groq.com');
}

/**
 * Check whether a base URL points at Fireworks. Matches
 * `api.fireworks.ai` and any proxy containing `fireworks.ai`.
 */
export function isFireworks(baseUrl: string): boolean {
  return baseUrl.includes('fireworks.ai');
}

/** Determine which backend provider to use based on URL and explicit setting. */
export function detectProvider(
  baseUrl: string,
  provider: 'auto' | 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks',
): 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks' {
  if (provider !== 'auto') return provider;
  if (isLocalOllama(baseUrl)) return 'ollama';
  if (isAnthropic(baseUrl)) return 'anthropic';
  if (isKickstand(baseUrl)) return 'kickstand';
  if (isOpenRouter(baseUrl)) return 'openrouter';
  if (isGroq(baseUrl)) return 'groq';
  if (isFireworks(baseUrl)) return 'fireworks';
  return 'openai';
}

// ---------------------------------------------------------------------------
// Typed configuration
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
  /** Transport type: "stdio" (default), "http", or "sse" */
  type?: 'stdio' | 'http' | 'sse';
  /** Command to spawn (stdio transport) */
  command?: string;
  /** Arguments for the command (stdio transport) */
  args?: string[];
  /** Environment variables (stdio transport, or extra headers source) */
  env?: Record<string, string>;
  /** URL for HTTP/SSE transport */
  url?: string;
  /** Custom headers for HTTP/SSE transport */
  headers?: Record<string, string>;
  /** Per-tool overrides: enable/disable specific tools */
  tools?: Record<string, { enabled?: boolean }>;
  /** Maximum result size in characters (default 50000) */
  maxResultChars?: number;
}

export interface HookConfig {
  pre?: string;
  post?: string;
}

export interface ScheduledTask {
  name: string;
  intervalMinutes: number;
  prompt: string;
  enabled: boolean;
}

export interface EventHookConfig {
  onSave?: string;
  onCreate?: string;
  onDelete?: string;
}

export interface CustomToolConfig {
  name: string;
  description: string;
  command: string;
}

export interface CustomModeConfig {
  name: string;
  description: string;
  systemPrompt: string;
  approvalBehavior: 'autonomous' | 'cautious' | 'manual';
  toolPermissions?: Record<string, 'allow' | 'deny' | 'ask'>;
}

const BUILT_IN_MODES = ['autonomous', 'cautious', 'manual', 'plan', 'review'] as const;

/** Resolve an agentMode string to its effective approval behavior, system prompt, and tool permissions. */
export function resolveMode(
  agentMode: string,
  customModes: CustomModeConfig[],
): {
  approvalBehavior: 'autonomous' | 'cautious' | 'manual' | 'plan' | 'review';
  systemPrompt: string;
  toolPermissions: Record<string, 'allow' | 'deny' | 'ask'>;
  isCustom: boolean;
} {
  if ((BUILT_IN_MODES as readonly string[]).includes(agentMode)) {
    return {
      approvalBehavior: agentMode as 'autonomous' | 'cautious' | 'manual' | 'plan' | 'review',
      systemPrompt: '',
      toolPermissions: {},
      isCustom: false,
    };
  }
  const custom = customModes.find((m) => m.name === agentMode);
  if (custom) {
    return {
      approvalBehavior: custom.approvalBehavior,
      systemPrompt: custom.systemPrompt,
      toolPermissions: custom.toolPermissions || {},
      isCustom: true,
    };
  }
  // Unknown mode — fall back to cautious
  return { approvalBehavior: 'cautious', systemPrompt: '', toolPermissions: {}, isCustom: false };
}

export interface SideCarConfig {
  model: string;
  provider: 'auto' | 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks';
  systemPrompt: string;
  baseUrl: string;
  apiKey: string;
  includeActiveFile: boolean;
  agentMode: string;
  agentTemperature: number;
  agentMaxIterations: number;
  agentMaxMessages: number;
  agentMaxTokens: number;
  enableInlineCompletions: boolean;
  completionModel: string;
  completionMaxTokens: number;
  completionDebounceMs: number;
  toolPermissions: Record<string, 'allow' | 'deny' | 'ask'>;
  hooks: Record<string, HookConfig>;
  eventHooks: EventHookConfig;
  scheduledTasks: ScheduledTask[];
  customTools: CustomToolConfig[];
  customModes: CustomModeConfig[];
  mcpServers: Record<string, MCPServerConfig>;
  verboseMode: boolean;
  expandThinking: boolean;
  enableMermaid: boolean;
  chatDensity: 'compact' | 'normal' | 'comfortable';
  chatFontSize: number;
  chatAccentColor: string;
  terminalErrorInterception: boolean;
  jsDocSyncEnabled: boolean;
  readmeSyncEnabled: boolean;
  requestTimeout: number;
  shellTimeout: number;
  shellMaxOutputMB: number;
  pinnedContext: string[];
  autoFixOnFailure: boolean;
  autoFixMaxRetries: number;
  completionGateEnabled: boolean;
  criticEnabled: boolean;
  criticModel: string;
  criticBlockOnHighSeverity: boolean;
  fetchUrlContext: boolean;
  fallbackBaseUrl: string;
  fallbackApiKey: string;
  fallbackModel: string;
  dailyBudget: number;
  weeklyBudget: number;
  /* Large file & monorepo handling */
  workspaceRoots: string[];
  maxFileSizeBytes: number;
  streamingReadThreshold: number;
  maxTraversalDepth: number;
  enableLazyIndexing: boolean;
  maxIndexedFiles: number;
  /* RAG and documentation retrieval */
  enableDocumentationRAG: boolean;
  ragMaxDocEntries: number;
  ragUpdateIntervalMinutes: number;
  /* Agent memory and learning */
  enableAgentMemory: boolean;
  agentMemoryMaxEntries: number;
  /* Semantic search */
  enableSemanticSearch: boolean;
  semanticSearchWeight: number;
  /* Background agents */
  bgMaxConcurrent: number;
  /* Prompt pruning (paid backends) */
  promptPruningEnabled: boolean;
  promptPruningMaxToolResultTokens: number;
  /* Hybrid delegation to local Ollama worker (paid backends only) */
  delegateTaskEnabled: boolean;
  delegateTaskWorkerModel: string;
  delegateTaskWorkerBaseUrl: string;
  /**
   * Hard cap on iterations a delegated worker agent may run. The
   * worker is intentionally focused on read-only research, so a
   * tight cap protects against runaway loops. The main agent loop
   * uses `agentMaxIterations` instead.
   */
  delegateTaskMaxIterations: number;
  /* Outbound exfiltration defense */
  outboundAllowlist: string[];
}

/**
 * Read all SideCar settings from workspace configuration.
 * Results are cached and invalidated automatically when settings change.
 */
let _cachedConfig: SideCarConfig | null = null;

// Invalidate cache when VS Code settings change.
// Guard for test environments where workspace API may not be fully available.
try {
  workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('sidecar')) {
      _cachedConfig = null;
    }
  });
} catch {
  // Not in a VS Code environment (e.g., unit tests) — cache will be rebuilt on each call
}

/** Clamp a number to a minimum value, falling back to the default if invalid. */
export function clampMin(value: number | undefined, min: number, fallback: number): number {
  if (value === undefined || typeof value !== 'number' || isNaN(value)) return fallback;
  return Math.max(min, value);
}

function readConfig(): SideCarConfig {
  const cfg = workspace.getConfiguration('sidecar');
  return {
    model: cfg.get<string>('model', 'qwen3-coder:30b') || 'qwen3-coder:30b',
    provider: cfg.get<'auto' | 'ollama' | 'anthropic' | 'openai' | 'kickstand' | 'openrouter' | 'groq' | 'fireworks'>(
      'provider',
      'auto',
    ),
    systemPrompt: cfg.get<string>('systemPrompt', ''),
    baseUrl: cfg.get<string>('baseUrl', 'http://localhost:11434') || 'http://localhost:11434',
    apiKey: _cachedApiKey ?? cfg.get<string>('apiKey', 'ollama'),
    includeActiveFile: cfg.get<boolean>('includeActiveFile', true),
    agentMode: cfg.get<string>('agentMode', 'cautious'),
    agentTemperature: clampMin(cfg.get<number>('agentTemperature'), 0, 0.2),
    agentMaxIterations: clampMin(cfg.get<number>('agentMaxIterations'), 1, 50),
    agentMaxMessages: clampMin(cfg.get<number>('agentMaxMessages'), 5, 100),
    agentMaxTokens: clampMin(cfg.get<number>('agentMaxTokens'), 1000, 100000),
    enableInlineCompletions: cfg.get<boolean>('enableInlineCompletions', false),
    completionModel: cfg.get<string>('completionModel', ''),
    completionMaxTokens: clampMin(cfg.get<number>('completionMaxTokens'), 1, 256),
    completionDebounceMs: clampMin(cfg.get<number>('completionDebounceMs'), 0, 300),
    toolPermissions: cfg.get<Record<string, 'allow' | 'deny' | 'ask'>>('toolPermissions', {}),
    hooks: cfg.get<Record<string, HookConfig>>('hooks', {}),
    eventHooks: cfg.get<EventHookConfig>('eventHooks', {}),
    scheduledTasks: cfg.get<ScheduledTask[]>('scheduledTasks', []),
    customTools: cfg.get<CustomToolConfig[]>('customTools', []),
    customModes: cfg.get<CustomModeConfig[]>('customModes', []),
    mcpServers: cfg.get<Record<string, MCPServerConfig>>('mcpServers', {}),
    verboseMode: cfg.get<boolean>('verboseMode', false),
    expandThinking: cfg.get<boolean>('expandThinking', false),
    enableMermaid: cfg.get<boolean>('enableMermaid', true),
    chatDensity: cfg.get<'compact' | 'normal' | 'comfortable'>('chatDensity', 'normal'),
    chatFontSize: clampMin(cfg.get<number>('chatFontSize'), 10, 13),
    chatAccentColor: cfg.get<string>('chatAccentColor', ''),
    terminalErrorInterception: cfg.get<boolean>('terminalErrorInterception', true),
    jsDocSyncEnabled: cfg.get<boolean>('jsDocSync.enabled', true),
    readmeSyncEnabled: cfg.get<boolean>('readmeSync.enabled', true),
    requestTimeout: clampMin(cfg.get<number>('requestTimeout'), 0, 120),
    shellTimeout: clampMin(cfg.get<number>('shellTimeout'), 1, 120),
    shellMaxOutputMB: clampMin(cfg.get<number>('shellMaxOutputMB'), 1, 10),
    pinnedContext: cfg.get<string[]>('pinnedContext', []),
    autoFixOnFailure: cfg.get<boolean>('autoFixOnFailure', false),
    autoFixMaxRetries: clampMin(cfg.get<number>('autoFixMaxRetries'), 0, 3),
    completionGateEnabled: cfg.get<boolean>('completionGate.enabled', true),
    criticEnabled: cfg.get<boolean>('critic.enabled', false),
    criticModel: cfg.get<string>('critic.model', ''),
    criticBlockOnHighSeverity: cfg.get<boolean>('critic.blockOnHighSeverity', true),
    fetchUrlContext: cfg.get<boolean>('fetchUrlContext', true),
    fallbackBaseUrl: cfg.get<string>('fallbackBaseUrl', ''),
    fallbackApiKey: _cachedFallbackApiKey ?? cfg.get<string>('fallbackApiKey', ''),
    fallbackModel: cfg.get<string>('fallbackModel', ''),
    dailyBudget: clampMin(cfg.get<number>('dailyBudget'), 0, 0),
    weeklyBudget: clampMin(cfg.get<number>('weeklyBudget'), 0, 0),
    /* Large file & monorepo handling */
    workspaceRoots: cfg.get<string[]>('workspaceRoots', []),
    maxFileSizeBytes: clampMin(cfg.get<number>('maxFileSizeBytes'), 10240, 100 * 1024),
    streamingReadThreshold: clampMin(cfg.get<number>('streamingReadThreshold'), 10240, 50 * 1024),
    maxTraversalDepth: clampMin(cfg.get<number>('maxTraversalDepth'), 1, 10),
    enableLazyIndexing: cfg.get<boolean>('enableLazyIndexing', true),
    maxIndexedFiles: clampMin(cfg.get<number>('maxIndexedFiles'), 10, 1000),
    /* RAG and documentation retrieval */
    enableDocumentationRAG: cfg.get<boolean>('enableDocumentationRAG', true),
    ragMaxDocEntries: clampMin(cfg.get<number>('ragMaxDocEntries'), 1, 20),
    ragUpdateIntervalMinutes: clampMin(cfg.get<number>('ragUpdateIntervalMinutes'), 5, 360),
    /* Agent memory and learning */
    enableAgentMemory: cfg.get<boolean>('enableAgentMemory', true),
    agentMemoryMaxEntries: clampMin(cfg.get<number>('agentMemoryMaxEntries'), 10, 500),
    /* Semantic search */
    enableSemanticSearch: cfg.get<boolean>('enableSemanticSearch', true),
    semanticSearchWeight: Math.max(0, Math.min(1, cfg.get<number>('semanticSearchWeight', 0.6))),
    bgMaxConcurrent: clampMin(cfg.get<number>('bgMaxConcurrent'), 1, 3),
    /* Prompt pruning (paid backends) */
    promptPruningEnabled: cfg.get<boolean>('promptPruning.enabled', true),
    promptPruningMaxToolResultTokens: clampMin(cfg.get<number>('promptPruning.maxToolResultTokens'), 200, 2000),
    /* Hybrid delegation to local Ollama worker */
    delegateTaskEnabled: cfg.get<boolean>('delegateTask.enabled', true),
    delegateTaskWorkerModel: cfg.get<string>('delegateTask.workerModel', ''),
    delegateTaskWorkerBaseUrl: cfg.get<string>('delegateTask.workerBaseUrl', 'http://localhost:11434'),
    delegateTaskMaxIterations: clampMin(cfg.get<number>('delegateTask.maxIterations'), 1, 10),
    /* Outbound exfiltration defense */
    outboundAllowlist: cfg.get<string[]>('outboundAllowlist', []),
  };
}

export function getConfig(): SideCarConfig {
  if (!_cachedConfig) {
    _cachedConfig = readConfig();
  }
  return _cachedConfig;
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

import modelCostsJson from './modelCosts.json';

type ModelCostEntry = { input: number; output: number };

/** Static cost table from `src/config/modelCosts.json` — the fallback. */
const STATIC_MODEL_COSTS: Record<string, ModelCostEntry> = (
  modelCostsJson as { models: Record<string, ModelCostEntry> }
).models;

/**
 * Runtime overlay populated by provider catalogs (currently OpenRouter).
 * Keyed on the model id exactly as the provider returns it, so a full-
 * qualified lookup like `anthropic/claude-sonnet-4.5` hits this map
 * before falling through to the substring match against STATIC_MODEL_COSTS.
 *
 * Values are in USD per 1M tokens (same unit as the static table) so
 * `estimateCost`'s arithmetic works unchanged regardless of source.
 */
const RUNTIME_MODEL_COSTS = new Map<string, ModelCostEntry>();

const warnedUnknownModels = new Set<string>();

/**
 * Register a runtime cost entry from a provider catalog. Intended to be
 * called during extension activation (or whenever the catalog refreshes)
 * by code that just fetched per-model pricing from an upstream API.
 *
 * Input is already in USD-per-1M-tokens units. OpenRouter returns USD-
 * per-single-token strings, so the caller is responsible for the scale
 * conversion — see `ingestOpenRouterCatalog` below.
 */
export function registerModelCost(modelId: string, cost: ModelCostEntry): void {
  RUNTIME_MODEL_COSTS.set(modelId, cost);
  // A model that was previously unknown and warned about should not
  // keep suppressing warnings after pricing arrives — but conversely,
  // suddenly erroring about a now-known model would be silly. Simply
  // clear the warning so a future unknown lookup surfaces again if
  // needed.
  warnedUnknownModels.delete(modelId);
}

/**
 * Test-only: reset the once-per-model warning state.
 * Safe to call in production but no reason to.
 */
export function _resetUnknownModelWarnings(): void {
  warnedUnknownModels.clear();
}

/**
 * Test-only: drop every runtime-registered model cost.
 * Keeps tests isolated from each other when they exercise the overlay.
 */
export function _resetRuntimeModelCosts(): void {
  RUNTIME_MODEL_COSTS.clear();
}

/**
 * Ingest an OpenRouter `/v1/models` catalog payload into the runtime
 * cost overlay. OpenRouter returns pricing as decimal strings in USD
 * per single token (e.g. "0.000003" for $3/M), so we multiply by 1M
 * before storing to match the per-1M-token scale the rest of the code
 * uses. Entries with missing or malformed pricing are skipped silently.
 *
 * Returns the number of models successfully registered so the caller
 * can log a one-line summary on extension startup.
 */
export function ingestOpenRouterCatalog(
  models: Array<{ id: string; pricing?: { prompt?: string; completion?: string } }>,
): number {
  let registered = 0;
  for (const m of models) {
    const promptStr = m.pricing?.prompt;
    const completionStr = m.pricing?.completion;
    if (!promptStr || !completionStr) continue;
    const promptPerToken = Number.parseFloat(promptStr);
    const completionPerToken = Number.parseFloat(completionStr);
    if (!Number.isFinite(promptPerToken) || !Number.isFinite(completionPerToken)) continue;
    registerModelCost(m.id, {
      input: promptPerToken * 1_000_000,
      output: completionPerToken * 1_000_000,
    });
    registered++;
  }
  return registered;
}

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  // 1. Exact-id hit in the runtime overlay — OpenRouter-style
  //    `provider/model` ids live here after ingestOpenRouterCatalog.
  const runtime = RUNTIME_MODEL_COSTS.get(model);
  if (runtime) {
    return (inputTokens * runtime.input + outputTokens * runtime.output) / 1_000_000;
  }

  // 2. Substring match against the static table — catches
  //    `models/claude-sonnet-4-6` → `claude-sonnet-4-6` etc.
  const key = Object.keys(STATIC_MODEL_COSTS).find((k) => model.includes(k));
  if (key) {
    const costs = STATIC_MODEL_COSTS[key];
    return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
  }

  // 3. Unknown — warn once and return null.
  if (!warnedUnknownModels.has(model)) {
    warnedUnknownModels.add(model);
    console.warn(
      `[SideCar cost] unknown model '${model}' — cost estimate unavailable. ` +
        `Add pricing to src/config/modelCosts.json or register it via an OpenRouter catalog ingest.`,
    );
  }
  return null;
}
