import { window } from 'vscode';
import { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getWorkspaceRoot } from '../config/workspace.js';

const execAsync = promisify(exec);

export async function summarizePR(client: SideCarClient): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    window.showWarningMessage('No workspace folder open.');
    return;
  }

  let diff: string;
  try {
    const { stdout } = await execAsync('git diff HEAD', { cwd, maxBuffer: 2 * 1024 * 1024 });
    if (!stdout.trim()) {
      const staged = await execAsync('git diff --cached', { cwd, maxBuffer: 2 * 1024 * 1024 });
      if (!staged.stdout.trim()) {
        window.showInformationMessage('No changes to summarize.');
        return;
      }
      diff = staged.stdout;
    } else {
      diff = stdout;
    }
  } catch (err) {
    window.showErrorMessage(`Failed to get git diff: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const maxDiffChars = 30_000;
  const truncatedDiff = diff.length > maxDiffChars
    ? diff.slice(0, maxDiffChars) + '\n... (diff truncated)'
    : diff;

  const messages: ChatMessage[] = [{
    role: 'user',
    content: `Generate a pull request summary for the following changes. Include:
1. A suggested PR title (one line)
2. A summary section with bullet points describing what changed and why
3. A list of files impacted
4. Key areas for reviewers to focus on

\`\`\`diff
${truncatedDiff}
\`\`\``,
  }];

  client.updateSystemPrompt('You are a PR summary generator. Be concise and focus on the "what" and "why" of changes.');

  await window.withProgress(
    { location: { viewId: 'sidecar.chatView' }, title: 'SideCar: generating PR summary...' },
    async () => {
      try {
        const summary = await client.complete(messages, 2048);
        const doc = await import('vscode').then(vsc =>
          vsc.workspace.openTextDocument({ content: summary, language: 'markdown' })
        );
        await window.showTextDocument(doc, { preview: true });
      } catch (err) {
        window.showErrorMessage(`PR summary failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}
