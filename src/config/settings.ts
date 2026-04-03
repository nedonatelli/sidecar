import { workspace } from 'vscode';

export function getOllamaModel(): string {
  return workspace.getConfiguration('ollama').get<string>('model', 'llama3');
}

export function getOllamaSystemPrompt(): string {
  return workspace.getConfiguration('ollama').get<string>('systemPrompt', '');
}
