import type { ToolDefinition } from '../../ollama/types.js';
import type { RegisteredTool, ToolExecutorContext } from './shared.js';
import { getConfig } from '../../config/settings.js';

// Tool names that signal a server accepts a high-level task description
// rather than structured function parameters. Checked in order — first
// match wins. Servers that don't follow this convention can be targeted
// explicitly via the `tool` parameter.
const TASK_TOOL_CANDIDATES = ['run_task', 'execute_task', 'task', 'run', 'execute', 'process', 'handle'];

const MCP_DELEGATE_TIMEOUT_MS = 60_000;

/**
 * Resolve the tool name to call on a given MCP server.
 * Returns null if no suitable task tool is found.
 */
export function resolveTaskTool(
  serverName: string,
  toolNames: string[],
  explicitTool?: string,
): { toolName: string } | { error: string } {
  if (explicitTool) {
    if (!toolNames.includes(explicitTool)) {
      return {
        error:
          `Tool "${explicitTool}" not found on server "${serverName}". ` +
          `Available: ${toolNames.join(', ') || '(none)'}`,
      };
    }
    return { toolName: explicitTool };
  }

  for (const candidate of TASK_TOOL_CANDIDATES) {
    if (toolNames.includes(candidate)) return { toolName: candidate };
  }

  return {
    error:
      `No task-entry-point tool found on server "${serverName}". ` +
      `Available tools: ${toolNames.join(', ') || '(none)'}. ` +
      `Use the \`tool\` parameter to specify which tool to call.`,
  };
}

export async function delegateToMcp(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const cfg = context?.config ?? getConfig();
  if (!cfg.mcpDelegationEnabled) {
    return 'MCP task delegation is disabled. Enable it with `sidecar.mcpDelegation.enabled = true`.';
  }

  const server = (input.server as string | undefined)?.trim();
  const task = (input.task as string | undefined)?.trim();
  const explicitTool = (input.tool as string | undefined)?.trim() || undefined;
  const taskContext = (input.context as string | undefined)?.trim() || undefined;

  if (!server) return 'Missing required parameter: server';
  if (!task) return 'Missing required parameter: task';

  // Allowlist check
  if (cfg.mcpDelegationAllowedServers.length > 0 && !cfg.mcpDelegationAllowedServers.includes(server)) {
    return (
      `Server "${server}" is not in the delegation allowlist. ` +
      `Allowed servers: ${cfg.mcpDelegationAllowedServers.join(', ')}`
    );
  }

  const mcpManager = context?.mcpManager;
  if (!mcpManager) {
    return 'MCP manager not available — delegate_to_mcp requires an active agent context.';
  }

  if (!mcpManager.isServerConnected(server)) {
    const known = mcpManager.getServerNames();
    return `Server "${server}" is not connected. ` + `Connected servers: ${known.join(', ') || '(none)'}`;
  }

  const toolNames = mcpManager.getServerToolNames(server);
  const resolved = resolveTaskTool(server, toolNames, explicitTool);
  if ('error' in resolved) return resolved.error;

  const toolInput: Record<string, unknown> = { task };
  if (taskContext) toolInput.context = taskContext;

  try {
    let timeoutHandle: ReturnType<typeof setTimeout>;
    const racePromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`MCP delegation timed out after ${MCP_DELEGATE_TIMEOUT_MS / 1000}s`)),
        MCP_DELEGATE_TIMEOUT_MS,
      );
      context?.signal?.addEventListener('abort', () => reject(new Error('MCP delegation aborted')), { once: true });
    });
    try {
      return await Promise.race([mcpManager.callServerTool(server, resolved.toolName, toolInput), racePromise]);
    } finally {
      clearTimeout(timeoutHandle!);
    }
  } catch (err) {
    return `Delegation to "${server}/${resolved.toolName}" failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const mcpDelegateDef: ToolDefinition = {
  name: 'delegate_to_mcp',
  nondeterministicOutput: true,
  description:
    'Delegate a sub-task to a configured MCP server that has its own agent or reasoning loop. ' +
    'The server receives the task description, runs it autonomously, and returns structured results. ' +
    'Use this to offload specialised work (e.g. symbolic math, live web search, sandboxed code execution) ' +
    'to a server that is better suited for it than the current model. ' +
    'Specify `server` (the key from sidecar.mcpServers config), `task` (natural language), ' +
    'and optionally `tool` (the server tool to invoke — auto-detected if omitted) ' +
    'and `context` (extra context to pass alongside the task).',
  input_schema: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'MCP server name as configured in sidecar.mcpServers (e.g. "math-engine")',
      },
      task: {
        type: 'string',
        description: 'Natural language description of the sub-task for the server to complete',
      },
      tool: {
        type: 'string',
        description: 'Specific tool to call on the server. Auto-detected (run_task, execute, etc.) when omitted.',
      },
      context: {
        type: 'string',
        description: 'Additional context from the current conversation to include with the task',
      },
    },
    required: ['server', 'task'],
  },
};

export const mcpDelegateTools: RegisteredTool[] = [
  {
    definition: mcpDelegateDef,
    executor: delegateToMcp,
    requiresApproval: false,
  },
];
