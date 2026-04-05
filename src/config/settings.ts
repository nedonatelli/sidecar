import { workspace } from 'vscode';

// Cost per million tokens (input/output) for known models
const MODEL_COSTS: Record<string, { input: number; output: number }> = {
  'claude-opus-4-6': { input: 15, output: 75 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 0.8, output: 4 },
};

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number | null {
  const key = Object.keys(MODEL_COSTS).find(k => model.includes(k));
  if (!key) return null; // Local model, free
  const costs = MODEL_COSTS[key];
  return (inputTokens * costs.input + outputTokens * costs.output) / 1_000_000;
}

export function getModel(): string {
  return workspace.getConfiguration('sidecar').get<string>('model', 'qwen3-coder:30b');
}

export function getSystemPrompt(): string {
  return workspace.getConfiguration('sidecar').get<string>('systemPrompt', '');
}

export function getBaseUrl(): string {
  return workspace.getConfiguration('sidecar').get<string>('baseUrl', 'http://localhost:11434');
}

export function getApiKey(): string {
  return workspace.getConfiguration('sidecar').get<string>('apiKey', 'ollama');
}

export interface MCPServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export function getToolPermissions(): Record<string, 'allow' | 'deny' | 'ask'> {
  return workspace.getConfiguration('sidecar').get<Record<string, 'allow' | 'deny' | 'ask'>>('toolPermissions', {});
}

export interface HookConfig {
  pre?: string;
  post?: string;
}

export function getHooks(): Record<string, HookConfig> {
  return workspace.getConfiguration('sidecar').get<Record<string, HookConfig>>('hooks', {});
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

export function getEventHooks(): EventHookConfig {
  return workspace.getConfiguration('sidecar').get<EventHookConfig>('eventHooks', {});
}

export function getScheduledTasks(): ScheduledTask[] {
  return workspace.getConfiguration('sidecar').get<ScheduledTask[]>('scheduledTasks', []);
}

export interface CustomToolConfig {
  name: string;
  description: string;
  command: string;
}

export function getCustomTools(): CustomToolConfig[] {
  return workspace.getConfiguration('sidecar').get<CustomToolConfig[]>('customTools', []);
}

export function getMCPServers(): Record<string, MCPServerConfig> {
  return workspace.getConfiguration('sidecar').get<Record<string, MCPServerConfig>>('mcpServers', {});
}

export function getPlanMode(): boolean {
  return workspace.getConfiguration('sidecar').get<boolean>('planMode', false);
}

export function getAgentMode(): 'cautious' | 'autonomous' | 'manual' {
  return workspace.getConfiguration('sidecar').get<'cautious' | 'autonomous' | 'manual'>('agentMode', 'cautious');
}

export function getAgentMaxIterations(): number {
  return workspace.getConfiguration('sidecar').get<number>('agentMaxIterations', 25);
}

export function getAgentMaxTokens(): number {
  return workspace.getConfiguration('sidecar').get<number>('agentMaxTokens', 100000);
}

export function getIncludeActiveFile(): boolean {
  return workspace.getConfiguration('sidecar').get<boolean>('includeActiveFile', true);
}

export function getEnableInlineCompletions(): boolean {
  return workspace.getConfiguration('sidecar').get<boolean>('enableInlineCompletions', false);
}

export function getCompletionModel(): string {
  return workspace.getConfiguration('sidecar').get<string>('completionModel', '');
}

export function getCompletionMaxTokens(): number {
  return workspace.getConfiguration('sidecar').get<number>('completionMaxTokens', 256);
}

export function getCompletionDebounceMs(): number {
  return workspace.getConfiguration('sidecar').get<number>('completionDebounceMs', 300);
}
