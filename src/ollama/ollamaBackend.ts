import type { ApiBackend } from './backend.js';
import type { ChatMessage, ContentBlock, ToolDefinition, ToolUseContentBlock, StreamEvent } from './types.js';
import { fetchWithRetry } from './retry.js';

// ---------------------------------------------------------------------------
// Models that do not support tools
// ---------------------------------------------------------------------------
const MODELS_WITHOUT_TOOL_SUPPORT = new Set([
  'gemma:latest',
  'gemma2:latest',
  'gemma2:2b',
  'gemma2:9b',
  'gemma2:27b',
  'llama2',
  'mistral',
  'neural-chat',
  'starling-lm',
]);

function supportsTools(model: string): boolean {
  // Check if model name matches any known non-tool-supporting models
  const base = model.split(':')[0];
  return !MODELS_WITHOUT_TOOL_SUPPORT.has(model) && !MODELS_WITHOUT_TOOL_SUPPORT.has(`${base}:latest`);
}

export function modelSupportsTools(model: string): boolean {
  return supportsTools(model);
}

// ---------------------------------------------------------------------------
// Ollama native API types
// ---------------------------------------------------------------------------

interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[];
  tool_calls?: OllamaToolCall[];
}

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required?: string[];
    };
  };
}

interface OllamaChatChunk {
  model: string;
  message: {
    role: string;
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
}

// ---------------------------------------------------------------------------
// Message format conversion
// ---------------------------------------------------------------------------

/**
 * Convert our internal ChatMessage[] (Anthropic format) to Ollama's message format.
 * Key differences:
 *   - Ollama uses plain string content, not content block arrays
 *   - Tool results are sent as role:"tool" messages
 *   - Tool calls are in message.tool_calls, not content blocks
 */
function toOllamaMessages(messages: ChatMessage[], systemPrompt: string): OllamaMessage[] {
  const result: OllamaMessage[] = [];

  if (systemPrompt) {
    result.push({ role: 'system', content: systemPrompt });
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    // Content block array — need to decompose
    const blocks = msg.content as ContentBlock[];

    if (msg.role === 'user') {
      // User messages may contain tool_result blocks (from agent loop)
      const toolResults = blocks.filter((b) => b.type === 'tool_result');
      const textBlocks = blocks.filter((b) => b.type === 'text');
      const imageBlocks = blocks.filter((b) => b.type === 'image');

      // Emit tool result messages
      for (const tr of toolResults) {
        if (tr.type === 'tool_result') {
          result.push({ role: 'tool', content: tr.content });
        }
      }

      // Emit text/image as user message
      if (textBlocks.length > 0 || imageBlocks.length > 0) {
        const text = textBlocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n');
        const images = imageBlocks
          .filter((b) => b.type === 'image')
          .map((b) => (b.type === 'image' ? b.source.data : ''));
        const userMsg: OllamaMessage = { role: 'user', content: text };
        if (images.length > 0) {
          userMsg.images = images;
        }
        result.push(userMsg);
      }
    } else {
      // Assistant messages may contain text + tool_use blocks
      const textParts: string[] = [];
      const toolCalls: OllamaToolCall[] = [];

      for (const block of blocks) {
        if (block.type === 'text') {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            function: {
              name: block.name,
              arguments: block.input,
            },
          });
        }
      }

      const assistantMsg: OllamaMessage = {
        role: 'assistant',
        content: textParts.join('\n'),
      };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      result.push(assistantMsg);
    }
  }

  return result;
}

/**
 * Convert our ToolDefinition[] to Ollama's tool format.
 */
function toOllamaTools(tools: ToolDefinition[]): OllamaTool[] {
  return tools.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description,
      parameters: {
        type: 'object',
        properties: t.input_schema.properties,
        required: t.input_schema.required,
      },
    },
  }));
}

// ---------------------------------------------------------------------------
// OllamaBackend
// ---------------------------------------------------------------------------

/**
 * Backend for Ollama's native /api/chat endpoint.
 * Uses NDJSON streaming and Ollama's tool call format.
 */
export class OllamaBackend implements ApiBackend {
  constructor(private baseUrl: string) {}

  private get chatUrl(): string {
    return `${this.baseUrl}/api/chat`;
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
      messages: toOllamaMessages(messages, systemPrompt),
      stream: true,
    };

    if (tools && tools.length > 0) {
      if (supportsTools(model)) {
        body.tools = toOllamaTools(tools);
      } else {
        yield {
          type: 'warning',
          message: `⚠️ Model "${model}" does not support tools. Tool calling is disabled for this model.`,
        };
      }
    }

    const response = await fetchWithRetry(this.chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Ollama request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`,
      );
    }

    if (!response.body) {
      throw new Error('Ollama returned an empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let toolCallCounter = 0;
    let insideThinkTag = false;

    try {
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let chunk: OllamaChatChunk;
          try {
            chunk = JSON.parse(trimmed) as OllamaChatChunk;
          } catch {
            continue;
          }

          // Emit text content, parsing <think> tags for reasoning models
          if (chunk.message.content) {
            let content = chunk.message.content;

            // Handle <think> tag transitions within this chunk
            while (content.length > 0) {
              if (!insideThinkTag) {
                const openIdx = content.indexOf('<think>');
                if (openIdx === -1) {
                  yield { type: 'text', text: content };
                  break;
                }
                // Emit text before the tag
                if (openIdx > 0) {
                  yield { type: 'text', text: content.slice(0, openIdx) };
                }
                insideThinkTag = true;
                content = content.slice(openIdx + 7); // skip '<think>'
              } else {
                const closeIdx = content.indexOf('</think>');
                if (closeIdx === -1) {
                  yield { type: 'thinking', thinking: content };
                  break;
                }
                // Emit thinking before close tag
                if (closeIdx > 0) {
                  yield { type: 'thinking', thinking: content.slice(0, closeIdx) };
                }
                insideThinkTag = false;
                content = content.slice(closeIdx + 8); // skip '</think>'
              }
            }
          }

          // Emit tool calls
          if (chunk.message.tool_calls) {
            for (const tc of chunk.message.tool_calls) {
              const toolUse: ToolUseContentBlock = {
                type: 'tool_use',
                id: `ollama_tc_${toolCallCounter++}`,
                name: tc.function.name,
                input: tc.function.arguments,
              };
              yield { type: 'tool_use', toolUse };
            }
          }

          // Emit stop when done
          if (chunk.done) {
            const stopReason = chunk.done_reason === 'stop' ? 'end_turn' : chunk.done_reason || 'end_turn';
            yield { type: 'stop', stopReason };
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
    _maxTokens: number = 256,
    signal?: AbortSignal,
  ): Promise<string> {
    const body: Record<string, unknown> = {
      model,
      messages: toOllamaMessages(messages, systemPrompt),
      stream: false,
    };

    const response = await fetchWithRetry(this.chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `Ollama request failed: ${response.status} ${response.statusText}${errorText ? ` — ${errorText}` : ''}`,
      );
    }

    const data = (await response.json()) as OllamaChatChunk;
    return data.message.content ?? '';
  }
}
