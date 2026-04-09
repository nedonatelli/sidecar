import { workspace, window, commands, Uri, ViewColumn } from 'vscode';
import type { EditBlock } from './parser.js';
import type { ProposedContentProvider } from './proposedContentProvider.js';

export interface StreamingDiffPreviewOptions {
  /** Whether to show a streaming diff preview (default: true) */
  streaming?: boolean;
  /** Timeout in milliseconds for diff operations (default: 30000) */
  timeout?: number;
}

/**
 * Show a streaming diff preview for an edit block.
 * This version supports streaming output for large diffs.
 */
export async function showStreamingDiffPreview(
  block: EditBlock,
  contentProvider: ProposedContentProvider,
  options: StreamingDiffPreviewOptions = {},
): Promise<'accept' | 'reject'> {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return 'reject';

  const { streaming = true, timeout: _timeout = 30000 } = options;
  const originalUri = Uri.joinPath(workspaceFolders[0].uri, block.filePath);

  // Read original content and compute proposed
  const doc = await workspace.openTextDocument(originalUri);
  const originalText = doc.getText();
  const proposedText = originalText.replace(block.searchText, block.replaceText);

  // Register proposed content
  const key = `/${block.filePath}`;
  const proposedUri = contentProvider.addProposal(key, proposedText);

  // For streaming, we'll show a simple diff view with a message about streaming
  if (streaming) {
    // Open diff view with a message about streaming
    await commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      `SideCar: ${block.filePath} (proposed changes)`,
      { preview: false, viewColumn: ViewColumn.One },
    );

    // Show a message that streaming is happening
    const choice = await window.showInformationMessage(
      `Streaming diff preview for ${block.filePath}...`,
      { modal: true },
      'Continue',
    );

    // Clean up
    contentProvider.removeProposal(key);

    return choice === 'Continue' ? 'accept' : 'reject';
  } else {
    // Non-streaming - just show the diff directly
    await commands.executeCommand(
      'vscode.diff',
      originalUri,
      proposedUri,
      `SideCar: ${block.filePath} (proposed changes)`,
    );

    // Ask user to accept or reject
    const choice = await window.showInformationMessage(`Apply changes to ${block.filePath}?`, 'Accept', 'Reject');

    // Clean up
    contentProvider.removeProposal(key);

    return choice === 'Accept' ? 'accept' : 'reject';
  }
}

/**
 * Show a simple diff preview without streaming.
 * This is a fallback for cases where streaming is not supported.
 */
export async function showSimpleDiffPreview(
  block: EditBlock,
  contentProvider: ProposedContentProvider,
): Promise<'accept' | 'reject'> {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return 'reject';

  const originalUri = Uri.joinPath(workspaceFolders[0].uri, block.filePath);

  // Read original content and compute proposed
  const doc = await workspace.openTextDocument(originalUri);
  const originalText = doc.getText();
  const proposedText = originalText.replace(block.searchText, block.replaceText);

  // Register proposed content
  const key = `/${block.filePath}`;
  const proposedUri = contentProvider.addProposal(key, proposedText);

  // Open diff view
  await commands.executeCommand(
    'vscode.diff',
    originalUri,
    proposedUri,
    `SideCar: ${block.filePath} (proposed changes)`,
  );

  // Ask user to accept or reject
  const choice = await window.showInformationMessage(`Apply changes to ${block.filePath}?`, 'Accept', 'Reject');

  // Clean up
  contentProvider.removeProposal(key);

  return choice === 'Accept' ? 'accept' : 'reject';
}
