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

export function getEnableInlineCompletions(): boolean {
  return workspace.getConfiguration('sidecar').get<boolean>('enableInlineCompletions', false);
}

export function getCompletionModel(): string {
  return workspace.getConfiguration('sidecar').get<string>('completionModel', '');
}

export function getCompletionMaxTokens(): number {
  return workspace.getConfiguration('sidecar').get<number>('completionMaxTokens', 256);
}
