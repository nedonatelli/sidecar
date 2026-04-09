/**
 * Inline edit suggestions — "tab to apply" ghost text for agent-proposed edits.
 *
 * When the agent proposes a file edit, this provider shows the changes as
 * inline ghost text at the edit location. The user presses Tab to accept
 * or Esc to dismiss, matching the Cursor/Copilot UX pattern.
 */

import {
  InlineCompletionItem,
  InlineCompletionItemProvider,
  InlineCompletionContext,
  TextDocument,
  Position,
  Range,
  CancellationToken,
  workspace,
  window,
  commands,
  Uri,
  Selection,
  TextEditorRevealType,
  StatusBarAlignment,
  Disposable,
} from 'vscode';

export interface PendingEdit {
  filePath: string; // relative to workspace root
  /** The text being replaced (search string). */
  searchText: string;
  /** The replacement text. */
  replaceText: string;
  /** Resolved absolute URI of the file. */
  fileUri: Uri;
  /** Resolved range in the document. */
  range: Range;
  /** Callback to invoke when the edit is accepted or dismissed. */
  resolve: (accepted: boolean) => void;
}

export class InlineEditProvider implements InlineCompletionItemProvider, Disposable {
  private pendingEdit: PendingEdit | null = null;
  private statusBarItem;
  private disposables: Disposable[] = [];

  constructor() {
    this.statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 100);
    this.statusBarItem.command = 'sidecar.acceptInlineEdit';
    this.disposables.push(this.statusBarItem);

    // Register accept/reject commands
    this.disposables.push(
      commands.registerCommand('sidecar.acceptInlineEdit', () => this.accept()),
      commands.registerCommand('sidecar.rejectInlineEdit', () => this.reject()),
    );
  }

  /**
   * Propose an inline edit. Opens the file, reveals the edit location,
   * and shows ghost text. Returns a promise that resolves when the user
   * accepts (true) or dismisses (false) the suggestion.
   */
  async proposeEdit(filePath: string, searchText: string, replaceText: string): Promise<boolean> {
    // Dismiss any existing proposal
    if (this.pendingEdit) {
      this.pendingEdit.resolve(false);
      this.pendingEdit = null;
    }

    const folders = workspace.workspaceFolders;
    if (!folders || folders.length === 0) return false;

    const fileUri = Uri.joinPath(folders[0].uri, filePath);

    // Open the document and find the edit range
    let doc: TextDocument;
    try {
      doc = await workspace.openTextDocument(fileUri);
    } catch {
      return false;
    }

    const text = doc.getText();
    const startIndex = text.indexOf(searchText);
    if (startIndex === -1) return false;

    const startPos = doc.positionAt(startIndex);
    const endPos = doc.positionAt(startIndex + searchText.length);
    const range = new Range(startPos, endPos);

    // Create a promise that resolves when user accepts or dismisses
    return new Promise<boolean>((resolve) => {
      this.pendingEdit = {
        filePath,
        searchText,
        replaceText,
        fileUri,
        range,
        resolve,
      };

      // Set context key so the Esc keybinding activates
      commands.executeCommand('setContext', 'sidecar.hasInlineEdit', true);

      // Show the file and position cursor at the edit
      this.showEditInEditor(doc, range);

      // Show status bar hint
      this.statusBarItem.text = '$(edit) SideCar: Tab to apply edit, Esc to dismiss';
      this.statusBarItem.show();
    });
  }

  private async showEditInEditor(doc: TextDocument, range: Range): Promise<void> {
    const editor = await window.showTextDocument(doc, { preserveFocus: false });

    // Move cursor to the start of the edit range and reveal it
    editor.selection = new Selection(range.start, range.start);
    editor.revealRange(range, TextEditorRevealType.InCenter);

    // Trigger inline suggestion so VS Code queries our provider
    // Small delay to let the editor focus settle
    setTimeout(() => {
      commands.executeCommand('editor.action.inlineSuggest.trigger');
    }, 100);
  }

  /** VS Code calls this when it wants inline completions. */
  provideInlineCompletionItems(
    document: TextDocument,
    position: Position,
    _context: InlineCompletionContext,
    _token: CancellationToken,
  ): InlineCompletionItem[] {
    if (!this.pendingEdit) return [];

    // Only provide the suggestion for the file with the pending edit
    if (document.uri.toString() !== this.pendingEdit.fileUri.toString()) return [];

    // Check if the cursor is at or near the edit range
    const edit = this.pendingEdit;
    if (!edit.range.contains(position) && !edit.range.start.isEqual(position)) {
      // Cursor is not at the edit location — still show the suggestion
      // if we're on the same line (user might have scrolled)
      if (position.line < edit.range.start.line || position.line > edit.range.end.line + 5) {
        return [];
      }
    }

    // Return the inline completion item with the replacement range.
    // The ghost text will show the new content replacing the old content.
    const item = new InlineCompletionItem(edit.replaceText, edit.range);

    // After accepting, run our accept command to clean up state
    item.command = {
      command: 'sidecar.onInlineEditAccepted',
      title: 'Inline edit accepted',
    };

    return [item];
  }

  /** Accept the pending edit. */
  accept(): void {
    if (!this.pendingEdit) return;
    const edit = this.pendingEdit;
    this.pendingEdit = null;
    this.statusBarItem.hide();
    commands.executeCommand('setContext', 'sidecar.hasInlineEdit', false);
    edit.resolve(true);
  }

  /** Reject/dismiss the pending edit. */
  reject(): void {
    if (!this.pendingEdit) return;
    const edit = this.pendingEdit;
    this.pendingEdit = null;
    this.statusBarItem.hide();
    commands.executeCommand('setContext', 'sidecar.hasInlineEdit', false);
    // Hide the inline suggestion
    commands.executeCommand('editor.action.inlineSuggest.hide');
    edit.resolve(false);
  }

  /** Check if there's a pending edit. */
  hasPendingEdit(): boolean {
    return this.pendingEdit !== null;
  }

  dispose(): void {
    if (this.pendingEdit) {
      this.pendingEdit.resolve(false);
      this.pendingEdit = null;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
