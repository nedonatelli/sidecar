import type { ChatMessage, ToolDefinition } from '../ollama/types.js';
import { SideCarClient } from '../ollama/client.js';
import { getConfig } from '../config/settings.js';
import { runAgentLoop, type AgentCallbacks, type AgentOptions } from './loop.js';
import { getToolDefinitions } from './tools.js';

/**
 * Tools the local worker is allowed to call. Read-only by design:
 * the orchestrator delegates research and exploration to the local
 * model, but retains authority over any destructive operation. This
 * prevents a weak local model's bad judgment from silently corrupting
 * the repo via a summary the orchestrator then trusts.
 */
const WORKER_ALLOWED_TOOLS = new Set([
  'read_file',
  'search_files',
  'grep',
  'list_directory',
  'get_diagnostics',
  'find_references',
  'git_diff',
  'git_status',
  'git_log',
  'git_branch',
  'display_diagram',
]);

const WORKER_SYSTEM_PROMPT = `You are a local research worker spawned by a frontier-model orchestrator. Your job is to investigate a focused task using the read-only tools available and return a compact, structured summary.

## Rules

- Do the task efficiently. No chit-chat, no clarifying questions.
- You have ONLY read-only tools: read_file, grep, search_files, list_directory, get_diagnostics, find_references, git_*, display_diagram.
- You CANNOT write files, run commands, or edit code. If the task asks for changes, describe what *should* change — do not attempt it.
- Your final reply is the ONLY thing the orchestrator will see. Make it count.

## Output format

End with a single structured summary block. Use this shape:

\`\`\`
SUMMARY
=======
Task: <one-line restatement>
Findings:
  - <concrete fact with file:line reference>
  - <...>
Relevant files:
  - path/to/file.ts:L12-L40 — <one-line purpose>
  - <...>
Recommendations (if applicable):
  - <what the orchestrator should do next>
\`\`\`

Be factual. Quote file paths and line numbers. Never speculate without a citation.`;

export interface LocalWorkerResult {
  /** The structured summary returned to the orchestrator as a tool_result. */
  output: string;
  /** Did the worker complete without error? */
  success: boolean;
  /** Chars the worker consumed on its own backend — NOT charged to the paid budget. */
  charsConsumed: number;
  /** Worker model actually used (for telemetry / UI). */
  model: string;
}

/**
 * Filter the full tool catalog down to the read-only subset the worker
 * is allowed to see. We pass this via `AgentOptions.toolOverride` so
 * the worker never even knows delegate_task / write_file exist —
 * no wasted tokens attempting denied calls, no recursion risk.
 */
function filterToolsForWorker(allTools: ToolDefinition[]): ToolDefinition[] {
  return allTools.filter((t) => WORKER_ALLOWED_TOOLS.has(t.name));
}

/**
 * Spawn a local-model worker to complete a focused task and return
 * its summary. The worker runs on its own SideCarClient pointed at
 * Ollama (separate from the orchestrator's paid backend), so none of
 * its token consumption shows up on the Anthropic/OpenAI bill.
 */
export async function runLocalWorker(
  task: string,
  context: string | undefined,
  parentCallbacks: AgentCallbacks,
  signal: AbortSignal,
  options: AgentOptions = {},
): Promise<LocalWorkerResult> {
  const cfg = getConfig();
  const workerModel = cfg.delegateTaskWorkerModel || cfg.model;
  const workerBaseUrl = cfg.delegateTaskWorkerBaseUrl || 'http://localhost:11434';

  // Fresh client, isolated from the orchestrator's state. No shared
  // rate-limit store, no backend reuse, nothing to corrupt.
  const workerClient = new SideCarClient(workerModel, workerBaseUrl, 'ollama');
  workerClient.updateSystemPrompt(WORKER_SYSTEM_PROMPT);

  const prompt = context ? `Context from orchestrator:\n${context}\n\nTask: ${task}` : `Task: ${task}`;
  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

  parentCallbacks.onText(`\n[delegate_task → local worker (${workerModel}): ${task}]\n`);
  options.logger?.info(`Local worker spawned: model=${workerModel} task="${task.slice(0, 80)}"`);

  let output = '';
  let charsConsumed = 0;
  const workerCallbacks: AgentCallbacks = {
    onText: (text) => {
      output += text;
    },
    onCharsConsumed: (chars) => {
      charsConsumed += chars;
    },
    onThinking: (thinking) => {
      options.logger?.debug(`[worker] thinking: ${thinking.slice(0, 100)}`);
    },
    onToolCall: (name, input, toolId) => {
      options.logger?.logToolCall(`worker:${name}`, input);
      parentCallbacks.onToolCall(`worker:${name}`, input, toolId);
    },
    onToolResult: (name, result, isError, toolId) => {
      options.logger?.logToolResult(`worker:${name}`, result, isError);
      parentCallbacks.onToolResult(`worker:${name}`, result, isError, toolId);
    },
    onDone: () => {
      options.logger?.info('Local worker completed');
    },
  };

  const workerTools = filterToolsForWorker(getToolDefinitions(options.mcpManager));

  try {
    await runAgentLoop(workerClient, messages, workerCallbacks, signal, {
      ...options,
      approvalMode: 'autonomous',
      maxIterations: Math.min(options.maxIterations || 25, 10),
      depth: (options.depth || 0) + 1,
      toolOverride: workerTools,
      modeToolPermissions: Object.fromEntries(Array.from(WORKER_ALLOWED_TOOLS).map((n) => [n, 'allow' as const])),
    });
    parentCallbacks.onText(`\n[delegate_task completed]\n`);
    return { output: output.trim() || '(worker produced no output)', success: true, charsConsumed, model: workerModel };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    options.logger?.error(`Local worker failed: ${errorMsg}`);
    parentCallbacks.onText(`\n[delegate_task failed: ${errorMsg}]\n`);
    return { output: errorMsg, success: false, charsConsumed, model: workerModel };
  }
}
