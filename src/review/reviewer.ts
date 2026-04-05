import { window } from 'vscode';
import { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { getWorkspaceRoot } from '../config/workspace.js';

const execAsync = promisify(exec);

export async function reviewCurrentChanges(client: SideCarClient): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    window.showWarningMessage('No workspace folder open.');
    return;
  }

  // Get the diff
  let diff: string;
  try {
    const { stdout } = await execAsync('git diff HEAD', { cwd, maxBuffer: 2 * 1024 * 1024 });
    if (!stdout.trim()) {
      // Try staged changes
      const staged = await execAsync('git diff --cached', { cwd, maxBuffer: 2 * 1024 * 1024 });
      if (!staged.stdout.trim()) {
        window.showInformationMessage('No changes to review (no staged or unstaged diffs).');
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

  // Truncate very large diffs
  const maxDiffChars = 30_000;
  const truncatedDiff = diff.length > maxDiffChars
    ? diff.slice(0, maxDiffChars) + '\n... (diff truncated)'
    : diff;

  const messages: ChatMessage[] = [{
    role: 'user',
    content: `Review the following code changes. For each issue found, provide:
- The file and line number
- The severity (critical, warning, suggestion)
- A clear description of the issue
- A suggested fix if applicable

Focus on: bugs, security issues, performance problems, edge cases, and code quality.

\`\`\`diff
${truncatedDiff}
\`\`\``,
  }];

  const systemPrompt = 'You are an expert code reviewer. Be thorough but concise. Only flag real issues — do not nitpick style or formatting unless it causes bugs.';
  client.updateSystemPrompt(systemPrompt);

  await window.withProgress(
    {
      location: { viewId: 'sidecar.chatView' },
      title: 'SideCar: reviewing changes...',
    },
    async () => {
      try {
        const review = await client.complete(messages, 4096);
        // Show in a new editor tab
        const doc = await import('vscode').then(vsc =>
          vsc.workspace.openTextDocument({ content: review, language: 'markdown' })
        );
        await window.showTextDocument(doc, { preview: true });
      } catch (err) {
        window.showErrorMessage(`Review failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}
