import { window } from 'vscode';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../ollama/types.js';
import { findTool } from './tools.js';
import type { ChangeLog } from './changelog.js';

export type ApprovalMode = 'autonomous' | 'cautious' | 'manual';

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export async function executeTool(
  toolUse: ToolUseContentBlock,
  approvalMode: ApprovalMode = 'cautious',
  changelog?: ChangeLog
): Promise<ToolResultContentBlock> {
  const tool = findTool(toolUse.name);

  if (!tool) {
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: `Unknown tool: ${toolUse.name}`,
      is_error: true,
    };
  }

  // Determine if approval is needed
  const needsApproval =
    approvalMode === 'manual' ||
    (approvalMode === 'cautious' && tool.requiresApproval);

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

  // Snapshot file before destructive operations
  if (changelog && WRITE_TOOLS.has(toolUse.name) && toolUse.input.path) {
    await changelog.snapshotFile(toolUse.input.path as string);
  }

  try {
    const result = await tool.executor(toolUse.input);
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
