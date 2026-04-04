import { workspace } from 'vscode';

export function getModel(): string {
  return workspace.getConfiguration('sidecar').get<string>('model', 'qwen3-coder');
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
