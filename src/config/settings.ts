import { workspace } from 'vscode';

/**
 * Check whether a base URL points to a local Ollama instance.
 */
export function isLocalOllama(baseUrl: string): boolean {
  return baseUrl.includes('localhost:11434') || baseUrl.includes('127.0.0.1:11434');
}

export function isAnthropic(baseUrl: string): boolean {
  return baseUrl.includes('anthropic.com');
}

/** Determine which backend provider to use based on URL and explicit setting. */
export function detectProvider(
  baseUrl: string,
  provider: 'auto' | 'ollama' | 'anthropic' | 'openai',
): 'ollama' | 'anthropic' | 'openai' {
  if (provider !== 'auto') return provider;
  if (isLocalOllama(baseUrl)) return 'ollama';
  if (isAnthropic(baseUrl)) return 'anthropic';
  return 'openai';
}

// ---------------------------------------------------------------------------
// Typed configuration
// ---------------------------------------------------------------------------

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
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

export interface SideCarConfig {
  model: string;
  provider: 'auto' | 'ollama' | 'anthropic' | 'openai';
  systemPrompt: string;
  baseUrl: string;
  apiKey: string;
  includeActiveFile: boolean;
  planMode: boolean;
  agentMode: 'cautious' | 'autonomous' | 'manual';
  agentMaxIterations: number;
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
  mcpServers: Record<string, MCPServerConfig>;
  verboseMode: boolean;
  expandThinking: boolean;
  requestTimeout: number;
  shellTimeout: number;
  shellMaxOutputMB: number;
  pinnedContext: string[];
  autoFixOnFailure: boolean;
  autoFixMaxRetries: number;
  fetchUrlContext: boolean;
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
function clampMin(value: number | undefined, min: number, fallback: number): number {
  if (value === undefined || typeof value !== 'number' || isNaN(value)) return fallback;
  return Math.max(min, value);
}

function readConfig(): SideCarConfig {
  const cfg = workspace.getConfiguration('sidecar');
  return {
    model: cfg.get<string>('model', 'qwen3-coder:30b') || 'qwen3-coder:30b',
    provider: cfg.get<'auto' | 'ollama' | 'anthropic' | 'openai'>('provider', 'auto'),
    systemPrompt: cfg.get<string>('systemPrompt', ''),
    baseUrl: cfg.get<string>('baseUrl', 'http://localhost:11434') || 'http://localhost:11434',
    apiKey: cfg.get<string>('apiKey', 'ollama'),
    includeActiveFile: cfg.get<boolean>('includeActiveFile', true),
    planMode: cfg.get<boolean>('planMode', false),
    agentMode: cfg.get<'cautious' | 'autonomous' | 'manual'>('agentMode', 'cautious'),
    agentMaxIterations: clampMin(cfg.get<number>('agentMaxIterations'), 1, 25),
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
    mcpServers: cfg.get<Record<string, MCPServerConfig>>('mcpServers', {}),
    verboseMode: cfg.get<boolean>('verboseMode', false),
    expandThinking: cfg.get<boolean>('expandThinking', false),
    requestTimeout: clampMin(cfg.get<number>('requestTimeout'), 0, 120),
    shellTimeout: clampMin(cfg.get<number>('shellTimeout'), 1, 120),
    shellMaxOutputMB: clampMin(cfg.get<number>('shellMaxOutputMB'), 1, 10),
    pinnedContext: cfg.get<string[]>('pinnedContext', []),
    autoFixOnFailure: cfg.get<boolean>('autoFixOnFailure', false),
    autoFixMaxRetries: clampMin(cfg.get<number>('autoFixMaxRetries'), 0, 3),
    fetchUrlContext: cfg.get<boolean>('fetchUrlContext', true),
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

const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 0.8, output: 4 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const key = Object.keys(MODEL_COSTS).find((k) => model.includes(k));
  if (!key) return null;
  const costs = MODEL_COSTS[key];
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}
