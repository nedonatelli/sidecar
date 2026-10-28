import * as vscode from 'vscode';
import type { ApiBackend } from './backend.js';
import type { ChatMessage, StreamEvent, ToolDefinition } from './types.js';
import { logger } from '../system/logger.js';

/** Copilot's own models. `selectChatModels()` with no selector returns every vendor's. */
const COPILOT = { vendor: 'copilot' } as const;
const warnedSubstitutions = new Set<string>();

/**
 * The model SideCar actually uses for a configured Copilot model id: the id,
 * else the family, else Copilot's first available model. Used by both the chat
 * path and the context-length lookup, so the two can't disagree.
 *
 * The last step used to call `selectChatModels()` with no selector, which
 * returns every chat model from every installed vendor, and took the first one
 * silently. A default Copilot no longer offers (gpt-4o, retired from Copilot
 * 2025-08-06) therefore ran on whichever model happened to be first, possibly
 * another extension's, with no notice (#230). It now stays with Copilot and says
 * which model it picked, in the log and once in a notification that offers the
 * model picker.
 */
export async function resolveCopilotModel(
  modelId: string,
  select: typeof vscode.lm.selectChatModels = (s) => vscode.lm.selectChatModels(s),
): Promise<vscode.LanguageModelChat | null> {
  let models = await select({ id: modelId });
  if (models.length === 0) models = await select({ family: modelId });
  if (models.length > 0) return models[0];
  models = await select(COPILOT);
  if (models.length === 0) return null;
  const chosen = models[0];
  if (!warnedSubstitutions.has(modelId)) {
    warnedSubstitutions.add(modelId);
    logger.warn(
      `[SideCar] Copilot doesn't offer "${modelId}"; using ${chosen.name} (${chosen.id}) instead. ` +
        `Pick a model with SideCar: Select Model.`,
    );
    void vscode.window
      .showWarningMessage(
        `Copilot doesn't offer "${modelId}", so SideCar is using ${chosen.name} instead.`,
        'Select Model',
      )
      .then((choice) => {
        if (choice === 'Select Model') void vscode.commands.executeCommand('sidecar.selectModel');
      });
  }
  return chosen;
}

/** Test hook: forget which substitutions were already reported. */
export function _resetCopilotSubstitutionWarnings(): void {
  warnedSubstitutions.clear();
}

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
    const model = await resolveCopilotModel(modelId);
    if (!model) {
      throw new Error(
        'No GitHub Copilot language models available. Ensure GitHub Copilot is installed and you are signed in.',
      );
    }
    return model;
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
      // Copilot's models only: the picker is for the Copilot backend, and other
      // vendors' models can't be reached through it reliably (#230).
      const models = await vscode.lm.selectChatModels(COPILOT);
      return models.map((m) => ({ id: m.id, name: m.name }));
    } catch {
      return [];
    }
  }

  static async getModelContextLength(modelId: string): Promise<number | null> {
    try {
      // Same resolution as the chat path: after a fallback this used to return
      // null for the model actually in use, so context budgeting was wrong.
      const model = await resolveCopilotModel(modelId);
      return model ? model.maxInputTokens : null;
    } catch {
      return null;
    }
  }
}
