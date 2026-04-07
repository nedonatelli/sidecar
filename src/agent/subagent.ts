import type { ChatMessage } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { runAgentLoop, type AgentCallbacks, type AgentOptions } from './loop.js';

export interface SubAgentTask {
  id: string;
  task: string;
  context?: string;
}

export interface SubAgentResult {
  id: string;
  task: string;
  output: string;
  success: boolean;
}

let subAgentCounter = 0;

export async function spawnSubAgent(
  client: SideCarClient,
  task: string,
  context: string | undefined,
  parentCallbacks: AgentCallbacks,
  signal: AbortSignal,
  options: AgentOptions = {},
): Promise<SubAgentResult> {
  const id = `sub-${++subAgentCounter}`;

  const messages: ChatMessage[] = [];
  let prompt = task;
  if (context) {
    prompt = `Context:\n${context}\n\nTask: ${task}`;
  }
  messages.push({ role: 'user', content: prompt });

  parentCallbacks.onText(`\n[Sub-agent ${id}: ${task}]\n`);
  options.logger?.info(`Sub-agent ${id} spawned: ${task}`);

  let output = '';
  const subCallbacks: AgentCallbacks = {
    onText: (text) => {
      output += text;
    },
    onThinking: (thinking) => {
      options.logger?.debug(`[${id}] thinking: ${thinking.slice(0, 100)}`);
    },
    onToolCall: (name, input, toolId) => {
      options.logger?.logToolCall(name, input);
      parentCallbacks.onToolCall(name, input, toolId);
    },
    onToolResult: (name, result, isError, toolId) => {
      options.logger?.logToolResult(name, result, isError);
      parentCallbacks.onToolResult(name, result, isError, toolId);
    },
    onDone: () => {
      options.logger?.info(`Sub-agent ${id} completed`);
    },
  };

  try {
    await runAgentLoop(client, messages, subCallbacks, signal, {
      ...options,
      maxIterations: Math.min(options.maxIterations || 25, 15), // Sub-agents get fewer iterations
    });

    parentCallbacks.onText(`\n[Sub-agent ${id} completed]\n`);
    return { id, task, output, success: true };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    options.logger?.error(`Sub-agent ${id} failed: ${errorMsg}`);
    parentCallbacks.onText(`\n[Sub-agent ${id} failed: ${errorMsg}]\n`);
    return { id, task, output: errorMsg, success: false };
  }
}
