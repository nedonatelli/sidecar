import { workspace, window, commands, Uri } from 'vscode';
import type { EditBlock } from './parser.js';
import type { ProposedContentProvider } from './proposedContentProvider.js';

export async function showDiffPreview(
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
