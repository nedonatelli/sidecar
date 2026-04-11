import { workspace, Uri } from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../ollama/types.js';
import { findTool, type ToolExecutorContext } from './tools.js';
import type { ChangeLog } from './changelog.js';
import type { MCPManager } from './mcpManager.js';
import { getConfig } from '../config/settings.js';
import { checkWorkspaceConfigTrust } from '../config/workspaceTrust.js';
import type { AgentLogger } from './logger.js';
import { scanFile, formatIssues } from './securityScanner.js';

const execAsync = promisify(exec);

export type ApprovalMode = 'autonomous' | 'cautious' | 'manual' | 'plan';
export type ConfirmFn = (message: string, actions: string[]) => Promise<string | undefined>;
export type DiffPreviewFn = (filePath: string, proposedContent: string) => Promise<'accept' | 'reject'>;
export type InlineEditFn = (filePath: string, searchText: string, replaceText: string) => Promise<boolean>;
/** @deprecated Use diffPreviewFn — streaming behavior is now built into openDiffPreview. */
export type StreamingDiffPreviewFn = (filePath: string, proposedContent: string) => Promise<'accept' | 'reject'>;

const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

export async function executeTool(
  toolUse: ToolUseContentBlock,
  approvalMode: ApprovalMode = 'cautious',
  changelog?: ChangeLog,
  mcpManager?: MCPManager,
  logger?: AgentLogger,
  confirmFn?: ConfirmFn,
  diffPreviewFn?: DiffPreviewFn,
  executorContext?: ToolExecutorContext,
  inlineEditFn?: InlineEditFn,
  streamingDiffPreviewFn?: StreamingDiffPreviewFn,
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

  // --- ask_user: route through clarification UI ---
  if (toolUse.name === 'ask_user') {
    const question = ((toolUse.input as Record<string, unknown>).question as string) || 'What would you like to do?';
    const options = ((toolUse.input as Record<string, unknown>).options as string[]) || [];
    const allowCustom = ((toolUse.input as Record<string, unknown>).allow_custom as boolean) !== false;
    const clarifyFn = executorContext?.clarifyFn;

    if (!clarifyFn) {
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: 'No UI available for user clarification.',
        is_error: true,
      };
    }

    const response = await clarifyFn(question, options, allowCustom);
    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: response || '(User dismissed the question without answering)',
    };
  }

  const config = getConfig();
  // --- Per-tool permissions (highest priority) ---
  const permissions = config.toolPermissions;
  let explicitPermission: 'allow' | 'deny' | 'ask' | undefined = permissions[toolUse.name];

  // Warn once per session if tool permissions are defined at workspace level (supply-chain risk)
  if (explicitPermission) {
    const trust = await checkWorkspaceConfigTrust(
      'toolPermissions',
      'SideCar: This workspace defines tool permission overrides (e.g. auto-allow write_file). Only trust these from repositories you control.',
    );
    if (trust === 'blocked') {
      explicitPermission = undefined;
    }
  }

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
    // For edit_file with inline edit provider, show ghost text (tab to apply)
    if (
      inlineEditFn &&
      toolUse.name === 'edit_file' &&
      toolUse.input.path &&
      toolUse.input.search &&
      toolUse.input.replace
    ) {
      // Snapshot before the edit so we can revert if needed
      if (changelog) {
        await changelog.snapshotFile(toolUse.input.path as string);
      }
      const accepted = await inlineEditFn(
        toolUse.input.path as string,
        toolUse.input.search as string,
        toolUse.input.replace as string,
      );
      if (!accepted) {
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: 'Edit dismissed by user.',
          is_error: true,
        };
      }
      // User accepted via Tab — the inline completion already applied the text,
      // so we skip the normal tool executor and return success.
      return {
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: `Applied edit to ${toolUse.input.path}`,
      };
    }

    // For write tools with diff preview available, show a visual diff
    if (diffPreviewFn && WRITE_TOOLS.has(toolUse.name) && toolUse.input.path) {
      const filePath = toolUse.input.path as string;
      let proposedContent: string;

      if (toolUse.name === 'edit_file') {
        // Compute proposed content from search/replace
        try {
          const fileUri = Uri.joinPath(workspace.workspaceFolders![0].uri, filePath);
          const bytes = await workspace.fs.readFile(fileUri);
          const original = Buffer.from(bytes).toString('utf-8');
          proposedContent = original.replace(toolUse.input.search as string, toolUse.input.replace as string);
        } catch {
          proposedContent = toolUse.input.replace as string;
        }
      } else {
        // write_file — proposed content is the full new content
        proposedContent = (toolUse.input.content as string) || '';
      }

      // Use streaming diff preview if available (opens diff editor inline),
      // otherwise fall back to regular diff (modal dialog)
      const previewFn = streamingDiffPreviewFn || diffPreviewFn;
      const diffChoice = await previewFn(filePath, proposedContent);

      if (diffChoice !== 'accept') {
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: 'Tool call denied by user after diff preview.',
          is_error: true,
        };
      }
    } else {
      // Non-write tools or no diff preview — use inline confirm
      const inputSummary = Object.entries(toolUse.input)
        .map(([k, v]) => {
          const val = typeof v === 'string' && v.length > 80 ? v.slice(0, 80) + '...' : String(v);
          return `${k}: ${val}`;
        })
        .join(', ');

      const confirm = confirmFn || (async (_msg: string, _actions: string[]) => 'Deny');
      const choice = await confirm(`SideCar wants to use **${toolUse.name}**(${inputSummary})`, ['Allow', 'Deny']);

      if (choice !== 'Allow') {
        return {
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: 'Tool call denied by user.',
          is_error: true,
        };
      }
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
    const result = await tool.executor(toolUse.input, executorContext);

    // --- Post-hook ---
    await runHook('post', toolUse.name, toolUse.input, result);

    // --- Security scan after file writes ---
    let securityWarnings = '';
    if (WRITE_TOOLS.has(toolUse.name) && toolUse.input.path) {
      const issues = await scanFile(toolUse.input.path as string);
      if (issues.length > 0) {
        securityWarnings = `\n\n⚠️ Security scan:\n${formatIssues(issues)}`;
        logger?.warn(`[SECURITY] ${issues.length} issue(s) in ${toolUse.input.path}`);
      }
    }

    return {
      type: 'tool_result',
      tool_use_id: toolUse.id,
      content: result + securityWarnings,
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
  const config = getConfig();
  const hooks = config.hooks;
  const toolHook = hooks[toolName]?.[phase];
  const globalHook = hooks['*']?.[phase];
  const command = toolHook || globalHook;

  if (!command) return;

  // Warn once per session if hooks are defined at workspace level (supply-chain risk)
  const hookTrust = await checkWorkspaceConfigTrust(
    'hooks',
    'SideCar: This workspace defines hook commands that will execute shell commands. Only trust hooks from repositories you control.',
  );
  if (hookTrust === 'blocked') return;

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
