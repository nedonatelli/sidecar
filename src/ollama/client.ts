import type { ChatMessage, ToolDefinition, ToolUseContentBlock, AnthropicResponse, AnthropicStreamEvent, StreamEvent } from './types.js';

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

  constructor(model: string, baseUrl?: string, apiKey?: string) {
    this.model = model;
    this.systemPrompt = '';
    this.baseUrl = baseUrl || DEFAULT_BASE_URL;
    this.apiKey = apiKey || 'ollama';
  }

  private get messagesUrl(): string {
    return `${this.baseUrl}/v1/messages`;
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
    tools?: ToolDefinition[]
  ): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: 4096,
      messages,
      stream: true,
    };

    if (this.systemPrompt) {
      body.system = this.systemPrompt;
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const response = await fetch(this.messagesUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`API request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`);
    }

    if (!response.body) {
      throw new Error('API returned an empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    // State for buffering tool use and thinking blocks
    let currentToolUse: { id: string; name: string; inputJson: string } | null = null;
    let currentThinking = false;

    try {
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data) continue;

          let event: AnthropicStreamEvent;
          try {
            event = JSON.parse(data) as AnthropicStreamEvent;
          } catch {
            continue;
          }

          switch (event.type) {
            case 'content_block_start':
              if (event.content_block?.type === 'tool_use') {
                currentToolUse = {
                  id: event.content_block.id || '',
                  name: event.content_block.name || '',
                  inputJson: '',
                };
              } else if (event.content_block?.type === 'thinking') {
                currentThinking = true;
              }
              break;

            case 'content_block_delta':
              if (!event.delta) break;
              if (event.delta.type === 'text_delta' && event.delta.text) {
                yield { type: 'text', text: event.delta.text };
              } else if (event.delta.type === 'thinking_delta' && event.delta.thinking && currentThinking) {
                yield { type: 'thinking', thinking: event.delta.thinking };
              } else if (event.delta.type === 'input_json_delta' && event.delta.partial_json && currentToolUse) {
                currentToolUse.inputJson += event.delta.partial_json;
              }
              break;

            case 'content_block_stop':
              currentThinking = false;
              if (currentToolUse) {
                let input: Record<string, unknown> = {};
                try {
                  input = JSON.parse(currentToolUse.inputJson || '{}');
                } catch {
                  // Malformed JSON, use empty
                }
                const toolUse: ToolUseContentBlock = {
                  type: 'tool_use',
                  id: currentToolUse.id,
                  name: currentToolUse.name,
                  input,
                };
                yield { type: 'tool_use', toolUse };
                currentToolUse = null;
              }
              break;

            case 'message_delta':
              if (event.delta?.stop_reason) {
                yield { type: 'stop', stopReason: event.delta.stop_reason };
              }
              break;

            case 'error':
              if (event.error) {
                throw new Error(event.error.message);
              }
              break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  async complete(
    messages: ChatMessage[],
    maxTokens: number = 256,
    signal?: AbortSignal
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: maxTokens,
      messages,
      stream: false,
    };

    if (this.systemPrompt) {
      body.system = this.systemPrompt;
    }

    const response = await fetch(this.messagesUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(`API request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`);
    }

    const data = await response.json() as AnthropicResponse;
    const textBlock = data.content.find(b => b.type === 'text');
    return textBlock?.text ?? '';
  }

  async completeFIM(
    prefix: string,
    suffix: string,
    model?: string,
    maxTokens: number = 256,
    signal?: AbortSignal
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

    const data = await response.json() as { response: string };
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
      const data = await response.json() as Record<string, unknown>;
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
    return this.baseUrl.includes('localhost:11434') || this.baseUrl.includes('127.0.0.1:11434');
  }

  async listInstalledModels(): Promise<InstalledModel[]> {
    const response = await fetch(this.tagsUrl);
    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.status}`);
    }
    const data = await response.json() as { models: InstalledModel[] };
    return data.models ?? [];
  }

  async listLibraryModels(): Promise<LibraryModel[]> {
    const installed = await this.listInstalledModels();
    const installedNames = new Set(installed.map((m) => m.name.split(':')[0]));

    const results: LibraryModel[] = installed.map((m) => ({
      name: m.name,
      installed: true,
    }));

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
