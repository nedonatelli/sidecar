import { workspace } from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

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
 * Read the Kickstand API token from ~/.config/kickstand/token
 */
export function readKickstandToken(): string {
  try {
    const tokenPath = path.join(os.homedir(), '.config', 'kickstand', 'token');
    if (fs.existsSync(tokenPath)) {
      return fs.readFileSync(tokenPath, 'utf-8').trim();
    }
  } catch (error) {
    console.warn('[Kickstand] Failed to read token file:', error);
  }
  return 'kickstand';
}

/** Determine which backend provider to use based on URL and explicit setting. */
export function detectProvider(
  baseUrl: string,
  provider: 'auto' | 'ollama' | 'anthropic' | 'openai' | 'kickstand',
): 'ollama' | 'anthropic' | 'openai' | 'kickstand' {
  if (provider !== 'auto') return provider;
  if (isLocalOllama(baseUrl)) return 'ollama';
  if (isAnthropic(baseUrl)) return 'anthropic';
  if (isKickstand(baseUrl)) return 'kickstand';
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

export interface SideCarConfig {
  model: string;
  provider: 'auto' | 'ollama' | 'anthropic' | 'openai' | 'kickstand';
  systemPrompt: string;
  baseUrl: string;
  apiKey: string;
  includeActiveFile: boolean;
  agentMode: 'cautious' | 'autonomous' | 'manual' | 'plan';
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
    provider: cfg.get<'auto' | 'ollama' | 'anthropic' | 'openai' | 'kickstand'>('provider', 'auto'),
    systemPrompt: cfg.get<string>('systemPrompt', ''),
    baseUrl: cfg.get<string>('baseUrl', 'http://localhost:11434') || 'http://localhost:11434',
    apiKey: cfg.get<string>('apiKey', 'ollama'),
    includeActiveFile: cfg.get<boolean>('includeActiveFile', true),
    agentMode: cfg.get<'cautious' | 'autonomous' | 'manual' | 'plan'>('agentMode', 'cautious'),
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
    fallbackBaseUrl: cfg.get<string>('fallbackBaseUrl', ''),
    fallbackApiKey: cfg.get<string>('fallbackApiKey', ''),
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
