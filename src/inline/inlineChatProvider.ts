import { window, workspace, Selection, Range, Position, WorkspaceEdit, type TextEditor } from 'vscode';
import * as path from 'path';
import { SideCarClient } from '../ollama/client.js';
import { getWorkspaceRoot } from '../config/workspace.js';
import type { ChatMessage } from '../ollama/types.js';

export async function handleInlineChat(client: SideCarClient): Promise<void> {
  const editor = window.activeTextEditor;
  if (!editor) {
    window.showWarningMessage('No active editor.');
    return;
  }

  const selection = editor.selection;
  const selectedText = editor.document.getText(selection);
  const hasSelection = !selection.isEmpty;

  // Show input box for instruction
  const instruction = await window.showInputBox({
    prompt: hasSelection
      ? `Edit selected code (${selectedText.split('\n').length} lines)`
      : 'Describe what to insert at cursor',
    placeHolder: hasSelection
      ? 'e.g. "add error handling", "convert to async"'
      : 'e.g. "add a function that...", "import lodash"',
  });

  if (!instruction) return;

  const root = getWorkspaceRoot();
  const fileName = root ? path.relative(root, editor.document.fileName) : editor.document.fileName;

  // Build context: surrounding code for better edits
  const doc = editor.document;
  const startLine = Math.max(0, selection.start.line - 20);
  const endLine = Math.min(doc.lineCount - 1, selection.end.line + 20);
  const surroundingCode = doc.getText(new Range(
    new Position(startLine, 0),
    new Position(endLine, doc.lineAt(endLine).text.length)
  ));

  let prompt: string;
  if (hasSelection) {
    prompt = `Edit the following code from ${fileName} (lines ${selection.start.line + 1}-${selection.end.line + 1}). ${instruction}

Surrounding context:
\`\`\`
${surroundingCode}
\`\`\`

Selected code to edit:
\`\`\`
${selectedText}
\`\`\`

Respond with ONLY the replacement code, no explanation, no code fences.`;
  } else {
    const cursorLine = selection.active.line + 1;
    prompt = `Insert code at line ${cursorLine} in ${fileName}. ${instruction}

Surrounding context:
\`\`\`
${surroundingCode}
\`\`\`

Respond with ONLY the code to insert, no explanation, no code fences.`;
  }

  const messages: ChatMessage[] = [{ role: 'user', content: prompt }];

  // Show progress while generating
  await window.withProgress(
    {
      location: { viewId: 'sidecar.chatView' },
      title: 'SideCar: generating...',
    },
    async () => {
      try {
        const result = await client.complete(messages, 2048);
        if (!result.trim()) {
          window.showWarningMessage('SideCar returned an empty response.');
          return;
        }
        await applyInlineEdit(editor, selection, result, hasSelection);
      } catch (err) {
        window.showErrorMessage(`SideCar inline chat failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  );
}

async function applyInlineEdit(
  editor: TextEditor,
  selection: Selection,
  newText: string,
  isReplace: boolean
): Promise<void> {
  const edit = new WorkspaceEdit();
  const uri = editor.document.uri;

  if (isReplace) {
    edit.replace(uri, selection, newText);
  } else {
    edit.insert(uri, selection.active, newText);
  }

  const success = await workspace.applyEdit(edit);
  if (!success) {
    window.showErrorMessage('Failed to apply inline edit.');
  }
}
