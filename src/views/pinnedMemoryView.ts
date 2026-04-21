import {
  type Disposable,
  type ExtensionContext,
  type TreeDataProvider,
  type TreeItem,
  TreeItemCollapsibleState,
  EventEmitter,
  type Event,
  window,
  ThemeIcon,
  commands,
} from 'vscode';
import { PinnedMemoryStore, type PinnedEntry } from '../agent/memory/pinnedMemory.js';
import { getWorkspaceRoot } from '../config/workspace.js';
import * as path from 'path';
import * as fs from 'fs/promises';

const VIEW_ID = 'sidecar.pinnedMemory';

class PinnedEntryItem implements TreeItem {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly iconPath: ThemeIcon;
  readonly collapsibleState = TreeItemCollapsibleState.None;
  readonly contextValue = 'pinnedEntry';
  readonly command = undefined;

  constructor(readonly entry: PinnedEntry) {
    this.label = entry.label;
    this.description = entry.boost !== 1.0 ? `boost: ${entry.boost}` : entry.path;
    this.tooltip = `${entry.path}\nPinned: ${new Date(entry.pinnedAt).toLocaleString()}\n\n${entry.content.slice(0, 200)}${entry.content.length > 200 ? '…' : ''}`;
    this.iconPath = new ThemeIcon('pin');
  }
}

class PinnedMemoryTreeProvider implements TreeDataProvider<PinnedEntryItem> {
  private readonly _onDidChangeTreeData = new EventEmitter<PinnedEntryItem | undefined>();
  readonly onDidChangeTreeData: Event<PinnedEntryItem | undefined> = this._onDidChangeTreeData.event;

  constructor(private readonly store: PinnedMemoryStore) {
    store.setOnChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  getTreeItem(element: PinnedEntryItem): TreeItem {
    return element;
  }

  getChildren(): PinnedEntryItem[] {
    if (!this.store.isReady()) return [];
    return this.store.getEntries().map((e) => new PinnedEntryItem(e));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }
}

export function registerPinnedMemoryView(context: ExtensionContext, store: PinnedMemoryStore): Disposable {
  const provider = new PinnedMemoryTreeProvider(store);
  const treeView = window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });

  const pinCmd = commands.registerCommand('sidecar.pinToMemory', async () => {
    const root = getWorkspaceRoot();
    const input = await window.showInputBox({
      prompt: 'Enter a file path to pin (relative to workspace root)',
      placeHolder: 'docs/architecture.md',
    });
    if (!input) return;

    const absPath = root ? path.resolve(root, input) : input;
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf8');
    } catch {
      void window.showErrorMessage(`SideCar: Cannot read file: ${input}`);
      return;
    }

    const label = await window.showInputBox({
      prompt: 'Label for this pin (press Enter to use filename)',
      value: path.basename(input),
    });

    await store.pin(input, content, { label: label || path.basename(input) });
    void window.showInformationMessage(`SideCar: Pinned "${label || path.basename(input)}" to memory`);
  });

  const unpinCmd = commands.registerCommand('sidecar.unpinMemory', async (item?: PinnedEntryItem) => {
    if (item) {
      await store.unpin(item.entry.id);
      return;
    }
    const entries = store.getEntries();
    if (entries.length === 0) {
      void window.showInformationMessage('SideCar: No pinned memory entries.');
      return;
    }
    const pick = await window.showQuickPick(
      entries.map((e) => ({ label: e.label, description: e.path, id: e.id })),
      { placeHolder: 'Select an entry to unpin' },
    );
    if (pick) {
      await store.unpin(pick.id);
    }
  });

  const refreshCmd = commands.registerCommand('sidecar.pinnedMemory.refresh', async () => {
    // Re-read content for all entries from disk
    const root = getWorkspaceRoot();
    for (const entry of store.getEntries()) {
      try {
        const absPath = root ? path.resolve(root, entry.path) : entry.path;
        const fresh = await fs.readFile(absPath, 'utf8');
        await store.updateContent(entry.id, fresh);
      } catch {
        // File may have been deleted — leave stale content in place
      }
    }
    provider.refresh();
    void window.showInformationMessage('SideCar: Pinned memory refreshed');
  });

  // Also register "Pin active file" as a convenience
  const pinActiveCmd = commands.registerCommand('sidecar.pinActiveFileToMemory', async () => {
    const editor = window.activeTextEditor;
    if (!editor) {
      void window.showErrorMessage('SideCar: No active file to pin.');
      return;
    }
    const root = getWorkspaceRoot();
    const absPath = editor.document.uri.fsPath;
    const relPath = root ? path.relative(root, absPath) : absPath;
    const content = editor.document.getText();
    const label = path.basename(absPath);
    await store.pin(relPath, content, { label });
    void window.showInformationMessage(`SideCar: Pinned "${label}" to memory`);
  });

  // Handle "pin selection" — pin just the selected text with a label
  const pinSelectionCmd = commands.registerCommand('sidecar.pinSelectionToMemory', async () => {
    const editor = window.activeTextEditor;
    if (!editor) return;
    const selection = editor.document.getText(editor.selection.isEmpty ? undefined : editor.selection);
    if (!selection?.trim()) {
      void window.showErrorMessage('SideCar: Select some text to pin.');
      return;
    }
    const label = await window.showInputBox({
      prompt: 'Label for this pinned selection',
      placeHolder: 'e.g. "Domain invariants"',
    });
    if (!label) return;
    const root = getWorkspaceRoot();
    const absPath = editor.document.uri.fsPath;
    const relPath = root ? path.relative(root, absPath) : absPath;
    await store.pin(`${relPath}#selection`, selection, { label });
    void window.showInformationMessage(`SideCar: Pinned "${label}" to memory`);
  });

  context.subscriptions.push(treeView, pinCmd, unpinCmd, refreshCmd, pinActiveCmd, pinSelectionCmd);

  return treeView;
}
