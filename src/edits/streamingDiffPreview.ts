/**
 * Streaming diff preview — shows file changes in VS Code's diff editor
 * as the agent proposes them, with Accept/Reject controls.
 *
 * The diff view opens immediately when a write/edit tool is invoked in
 * cautious mode. The ProposedContentProvider's onDidChange event enables
 * the diff to update incrementally if content changes.
 */

import { workspace, commands, Uri, ViewColumn } from 'vscode';
import type { ProposedContentProvider } from './proposedContentProvider.js';

export interface DiffPreviewSession {
  /** Update the proposed content (diff view refreshes automatically). */
  update(content: string): void;
  /** Finalize and wait for user to accept or reject. Returns the decision. */
  finalize(): Promise<'accept' | 'reject'>;
  /** Clean up the session. */
  dispose(): void;
}

/**
 * Open a diff view for a file and return a session that can be updated.
 *
 * @param filePath - Relative path to the file being edited
 * @param proposedContent - Initial proposed content
 * @param contentProvider - The VS Code content provider for the proposed:// scheme
 * @param confirmFn - Function to show accept/reject UI (reuses the chat confirmation system)
 */
export async function openDiffPreview(
  filePath: string,
  proposedContent: string,
  contentProvider: ProposedContentProvider,
  confirmFn: (message: string, actions: string[]) => Promise<string | undefined>,
): Promise<DiffPreviewSession> {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    throw new Error('No workspace folder open');
  }

  const originalUri = Uri.joinPath(workspaceFolders[0].uri, filePath);
  const key = `/${filePath}`;

  // Register initial proposed content
  const proposedUri = contentProvider.addProposal(key, proposedContent);

  // Open the diff editor
  await commands.executeCommand('vscode.diff', originalUri, proposedUri, `SideCar: ${filePath} (proposed)`, {
    preview: true,
    viewColumn: ViewColumn.One,
  });

  return {
    update(content: string) {
      // Update triggers onDidChange, VS Code refreshes the diff view
      contentProvider.addProposal(key, content);
    },

    async finalize(): Promise<'accept' | 'reject'> {
      const choice = await confirmFn(`Apply changes to **${filePath}**?`, ['Accept', 'Reject']);
      return choice === 'Accept' ? 'accept' : 'reject';
    },

    dispose() {
      contentProvider.removeProposal(key);
    },
  };
}
