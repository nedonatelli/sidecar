import type { ApiBackend } from './backend.js';
import type {
  ChatMessage,
  ToolDefinition,
  ToolUseContentBlock,
  AnthropicResponse,
  AnthropicStreamEvent,
  StreamEvent,
} from './types.js';
import { fetchWithRetry } from './retry.js';

/**
 * Split the system prompt into cached (stable) and dynamic blocks.
 * The stable prefix (base prompt + SIDECAR.md + user config) is marked
 * with cache_control so Anthropic caches it server-side (~90% cheaper).
 * The dynamic workspace context is sent uncached since it changes per query.
 */
const WORKSPACE_CONTEXT_MARKER = '## Workspace Structure';

export function buildSystemBlocks(
  systemPrompt: string,
): { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[] {
  const markerIndex = systemPrompt.indexOf(WORKSPACE_CONTEXT_MARKER);
  if (markerIndex <= 0) {
    // No workspace context — cache the entire system prompt
    return [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
  }
  // Split into stable prefix (cached) and dynamic workspace context (not cached)
  const stablePrefix = systemPrompt.slice(0, markerIndex).trimEnd();
  const dynamicContext = systemPrompt.slice(markerIndex);
  return [
    { type: 'text', text: stablePrefix, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: dynamicContext },
  ];
}

/**
 * Backend for the Anthropic Messages API (/v1/messages).
 * Used when connecting to https://api.anthropic.com or any Anthropic-compatible proxy.
 */
export class AnthropicBackend implements ApiBackend {
  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  private get messagesUrl(): string {
    return `${this.baseUrl}/v1/messages`;
  }

  async *streamChat(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      messages,
      stream: true,
    };

    if (systemPrompt) {
      body.system = buildSystemBlocks(systemPrompt);
    }

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const response = await fetchWithRetry(this.messagesUrl, {
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
      throw new Error(
        `Anthropic API request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`,
      );
    }

    if (!response.body) {
      throw new Error('Anthropic API returned an empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

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
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    maxTokens: number = 256,
    signal?: AbortSignal,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      messages,
      stream: false,
    };

    if (systemPrompt) {
      body.system = buildSystemBlocks(systemPrompt);
    }

    const response = await fetchWithRetry(this.messagesUrl, {
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
      throw new Error(
        `Anthropic API request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`,
      );
    }

    const data = (await response.json()) as AnthropicResponse;
    const textBlock = data.content.find((b) => b.type === 'text');
    return textBlock?.text ?? '';
  }
}
