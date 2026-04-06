import { window, workspace } from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../ollama/types.js';
import { findTool } from './tools.js';
import type { ChangeLog } from './changelog.js';
import type { MCPManager } from './mcpManager.js';
import { getToolPermissions, getHooks } from '../config/settings.js';
import type { AgentLogger } from './logger.js';

const execAsync = promisify(exec);

export type ApprovalMode = 'autonomous' | 'cautious' | 'manual';

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export async function executeTool(
  toolUse: ToolUseContentBlock,
  approvalMode: ApprovalMode = 'cautious',
  changelog?: ChangeLog,
  mcpManager?: MCPManager,
  logger?: AgentLogger,
): Promise<ToolResultContentBlock> {
  const tool = findTool(toolUse.name, mcpManager);

  if (!tool) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Unknown tool: ${toolUse.name}`,
      is_error: true,
    };
  }

  // --- Per-tool permissions (highest priority) ---
  const permissions = getToolPermissions();
  const explicitPermission = permissions[toolUse.name];

  if (explicitPermission === 'deny') {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Tool "${toolUse.name}" is denied by policy.`,
      is_error: true,
    };
  }

  // --- Determine approval ---
  let needsApproval: boolean;
  if (explicitPermission === 'allow') {
    needsApproval = false;
  } else if (explicitPermission === 'ask') {
    needsApproval = true;
  } else {
    // Fall back to global mode + tool flag
    needsApproval = approvalMode === 'manual' || (approvalMode === 'cautious' && tool.requiresApproval);
  }

  if (needsApproval) {
    const inputSummary = Object.entries(toolUse.input)
      .map(([k, v]) => {
        const val = typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '...' : String(v);
        return `${k}: ${val}`;
      })
      .join(', ');

    const choice = await window.showWarningMessage(
      `SideCar wants to use ${toolUse.name}(${inputSummary})`,
      { modal: true },
      'Allow',
      'Deny',
    );

    if (choice !== 'Allow') {
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: 'Tool call denied by user.',
        is_error: true,
      };
    }
  }

  // Audit log for autonomous executions
  if (!needsApproval && approvalMode === 'autonomous') {
    logger?.warn(`[AUTONOMOUS] ${toolUse.name}(${JSON.stringify(toolUse.input).slice(0, 200)})`);
  }

  // --- Pre-hook ---
  await runHook('pre', toolUse.name, toolUse.input);

  // --- Snapshot file before destructive operations ---
  if (changelog && WRITE_TOOLS.has(toolUse.name) && toolUse.input.path) {
    await changelog.snapshotFile(toolUse.input.path as string);
  }

  // --- Execute tool ---
  try {
    const result = await tool.executor(toolUse.input);

    // --- Post-hook ---
    await runHook('post', toolUse.name, toolUse.input, result);

    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: result,
    };
  } catch (err) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Error: ${err instanceof Error ? err.message : String(err)}`,
      is_error: true,
    };
  }
}

async function runHook(
  phase: 'pre' | 'post',
  toolName: string,
  input: Record<string, unknown>,
  output?: string,
): Promise<void> {
  const hooks = getHooks();
  const toolHook = hooks[toolName]?.[phase];
  const globalHook = hooks['*']?.[phase];
  const command = toolHook || globalHook;

  if (!command) return;

  const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    SIDECAR_TOOL: toolName,
    SIDECAR_INPUT: JSON.stringify(input),
  };
  if (output !== undefined) {
    env.SIDECAR_OUTPUT = output.slice(0, 10_000); // Limit env var size
  }

  try {
    await execAsync(command, { cwd, timeout: 15_000, env });
  } catch (err) {
    console.warn(`[SideCar] Hook ${phase}:${toolName} failed:`, err);
  }
}
