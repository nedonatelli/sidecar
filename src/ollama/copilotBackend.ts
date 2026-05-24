import * as vscode from 'vscode';
import type { ApiBackend } from './backend.js';
import type { ChatMessage, StreamEvent, ToolDefinition } from './types.js';

function convertMessages(systemPrompt: string, messages: ChatMessage[]): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];

  if (systemPrompt.trim().length > 0) {
    out.push(vscode.LanguageModelChatMessage.User(`[System Instructions]\n${systemPrompt}`));
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push(vscode.LanguageModelChatMessage.User(msg.content));
      } else {
        const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolResultPart)[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push(new vscode.LanguageModelTextPart(block.text));
          } else if (block.type === 'tool_result') {
            parts.push(
              new vscode.LanguageModelToolResultPart(block.tool_use_id, [
                new vscode.LanguageModelTextPart(block.content),
              ]),
            );
          }
          // image and thinking blocks have no vscode.lm equivalent — drop them
        }
        if (parts.length > 0) {
          out.push(vscode.LanguageModelChatMessage.User(parts));
        }
      }
    } else {
      if (typeof msg.content === 'string') {
        out.push(vscode.LanguageModelChatMessage.Assistant(msg.content));
      } else {
        const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
        for (const block of msg.content) {
          if (block.type === 'text') {
            parts.push(new vscode.LanguageModelTextPart(block.text));
          } else if (block.type === 'tool_use') {
            parts.push(new vscode.LanguageModelToolCallPart(block.id, block.name, block.input));
          }
          // thinking and image blocks dropped
        }
        if (parts.length > 0) {
          out.push(vscode.LanguageModelChatMessage.Assistant(parts));
        }
      }
    }
  }

  return out;
}

function convertTools(tools: ToolDefinition[]): vscode.LanguageModelChatTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  }));
}

export class CopilotBackend implements ApiBackend {
  private async selectModel(modelId: string): Promise<vscode.LanguageModelChat> {
    // Try exact id match first, then family, then any available model
    let models = await vscode.lm.selectChatModels({ id: modelId });
    if (models.length === 0) {
      models = await vscode.lm.selectChatModels({ family: modelId });
    }
    if (models.length === 0) {
      models = await vscode.lm.selectChatModels();
    }
    if (models.length === 0) {
      throw new Error(
        'No GitHub Copilot language models available. Ensure GitHub Copilot is installed and you are signed in.',
      );
    }
    return models[0];
  }

  async *streamChat(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    signal?: AbortSignal,
    tools?: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const lmModel = await this.selectModel(model);
    const lmMessages = convertMessages(systemPrompt, messages);

    const cts = new vscode.CancellationTokenSource();
    const onAbort = () => cts.cancel();
    signal?.addEventListener('abort', onAbort);

    try {
      const opts: vscode.LanguageModelChatRequestOptions = {};
      if (tools && tools.length > 0) {
        opts.tools = convertTools(tools);
      }

      const response = await lmModel.sendRequest(lmMessages, opts, cts.token);

      for await (const chunk of response.stream) {
        if (chunk instanceof vscode.LanguageModelTextPart) {
          yield { type: 'text', text: chunk.value };
        } else if (chunk instanceof vscode.LanguageModelToolCallPart) {
          yield {
            type: 'tool_use',
            toolUse: {
              type: 'tool_use',
              id: chunk.callId,
              name: chunk.name,
              input: chunk.input as Record<string, unknown>,
            },
          };
        }
      }

      yield { type: 'stop', stopReason: 'end_turn' };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      cts.dispose();
    }
  }

  async complete(
    model: string,
    systemPrompt: string,
    messages: ChatMessage[],
    _maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const parts: string[] = [];
    for await (const event of this.streamChat(model, systemPrompt, messages, signal)) {
      if (event.type === 'text') parts.push(event.text);
    }
    return parts.join('');
  }

  static async listAvailableModels(): Promise<{ id: string; name: string }[]> {
    try {
      const models = await vscode.lm.selectChatModels();
      return models.map((m) => ({ id: m.id, name: m.name }));
    } catch {
      return [];
    }
  }

  static async getModelContextLength(modelId: string): Promise<number | null> {
    try {
      let models = await vscode.lm.selectChatModels({ id: modelId });
      if (models.length === 0) {
        models = await vscode.lm.selectChatModels({ family: modelId });
      }
      if (models.length === 0) return null;
      return models[0].maxInputTokens;
    } catch {
      return null;
    }
  }
}
