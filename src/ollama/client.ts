import type { ChatMessage, ToolDefinition, StreamEvent } from './types.js';
import type { ApiBackend } from './backend.js';
import { AnthropicBackend } from './anthropicBackend.js';
import { OllamaBackend } from './ollamaBackend.js';
import { OpenAIBackend } from './openaiBackend.js';
import { isLocalOllama, detectProvider, getConfig } from '../config/settings.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';

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
  'qwen3-coder',
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

export class SideCarClient {
  private model: string;
  private systemPrompt: string;
  private baseUrl: string;
  private apiKey: string;
  private backend: ApiBackend;

  constructor(model: string, baseUrl?: string, apiKey?: string) {
    this.model = model;
    this.systemPrompt = '';
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
    this.apiKey = apiKey || 'ollama';
    this.backend = this.createBackend();
  }

  private createBackend(): ApiBackend {
    const provider = detectProvider(this.baseUrl, getConfig().provider);
    switch (provider) {
      case 'ollama':
        return new OllamaBackend(this.baseUrl);
      case 'anthropic':
        return new AnthropicBackend(this.baseUrl, this.apiKey);
      case 'openai':
        return new OpenAIBackend(this.baseUrl, this.apiKey);
    }
  }

  private get tagsUrl(): string {
    return `${this.baseUrl}/api/tags`;
  }

  private get pullUrl(): string {
    return `${this.baseUrl}/api/pull`;
  }

  private get generateUrl(): string {
    return `${this.baseUrl}/api/generate`;
  }

  async *streamChat(
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    yield* this.backend.streamChat(this.model, this.systemPrompt, messages, signal, tools);
  }

  async complete(messages: ChatMessage[], maxTokens: number = 256, signal?: AbortSignal): Promise<string> {
    return this.backend.complete(this.model, this.systemPrompt, messages, maxTokens, signal);
  }

  async completeFIM(
    prefix: string,
    suffix: string,
    model?: string,
    maxTokens: number = 256,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await fetch(this.generateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || this.model,
        prompt: prefix,
        suffix,
        stream: false,
        options: { num_predict: maxTokens },
      }),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`FIM request failed: ${response.status}${errorText ? ` — ${errorText}` : ''}`);
    }

    const data = (await response.json()) as { response: string };
    return data.response ?? '';
  }

  updateModel(model: string) {
    this.model = model;
  }

  updateSystemPrompt(prompt: string) {
    this.systemPrompt = prompt;
  }

  updateConnection(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
    this.apiKey = apiKey || 'ollama';
    this.backend = this.createBackend();
  }

  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  async getModelContextLength(): Promise<number | null> {
    if (!this.isLocalOllama()) return null;
    try {
      const response = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model }),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as Record<string, unknown>;
      const modelInfo = data.model_info as Record<string, unknown> | undefined;
      if (!modelInfo) return null;
      for (const [key, value] of Object.entries(modelInfo)) {
        if (key.toLowerCase().includes('context_length') && typeof value === 'number') {
          return value;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  isLocalOllama(): boolean {
    return isLocalOllama(this.baseUrl);
  }

  isOpenAI(): boolean {
    const provider = detectProvider(this.baseUrl, getConfig().provider);
    return provider === 'openai';
  }

  getProviderType(): 'ollama' | 'anthropic' | 'openai' {
    return detectProvider(this.baseUrl, getConfig().provider);
  }

  async listInstalledModels(): Promise<InstalledModel[]> {
    const provider = this.getProviderType();

    if (provider === 'openai') {
      // OpenAI-compatible servers use GET /v1/models
      try {
        const headers: Record<string, string> = {};
        if (this.apiKey && this.apiKey !== 'ollama') {
          headers['Authorization'] = `Bearer ${this.apiKey}`;
        }
        const response = await fetch(`${this.baseUrl}/v1/models`, { headers });
        if (!response.ok) return [];
        const data = (await response.json()) as { data: { id: string; owned_by?: string }[] };
        return (data.data || []).map((m) => ({
          name: m.id,
          model: m.id,
          size: 0,
          details: { parameter_size: '', quantization_level: '', family: m.owned_by || '' },
        }));
      } catch {
        return [];
      }
    }

    // Ollama uses /api/tags
    const response = await fetch(this.tagsUrl);
    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status}`);
    }
    const data = (await response.json()) as { models: InstalledModel[] };
    return data.models ?? [];
  }

  async listLibraryModels(): Promise<LibraryModel[]> {
    const installed = await this.listInstalledModels();
    const installedNames = new Set(installed.map((m) => m.name.split(':')[0]));

    const results: LibraryModel[] = installed.map((m) => ({
      name: m.name,
      installed: true,
    }));

    // Only show library models for Ollama (local pull support)
    if (this.getProviderType() === 'ollama') {
      for (const name of LIBRARY_MODELS) {
        if (!installedNames.has(name)) {
          results.push({ name, installed: false });
        }
      }
    }

    return results;
  }

  async *pullModel(model: string, signal?: AbortSignal): AsyncGenerator<PullProgress> {
    const response = await fetch(this.pullUrl, {
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

        const lines = decoder
          .decode(value, { stream: true })
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
