import type { OllamaMessage, OllamaStreamChunk } from './types.js';

const OLLAMA_URL = 'http://localhost:11434';
const OLLAMA_API_CHAT = `${OLLAMA_URL}/api/chat`;
const OLLAMA_API_TAGS = `${OLLAMA_URL}/api/tags`;
const OLLAMA_API_PULL = `${OLLAMA_URL}/api/pull`;

const LIBRARY_MODELS = [
  'llama3',
  'llama3.1',
  'llama3.2',
  'mistral',
  'mixtral',
  'codellama',
  'phi3',
  'qwen2',
  'qwen2.5',
  'deepseek-coder',
  'nomic-embed-text',
  'llava',
  'gemma',
  'gemma2',
  'phi',
];

export interface InstalledModel {
  name: string;
  model: string;
  size?: number;
  digest?: string;
}

export interface LibraryModel {
  name: string;
  installed: boolean;
  installing?: boolean;
}

export interface PullProgress {
  model: string;
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
}

export class OllamaClient {
  private model: string;
  private systemPrompt: string;

  constructor(model: string = 'llama3', systemPrompt: string = '') {
    this.model = model;
    this.systemPrompt = systemPrompt;
  }

  async *streamChat(
    messages: OllamaMessage[],
    signal?: AbortSignal
  ): AsyncGenerator<OllamaStreamChunk> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
    };

    if (this.systemPrompt) {
      body.system = this.systemPrompt;
    }

    const response = await fetch(OLLAMA_API_CHAT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Ollama returned an empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter((line) => line.trim());

        for (const line of lines) {
          try {
            const parsed = JSON.parse(line) as OllamaStreamChunk;
            yield parsed;
            if (parsed.done) break;
          } catch {
            // Skip malformed JSON lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  updateModel(model: string) {
    this.model = model;
  }

  updateSystemPrompt(prompt: string) {
    this.systemPrompt = prompt;
  }

  async listInstalledModels(): Promise<InstalledModel[]> {
    const response = await fetch(OLLAMA_API_TAGS);
    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status}`);
    }
    const data = await response.json() as { models: InstalledModel[] };
    return data.models ?? [];
  }

  async listLibraryModels(): Promise<LibraryModel[]> {
    const installed = await this.listInstalledModels();
    const installedNames = new Set(installed.map((m) => m.name.split(':')[0]));

    // Start with all installed models (including custom ones)
    const results: LibraryModel[] = installed.map((m) => ({
      name: m.name,
      installed: true,
    }));

    // Add library models that aren't already installed
    for (const name of LIBRARY_MODELS) {
      if (!installedNames.has(name)) {
        results.push({ name, installed: false });
      }
    }

    return results;
  }

  async *pullModel(
    model: string,
    signal?: AbortSignal
  ): AsyncGenerator<PullProgress> {
    const response = await fetch(OLLAMA_API_PULL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model, stream: true }),
      signal,
    });

    if (!response.ok) {
      throw new Error(`Failed to pull model: ${response.status} ${response.statusText}`);
    }

    if (!response.body) {
      throw new Error('Pull returned an empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const lines = decoder.decode(value, { stream: true })
          .split('\n')
          .filter((line) => line.trim());

        for (const line of lines) {
          try {
            yield JSON.parse(line) as PullProgress;
          } catch {
            // Skip malformed lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
