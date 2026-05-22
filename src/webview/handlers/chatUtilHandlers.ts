import { window, workspace, Uri } from 'vscode';
import type { ChatState } from '../chatState.js';
import type { ContentBlock } from '../../ollama/types.js';
import { getContentText } from '../../ollama/types.js';
import { getConfig } from '../../config/settings.js';
import { getWorkspaceRoot } from '../../config/workspace.js';

// ---------------------------------------------------------------------------
// Chat utility handlers — stateless UI operations that read/write ChatState
// but do not invoke the agent loop or connection machinery.
// ---------------------------------------------------------------------------

export async function handleShowSystemPrompt(state: ChatState): Promise<void> {
  const config = getConfig();

  const pkg = state.context.extension?.packageJSON || {};
  const extensionVersion = pkg.version || 'unknown';
  const repoUrl = pkg.repository?.url || 'https://github.com/nedonatelli/sidecar';
  const docsUrl = 'https://nedonatelli.github.io/sidecar/';
  let systemPrompt = `You are SideCar v${extensionVersion}, an AI coding assistant running inside VS Code. GitHub: ${repoUrl} | Docs: ${docsUrl}\nProject root: ${getWorkspaceRoot()}\n\n(Use /verbose to see the full prompt sent during agent runs)`;

  const sidecarMd = await state.loadSidecarMd();
  if (sidecarMd) {
    systemPrompt += `\n\nProject instructions (from ${state.sidecarMdSource}):\n${sidecarMd}`;
  }

  const userSystemPrompt = config.systemPrompt;
  if (userSystemPrompt) {
    systemPrompt += `\n\n${userSystemPrompt}`;
  }

  state.postMessage({ command: 'verboseLog', content: systemPrompt, verboseLabel: 'System Prompt' });
}

export function handleDeleteMessage(state: ChatState, index: number): void {
  if (index < 0 || index >= state.messages.length) return;
  if (state.abortController) {
    state.postMessage({
      command: 'error',
      content: 'Cannot delete a message while the agent is running. Press Escape to stop the run first.',
      errorType: 'unknown',
    });
    return;
  }
  state.messages.splice(index, 1);
  state.saveHistory();
}

export async function handleExportChat(state: ChatState): Promise<void> {
  if (state.messages.length === 0) return;
  const lines: string[] = [];
  for (const msg of state.messages) {
    const label = msg.role === 'user' ? '## User' : '## Assistant';
    const text = getContentText(msg.content);
    lines.push(`${label}\n\n${text}\n`);
  }
  const content = lines.join('\n---\n\n');
  const uri = await window.showSaveDialog({
    filters: { Markdown: ['md'] },
    defaultUri: Uri.file('sidecar-chat.md'),
  });
  if (!uri) return;
  await workspace.fs.writeFile(uri, Buffer.from(content, 'utf-8'));
  window.showInformationMessage(`Chat exported to ${uri.fsPath.split('/').pop()}`);
}

export function handleUserMessageWithImages(
  state: ChatState,
  text: string,
  images: { mediaType: string; data: string }[],
): void {
  const content: ContentBlock[] = images.map((img) => ({
    type: 'image' as const,
    source: { type: 'base64' as const, media_type: img.mediaType as 'image/png', data: img.data },
  }));
  content.push({ type: 'text', text: text || '' });
  state.messages.push({ role: 'user', content });
  state.saveHistory();
}
