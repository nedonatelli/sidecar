import type { ChatMessage } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { runAgentLoop, type AgentOptions } from './loop.js';

export interface BatchTask {
  id: number;
  prompt: string;
  status: 'pending' | 'running' | 'done' | 'error';
  result: string;
}

export function parseBatchInput(text: string): { mode: 'sequential' | 'parallel'; tasks: string[] } {
  const lines = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l);
  let mode: 'sequential' | 'parallel' = 'sequential';
  let startIdx = 0;
  if (lines[0]?.toLowerCase() === '--parallel') {
    mode = 'parallel';
    startIdx = 1;
  }
  return { mode, tasks: lines.slice(startIdx) };
}

export async function runBatch(
  client: SideCarClient,
  tasks: string[],
  mode: 'sequential' | 'parallel',
  onTaskUpdate: (taskId: number, status: string, result: string) => void,
  signal: AbortSignal,
  options: AgentOptions = {},
): Promise<BatchTask[]> {
  const batchTasks: BatchTask[] = tasks.map((prompt, i) => ({
    id: i,
    prompt,
    status: 'pending' as const,
    result: '',
  }));

  const runTask = async (task: BatchTask) => {
    task.status = 'running';
    onTaskUpdate(task.id, 'running', '');

    const messages: ChatMessage[] = [{ role: 'user', content: task.prompt }];
    let output = '';

    try {
      await runAgentLoop(
        client,
        messages,
        {
          onText: (text) => {
            output += text;
          },
          onToolCall: () => {},
          onToolResult: () => {},
          onDone: () => {},
        },
        signal,
        { ...options, maxIterations: 15 },
      );

      task.status = 'done';
      task.result = output || '(completed)';
    } catch (err) {
      task.status = 'error';
      task.result = err instanceof Error ? err.message : String(err);
    }

    onTaskUpdate(task.id, task.status, task.result);
  };

  if (mode === 'parallel') {
    await Promise.allSettled(batchTasks.map(runTask));
  } else {
    for (const task of batchTasks) {
      if (signal.aborted) break;
      await runTask(task);
    }
  }

  return batchTasks;
}
