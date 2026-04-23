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
      content: `Generate a git commit message for the diff below.

FORMAT RULES:
- Line 1: conventional commit subject — \`type(scope): summary\` — max 72 chars
  Valid types: feat | fix | refactor | perf | docs | test | chore | ci | style | build
  Scope is optional; use the module/file name when it adds clarity (e.g. \`feat(auth):\`)
- Line 2: blank
- Lines 3+: bullet list — one bullet per logical change. Cover EVERY meaningful addition,
  removal, or behavioural change visible in the diff. Be specific: name functions, files,
  flags, and thresholds. Do NOT omit anything just to keep it short.
  If a change fixes a bug or has a non-obvious reason, add a brief "Why:" clause on the same bullet.
- If any public API, config key, or CLI flag is removed or renamed, add a final
  \`BREAKING CHANGE: <description>\` paragraph after the bullets.
- Output ONLY the commit message — no preamble, no code fences, no commentary.

EXAMPLE OUTPUT:
feat(agent): add plan-mode approval shortcuts and numbered-list routing

- Add isPlanApproval() to recognise "yes/sure/go ahead" as plan execution
- Add isPlanRejection() to recognise "no/cancel/scratch that" as plan discard
- Route any other message while pendingPlan is set to handleRevisePlan
- Add isUndoRequest() shortcut — "undo/revert/rollback" → handleUndoChanges
- Add isCommitRequest() shortcut — "commit it/lgtm" → handleGenerateCommit
- Add isShowDiffRequest() — "what changed/diff" replays changeSummary without agent loop
- Add isDeferredAnswer() — "your call/I don't know" when pendingQuestion set injects
  "use best judgment and proceed" so agent doesn't stall waiting for missing info
- Wire all shortcuts in chatView.ts userMessage handler before agent loop

\`\`\`diff
${truncated}
\`\`\``,
    },
  ];

  client.updateSystemPrompt(
    'You are an expert at writing git commit messages. ' +
      'You follow the Conventional Commits specification precisely. ' +
      'Your commit bodies are thorough — you enumerate every change in the diff so a reviewer ' +
      'can understand the full scope of the commit without opening the diff. ' +
      'You never omit changes and you never add padding or filler text.',
  );

  await window.withProgress(
    { location: { viewId: 'sidecar.chatView' }, title: 'Generating commit message...' },
    async () => {
      try {
        let message = await client.complete(messages, 1024);
        // Clean up any code fence wrapping
        message = message
          .replace(/^```\w*\n?/, '')
          .replace(/\n?```$/, '')
          .trim();

        // Append Co-Authored-By trailer
        message += '\n\nCo-Authored-By: SideCar <274544454+SideCarAI-Bot@users.noreply.github.com>';

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
