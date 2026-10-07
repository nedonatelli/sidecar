/**
 * Expose a focused subset of SideCar's built-in tools to VS Code's Language
 * Model Tool API (`vscode.lm.registerTool`). Once registered, these tools
 * appear in `vscode.lm.tools` and are callable by Copilot agent mode, the
 * VS Code Agents Window, and any other extension that requests them.
 *
 * Tool names are prefixed with `sidecar_` to avoid collisions. Each name
 * must match the corresponding entry in the `languageModelTools` contribution
 * in package.json.
 *
 * Every call goes through executeTool, as a call from SideCar's own loop
 * does: the user's agent mode and tool permissions, repo policy, the typed
 * confirmation for destructive commands, hooks and the output fence all
 * apply. Calling the raw executors skipped all of them, and the tools asked
 * for no confirmation at all -- write_file and run_command included.
 */

import * as vscode from 'vscode';
import { TOOL_REGISTRY } from '../agent/tools.js';
import { getWorkspaceRoot } from '../config/workspace.js';
import type { ToolExecutorContext } from '../agent/tools/shared.js';
import { executeTool } from '../agent/executor.js';
import { getConfig } from '../config/settings.js';
import { participantApprovalOptions } from './sidecarParticipant.js';

/**
 * The core tool names to expose. Must match `languageModelTools[*].name`
 * in package.json (with the `sidecar_` prefix stripped for the registry
 * lookup).
 */
const EXPOSED_TOOLS: ReadonlyArray<string> = [
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'search_files',
  'run_command',
  'run_tests',
  'git_diff',
  'git_status',
  'git_log',
  'web_search',
];

/**
 * Register SideCar's core tools with VS Code's LM tool API.
 * Returns the disposables so the caller (extension.ts) can push them
 * onto `context.subscriptions`.
 *
 * Silently skips registration when `vscode.lm.registerTool` is not
 * available (VS Code < 1.90 or test environments).
 */
export function registerLmTools(context: vscode.ExtensionContext): void {
  if (typeof vscode.lm?.registerTool !== 'function') return;

  for (const toolName of EXPOSED_TOOLS) {
    const entry = TOOL_REGISTRY.find((t) => t.definition.name === toolName);
    if (!entry) continue;

    const lmName = `sidecar_${toolName}`;

    const disposable = vscode.lm.registerTool<Record<string, unknown>>(lmName, {
      async invoke(options, token) {
        const ac = new AbortController();
        const cancelSub = token.onCancellationRequested(() => ac.abort());

        const outputChunks: string[] = [];
        // The user's own mode, asking through a modal that shows the full
        // arguments -- the same approval the @sidecar participant uses.
        const approval = participantApprovalOptions(getConfig());
        const ctx: ToolExecutorContext = {
          signal: ac.signal,
          cwd: getWorkspaceRoot(),
          onOutput: (chunk) => outputChunks.push(chunk),
          modeToolPermissions: approval.modeToolPermissions,
        };

        try {
          const result = await executeTool(
            { type: 'tool_use', id: `lm-${toolName}-${Date.now()}`, name: toolName, input: options.input },
            { approvalMode: approval.approvalMode, confirmFn: approval.confirmFn, executorContext: ctx },
          );
          const content = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
          const text = outputChunks.length > 0 ? outputChunks.join('') + '\n' + content : content;
          return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
        } finally {
          cancelSub.dispose();
        }
      },

      prepareInvocation(options) {
        const input = options.input as Record<string, unknown>;
        // Show the primary resource in the progress message so the user
        // knows what the tool is acting on.
        const resource =
          (input.path as string | undefined) ??
          (input.command as string | undefined) ??
          (input.query as string | undefined) ??
          '';
        const label = resource ? `${toolName} ${resource}` : toolName;
        return { invocationMessage: label };
      },
    });

    context.subscriptions.push(disposable);
  }
}
