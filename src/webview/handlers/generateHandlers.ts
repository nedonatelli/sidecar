import type { ChatState } from '../chatState.js';
import type { ChatMessage } from '../../ollama/types.js';
import { getConfig } from '../../config/settings.js';
import { getWorkspaceRoot } from '../../config/workspace.js';
import { GitCLI } from '../../github/git.js';

// ---------------------------------------------------------------------------
// Generate handlers — non-agent LLM operations that call state.client.complete()
// directly rather than running the full agent loop.
// ---------------------------------------------------------------------------

export async function handleGenerateCommit(state: ChatState): Promise<void> {
  const cwd = getWorkspaceRoot();
  if (!cwd) {
    state.postMessage({ command: 'error', content: 'No workspace folder open.' });
    return;
  }

  const git = new GitCLI(cwd);

  try {
    const status = await git.status();
    if (status === 'Working tree clean.') {
      state.postMessage({ command: 'assistantMessage', content: 'No changes to commit.' });
      state.postMessage({ command: 'done' });
      return;
    }

    const { diff } = await git.diff();
    if (diff === 'No diff output.') {
      state.postMessage({ command: 'assistantMessage', content: 'No diff found. Stage files first or make changes.' });
      state.postMessage({ command: 'done' });
      return;
    }

    const maxDiff = 15_000;
    const truncated = diff.length > maxDiff ? diff.slice(0, maxDiff) + '\n... (truncated)' : diff;

    state.postMessage({ command: 'setLoading', isLoading: true });
    state.postMessage({ command: 'assistantMessage', content: 'Generating commit message...\n\n' });

    const config = getConfig();
    state.client.updateConnection(config.baseUrl, config.apiKey);
    state.client.updateModel(config.model);

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: `Generate a concise git commit message for these changes. Follow conventional commits format (type: description). First line max 72 chars. Add a blank line then bullet points for details if needed. Output ONLY the commit message, nothing else.\n\n\`\`\`diff\n${truncated}\n\`\`\``,
      },
    ];

    let message = await state.client.complete(messages, 512);
    message = message
      .replace(/^```\w*\n?/, '')
      .replace(/\n?```$/, '')
      .trim();

    await git.stage();
    const result = await git.commit(message);

    state.postMessage({ command: 'assistantMessage', content: result + '\n' });
    state.postMessage({ command: 'done' });
    state.postMessage({ command: 'setLoading', isLoading: false });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.postMessage({ command: 'error', content: `Commit failed: ${msg}` });
    state.postMessage({ command: 'setLoading', isLoading: false });
  }
}

/**
 * Selective regeneration — rewrite one highlighted section of the last assistant
 * response without re-running the full agent loop.
 *
 * Builds a focused single-turn prompt, runs a non-agent completion against the
 * active model, and posts `regenSectionResult` back to the webview. The webview
 * replaces `selectedText` with the new text inside `dataset.rawContent` and
 * re-renders only that message div — the conversation history is unchanged so
 * the agent's original reasoning context is preserved.
 */
export async function handleRegenSection(
  state: ChatState,
  selectedText: string,
  instruction: string,
  msgIndex: number,
): Promise<void> {
  if (!selectedText.trim()) return;

  const prompt = instruction.trim()
    ? `Rewrite the following section. Return ONLY the replacement text — no preamble, no explanation, no surrounding quotes:\n\n${selectedText}\n\nInstruction: ${instruction}`
    : `Rewrite the following section more clearly and concisely. Return ONLY the replacement text — no preamble, no explanation:\n\n${selectedText}`;

  try {
    const newText = await state.client.complete([{ role: 'user', content: prompt }], /* maxTokens */ 1024);
    state.postMessage({
      command: 'regenSectionResult',
      msgIndex,
      originalText: selectedText,
      newText: newText.trim(),
    });
  } catch (err) {
    state.postMessage({
      command: 'error',
      content: `Selective regen failed: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
}
