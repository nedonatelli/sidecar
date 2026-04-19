import { window } from 'vscode';
import { SideCarClient } from '../ollama/client.js';
import type { ChatMessage } from '../ollama/types.js';
import { getWorkspaceRoot } from '../config/workspace.js';
import { fetchWorkingTreeDiff } from './diffSource.js';

export async function reviewCurrentChanges(client: SideCarClient): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    window.showWarningMessage('No workspace folder open.');
    return;
  }

  const result = await fetchWorkingTreeDiff({ cwd });
  if (result.error) {
    window.showErrorMessage(`Failed to get git diff: ${result.error}`);
    return;
  }
  if (result.isEmpty) {
    window.showInformationMessage('No changes to review (no staged or unstaged diffs).');
    return;
  }

  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: `Review the following code changes. For each issue found, provide:
- The file and line number
- The severity (critical, warning, suggestion)
- A clear description of the issue
- A suggested fix if applicable

Focus on: bugs, security issues, performance problems, edge cases, and code quality.

\`\`\`diff
${result.diff}
\`\`\``,
    },
  ];

  const systemPrompt =
    'You are an expert code reviewer. Be thorough but concise. Only flag real issues — do not nitpick style or formatting unless it causes bugs.';
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
        const doc = await import('vscode').then((vsc) =>
          vsc.workspace.openTextDocument({ content: review, language: 'markdown' }),
        );
        await window.showTextDocument(doc, { preview: true });
      } catch (err) {
        window.showErrorMessage(`Review failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );
}
