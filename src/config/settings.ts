import { workspace } from 'vscode';

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
