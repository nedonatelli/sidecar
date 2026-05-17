import {
  window,
  workspace,
  commands,
  Selection,
  Range,
  Position,
  WorkspaceEdit,
  ProgressLocation,
  type TextEditor,
} from 'vscode';
import * as path from 'path';
import { SideCarClient } from '../ollama/client.js';
import { getWorkspaceRoot } from '../config/workspace.js';
import type { ChatMessage } from '../ollama/types.js';
import type { ProposedContentProvider } from '../edits/proposedContentProvider.js';

export async function handleInlineChat(
  client: SideCarClient,
  proposedContentProvider: ProposedContentProvider,
): Promise<void> {
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
  const surroundingCode = doc.getText(
    new Range(new Position(startLine, 0), new Position(endLine, doc.lineAt(endLine).text.length)),
  );

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

  // Stream the response with a cancellable progress notification
  const controller = new AbortController();
  let result = '';

  await window.withProgress(
    {
      location: ProgressLocation.Notification,
      title: 'SideCar: generating edit...',
      cancellable: true,
    },
    async (_progress, token) => {
      token?.onCancellationRequested?.(() => controller.abort());
      try {
        for await (const event of client.streamChat(messages, controller.signal)) {
          if (event.type === 'text') result += event.text;
        }
      } catch (err) {
        if (err instanceof Error && err.name !== 'AbortError') {
          window.showErrorMessage(`SideCar inline chat failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    },
  );

  if (controller.signal.aborted || !result.trim()) {
    if (!controller.signal.aborted) {
      window.showWarningMessage('SideCar returned an empty response.');
    }
    return;
  }

  // Show a diff preview so the user can review before applying
  const key = `inline-chat/${Date.now()}`;
  const beforeKey = `${key}/before`;
  const afterKey = `${key}/after`;
  const beforeUri = proposedContentProvider.addProposal(beforeKey, hasSelection ? selectedText : '');
  const afterUri = proposedContentProvider.addProposal(afterKey, result);
  const label = hasSelection ? 'Proposed Edit' : 'Code to Insert';

  await commands.executeCommand('vscode.diff', beforeUri, afterUri, `SideCar: ${label}`, { preview: true });

  const choice = await window.showInformationMessage(
    `Apply this ${hasSelection ? 'edit' : 'insertion'}?`,
    { modal: true },
    'Accept',
  );

  // Cleanup content-provider entries regardless of user choice
  proposedContentProvider.removeProposal(beforeKey);
  proposedContentProvider.removeProposal(afterKey);

  if (choice === 'Accept') {
    await applyInlineEdit(editor, selection, result, hasSelection);
  }
}

async function applyInlineEdit(
  editor: TextEditor,
  selection: Selection,
  newText: string,
  isReplace: boolean,
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
