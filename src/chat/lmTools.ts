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

import * as path from 'path';
import * as vscode from 'vscode';
import type { ToolDefinition } from '../ollama/types.js';
import { TOOL_REGISTRY } from '../agent/tools.js';
import { getWorkspaceRoot } from '../config/workspace.js';
import type { ToolExecutorContext } from '../agent/tools/shared.js';
import { executeTool } from '../agent/executor.js';
import { getConfig } from '../config/settings.js';
import { participantApprovalOptions } from './sidecarParticipant.js';
import { DIFF_STREAM_PREFIX } from '../agent/tools/diffStream.js';

/**
 * The core tool names to expose. Must match `languageModelTools[*].name`
 * in package.json (with the `sidecar_` prefix stripped for the registry
 * lookup).
 */
export const EXPOSED_TOOLS: ReadonlyArray<string> = [
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

/** Top-level arguments that hold a workspace path. */
const PATH_ARGS: ReadonlyArray<string> = ['path', 'file'];
const ABSOLUTE_PATH_NOTE = 'An absolute path inside the workspace also works.';

/**
 * The `inputSchema` package.json declares for an exposed tool (#495): the
 * registry's own schema, with each path argument noting that an absolute path
 * inside the workspace is accepted. VS Code's tool guide tells calling models
 * to send absolute paths. A test keeps package.json equal to this.
 */
export function lmInputSchema(def: ToolDefinition): ToolDefinition['input_schema'] {
  const properties = Object.fromEntries(
    Object.entries(def.input_schema.properties).map(([key, value]) => {
      const prop = value as { type?: unknown; description?: unknown };
      if (!PATH_ARGS.includes(key) || prop?.type !== 'string') return [key, value];
      const description = typeof prop.description === 'string' ? `${prop.description.replace(/\.?\s*$/, '')}. ` : '';
      return [key, { ...prop, description: `${description}${ABSOLUTE_PATH_NOTE}` }];
    }),
  );
  return { ...def.input_schema, properties };
}

/**
 * The call's arguments with absolute path arguments inside the workspace made
 * workspace-relative (#495). SideCar's file tools refuse absolute paths, and
 * a calling model following VS Code's guidance sends them. A path outside the
 * workspace is left alone, so the tool's own check refuses it.
 */
export function relativizePathArgs(input: unknown, root: string): Record<string, unknown> {
  const args = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  if (!root) return args;
  let out = args;
  for (const key of PATH_ARGS) {
    const value = args[key];
    if (typeof value !== 'string' || !path.isAbsolute(value)) continue;
    const rel = path.relative(root, value);
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
    out = { ...out, [key]: rel === '' ? '.' : rel.split(path.sep).join('/') };
  }
  return out;
}

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
          // A diff chunk is for the chat view to render; the result already
          // says what changed. Forwarding it handed the calling model the raw
          // stream marker (#165 ML-55).
          onOutput: (chunk) => {
            if (!chunk.startsWith(DIFF_STREAM_PREFIX)) outputChunks.push(chunk);
          },
          modeToolPermissions: approval.modeToolPermissions,
        };

        try {
          const result = await executeTool(
            {
              type: 'tool_use',
              id: `lm-${toolName}-${Date.now()}`,
              name: toolName,
              input: relativizePathArgs(options.input, getWorkspaceRoot()),
            },
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
