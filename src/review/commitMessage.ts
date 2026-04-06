import { window, env } from 'vscode';
import { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getWorkspaceRoot } from '../config/workspace.js';

const execAsync = promisify(exec);

export async function generateCommitMessage(client: SideCarClient): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    window.showWarningMessage('No workspace folder open.');
    return;
  }

  // Get staged diff, fall back to all changes
  let diff: string;
  try {
    const staged = await execAsync('git diff --cached', { cwd, maxBuffer: 2 * 1024 * 1024 });
    if (staged.stdout.trim()) {
      diff = staged.stdout;
    } else {
      const unstaged = await execAsync('git diff', { cwd, maxBuffer: 2 * 1024 * 1024 });
      if (!unstaged.stdout.trim()) {
        window.showInformationMessage('No changes to commit.');
        return;
      }
      diff = unstaged.stdout;
    }
  } catch (err) {
    window.showErrorMessage(`Failed to get git diff: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const maxDiff = 15_000;
  const truncated = diff.length > maxDiff ? diff.slice(0, maxDiff) + '\n... (truncated)' : diff;

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: `Generate a concise git commit message for these changes. Follow conventional commits format (type: description). First line max 72 chars. Add a blank line then bullet points for details if needed. Output ONLY the commit message, nothing else.\n\n\`\`\`diff\n${truncated}\n\`\`\``,
    },
  ];

  client.updateSystemPrompt('You are a git commit message generator. Be concise and accurate.');

  await window.withProgress(
    { location: { viewId: 'sidecar.chatView' }, title: 'Generating commit message...' },
    async () => {
      try {
        let message = await client.complete(messages, 512);
        // Clean up any code fence wrapping
        message = message
          .replace(/^```\w*\n?/, '')
          .replace(/\n?```$/, '')
          .trim();

        const action = await window.showInformationMessage(
          `Commit message: "${message.split('\n')[0]}"`,
          'Copy to Clipboard',
          'Edit & Copy',
        );

        if (action === 'Copy to Clipboard') {
          await env.clipboard.writeText(message);
          window.showInformationMessage('Commit message copied to clipboard.');
        } else if (action === 'Edit & Copy') {
          const edited = await window.showInputBox({
            value: message,
            prompt: 'Edit commit message',
          });
          if (edited) {
            await env.clipboard.writeText(edited);
            window.showInformationMessage('Commit message copied to clipboard.');
          }
        }
      } catch (err) {
        window.showErrorMessage(`Failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
