import { workspace } from 'vscode';

/**
 * Check whether a base URL points to a local Ollama instance.
 */
export function isLocalOllama(baseUrl: string): boolean {
  return baseUrl.includes('localhost:11434') || baseUrl.includes('127.0.0.1:11434');
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
  shellTimeout: number;
  shellMaxOutputMB: number;
}

/**
 * Read all SideCar settings from workspace configuration in a single call.
 */
export function getConfig(): SideCarConfig {
  const cfg = workspace.getConfiguration('sidecar');
  return {
    model: cfg.get<string>('model', 'qwen3-coder:30b'),
    systemPrompt: cfg.get<string>('systemPrompt', ''),
    baseUrl: cfg.get<string>('baseUrl', 'http://localhost:11434'),
    apiKey: cfg.get<string>('apiKey', 'ollama'),
    includeActiveFile: cfg.get<boolean>('includeActiveFile', true),
    planMode: cfg.get<boolean>('planMode', false),
    agentMode: cfg.get<'cautious' | 'autonomous' | 'manual'>('agentMode', 'cautious'),
    agentMaxIterations: cfg.get<number>('agentMaxIterations', 25),
    agentMaxTokens: cfg.get<number>('agentMaxTokens', 100000),
    enableInlineCompletions: cfg.get<boolean>('enableInlineCompletions', false),
    completionModel: cfg.get<string>('completionModel', ''),
    completionMaxTokens: cfg.get<number>('completionMaxTokens', 256),
    completionDebounceMs: cfg.get<number>('completionDebounceMs', 300),
    toolPermissions: cfg.get<Record<string, 'allow' | 'deny' | 'ask'>>('toolPermissions', {}),
    hooks: cfg.get<Record<string, HookConfig>>('hooks', {}),
    eventHooks: cfg.get<EventHookConfig>('eventHooks', {}),
    scheduledTasks: cfg.get<ScheduledTask[]>('scheduledTasks', []),
    customTools: cfg.get<CustomToolConfig[]>('customTools', []),
    mcpServers: cfg.get<Record<string, MCPServerConfig>>('mcpServers', {}),
    verboseMode: cfg.get<boolean>('verboseMode', false),
    expandThinking: cfg.get<boolean>('expandThinking', false),
    shellTimeout: cfg.get<number>('shellTimeout', 120),
    shellMaxOutputMB: cfg.get<number>('shellMaxOutputMB', 10),
  };
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
