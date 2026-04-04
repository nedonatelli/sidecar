import { workspace, Uri, Range, Position, WorkspaceEdit } from 'vscode';
import type { EditBlock } from './parser.js';

export async function applyEdit(block: EditBlock): Promise<boolean> {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) return false;

  const fileUri = Uri.joinPath(workspaceFolders[0].uri, block.filePath);
  const doc = await workspace.openTextDocument(fileUri);
  const text = doc.getText();

  // Exact match first
  let startIndex = text.indexOf(block.searchText);

  // Fuzzy match: normalize whitespace
  if (startIndex === -1) {
    const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
    const normalizedSearch = normalize(block.searchText);
    const normalizedText = normalize(text);
    const fuzzyIndex = normalizedText.indexOf(normalizedSearch);
    if (fuzzyIndex !== -1) {
      // Map back to original text position
      let origPos = 0;
      let normPos = 0;
      const trimmedText = text.replace(/^\s+/, (m) => { origPos = m.length; return ''; });
      // Simple approach: find lines containing the search content
      const searchLines = block.searchText.trim().split('\n').map(l => l.trim());
      const docLines = text.split('\n');
      for (let i = 0; i <= docLines.length - searchLines.length; i++) {
        let match = true;
        for (let j = 0; j < searchLines.length; j++) {
          if (docLines[i + j].trim() !== searchLines[j]) {
            match = false;
            break;
          }
        }
        if (match) {
          const startLine = i;
          const endLine = i + searchLines.length - 1;
          const range = new Range(
            new Position(startLine, 0),
            new Position(endLine, docLines[endLine].length)
          );
          const edit = new WorkspaceEdit();
          edit.replace(fileUri, range, block.replaceText);
          return workspace.applyEdit(edit);
        }
      }
      return false;
    }
    return false;
  }

  const startPos = doc.positionAt(startIndex);
  const endPos = doc.positionAt(startIndex + block.searchText.length);
  const range = new Range(startPos, endPos);

  const edit = new WorkspaceEdit();
  edit.replace(fileUri, range, block.replaceText);
  return workspace.applyEdit(edit);
}

export async function applyEdits(blocks: EditBlock[]): Promise<{ applied: number; failed: number }> {
  const workspaceFolders = workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    return { applied: 0, failed: blocks.length };
  }

  const rootUri = workspaceFolders[0].uri;
  const edit = new WorkspaceEdit();
  let failed = 0;

  for (const block of blocks) {
    const fileUri = Uri.joinPath(rootUri, block.filePath);
    try {
      const doc = await workspace.openTextDocument(fileUri);
      const text = doc.getText();
      const startIndex = text.indexOf(block.searchText);

      if (startIndex === -1) {
        failed++;
        continue;
      }

      const startPos = doc.positionAt(startIndex);
      const endPos = doc.positionAt(startIndex + block.searchText.length);
      edit.replace(fileUri, new Range(startPos, endPos), block.replaceText);
    } catch {
      failed++;
    }
  }

  const applied = blocks.length - failed;
  if (applied > 0) {
    await workspace.applyEdit(edit);
  }

  return { applied, failed };
}
