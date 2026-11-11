/**
 * `sidecar_delegate`: hand a task from Copilot Chat to SideCar (#493).
 *
 * The `@sidecar` chat participant does this today, but VS Code's Copilot
 * harness does not run chat participants, and the Local harness that still
 * does is removed in February 2027. Extension tools are available in both, so
 * this tool carries what the participant is for: SideCar's own agent loop on
 * the user's configured backend, not Copilot's model.
 *
 * It shares its runs with the participant (`runSidecarAgent`,
 * `streamSlashCompletion`), so approval is the same: the user's
 * `sidecar.agentMode`, asking through a modal. VS Code also shows its own
 * confirmation before any extension tool runs; `prepareInvocation` says there
 * what will happen. A tool returns one result -- nothing streams -- so the
 * text the run produced and the files it changed come back at the end.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import type { SideCarClient } from '../ollama/client.js';
import type { MCPManager } from '../agent/mcpManager.js';
import { getConfig } from '../config/settings.js';
import { getWorkspaceRoot } from '../config/workspace.js';
import {
  GENERIC_SYSTEM_PROMPT,
  SLASH_COMMANDS,
  readUri,
  runSidecarAgent,
  streamSlashCompletion,
  tokenToSignal,
} from './sidecarParticipant.js';

export const DELEGATE_TOOL_NAME = 'sidecar_delegate';

export type DelegateMode = 'agent' | 'review' | 'fix' | 'explain' | 'commit-message';

export interface DelegateInput {
  task: string;
  mode?: DelegateMode;
  /** Workspace files to attach, relative to the workspace root. */
  files?: string[];
}

/**
 * Resolve a requested attachment inside the workspace, or undefined when it
 * points outside it. The calling model chose the path, and attaching a file
 * sends it to SideCar's backend, so it stays inside the workspace as SideCar's
 * own file tools do.
 */
export function resolveAttachment(root: string, file: string): string | undefined {
  const abs = path.resolve(root, file);
  const rel = path.relative(root, abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? abs : undefined;
}

/**
 * The user message the run starts from. The task text is written by the
 * calling model, not the user, so unlike the participant it is not recorded
 * as user-authored.
 */
export async function buildDelegateMessage(input: DelegateInput, root: string): Promise<string> {
  const cmd = input.mode && input.mode !== 'agent' ? SLASH_COMMANDS[input.mode] : undefined;
  const text = cmd ? cmd.preamble(input.task) : input.task;
  const attachments: string[] = [];
  for (const file of input.files ?? []) {
    const abs = resolveAttachment(root, file);
    if (!abs) {
      attachments.push(`\`${file}\`: not attached (outside the workspace)`);
      continue;
    }
    const content = await readUri(vscode.Uri.file(abs));
    attachments.push(content ? `\`${file}\`:\n\`\`\`\n${content}\n\`\`\`` : `\`${file}\`: not attached (unreadable)`);
  }
  return attachments.length > 0 ? `${text}\n\n${attachments.join('\n\n')}` : text;
}

/**
 * Register `sidecar_delegate`. Its name and input schema must match the
 * `languageModelTools` entry in package.json.
 */
export function registerDelegateTool(
  context: vscode.ExtensionContext,
  getClient: () => SideCarClient,
  mcpManager?: MCPManager,
): void {
  if (typeof vscode.lm?.registerTool !== 'function') return;

  const disposable = vscode.lm.registerTool<DelegateInput>(DELEGATE_TOOL_NAME, {
    prepareInvocation(options) {
      const { task, mode = 'agent' } = options.input;
      const config = getConfig();
      const summary = task.length > 300 ? `${task.slice(0, 300)}…` : task;
      const how =
        mode === 'agent'
          ? `SideCar runs its agent on \`${config.model}\` under your \`${config.agentMode}\` mode, and may read, edit and run commands in this workspace.`
          : `SideCar answers with \`${config.model}\` (${mode}); it changes no files.`;
      return {
        invocationMessage: `Delegating to SideCar (${mode})`,
        confirmationMessages: {
          title: 'Hand this task to SideCar?',
          message: `${how}\n\n> ${summary.replace(/\n/g, '\n> ')}`,
        },
      };
    },

    async invoke(options, token) {
      const input = options.input;
      const mode = input.mode ?? 'agent';
      const cmd = mode !== 'agent' ? SLASH_COMMANDS[mode] : undefined;
      if (mode !== 'agent' && !cmd)
        throw new Error(`Unknown mode "${mode}". Use agent, review, fix, explain or commit-message.`);

      const root = getWorkspaceRoot();
      const messages = [{ role: 'user' as const, content: await buildDelegateMessage(input, root) }];
      const signal = tokenToSignal(token);
      const out: string[] = [];
      let toolErrors = 0;
      let edited = new Set<string>();

      try {
        if (cmd) {
          await streamSlashCompletion(getClient(), messages, cmd.systemPrompt, signal, (t) => out.push(t));
        } else {
          edited = await runSidecarAgent(
            getClient(),
            messages,
            GENERIC_SYSTEM_PROMPT,
            signal,
            { onText: (t) => out.push(t), onProgress: () => {}, onToolError: () => toolErrors++ },
            mcpManager,
          );
        }
      } catch (err) {
        if (!(err instanceof Error && err.name === 'AbortError')) throw err;
        out.push('\n\n[SideCar run cancelled]');
      }

      let text = out.join('').trim() || '(SideCar returned no text)';
      if (toolErrors > 0) text += `\n\n${toolErrors} of SideCar's tool calls returned an error.`;
      if (edited.size > 0) {
        text += `\n\nFiles changed:\n${[...edited].map((f) => `- ${path.relative(root, f) || f}`).join('\n')}`;
      }
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(text)]);
    },
  });
  context.subscriptions.push(disposable);
}
