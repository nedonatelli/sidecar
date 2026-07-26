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
import { DurableMemoryStore, type DurableInstructionEntry } from '../agent/memory/durableMemory.js';

const VIEW_ID = 'sidecar.rememberedInstructions';

/** Truncate for the tree label — full text lives in the tooltip. */
function labelOf(text: string): string {
  return text.length > 60 ? text.slice(0, 60) + '…' : text;
}

class RememberedItem implements TreeItem {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly iconPath: ThemeIcon;
  readonly collapsibleState = TreeItemCollapsibleState.None;
  readonly contextValue = 'rememberedInstruction';

  constructor(readonly entry: DurableInstructionEntry) {
    this.label = labelOf(entry.text);
    this.description = entry.seenCount > 1 ? `×${entry.seenCount}` : '';
    this.tooltip =
      `${entry.text}\n\n` +
      `First remembered: ${new Date(entry.firstSeen).toLocaleString()}\n` +
      `Last reinforced: ${new Date(entry.lastSeen).toLocaleString()} (seen ×${entry.seenCount})\n` +
      `Source: ${entry.source}`;
    this.iconPath = new ThemeIcon('bookmark');
  }
}

class DurableMemoryTreeProvider implements TreeDataProvider<RememberedItem> {
  private readonly _onDidChangeTreeData = new EventEmitter<RememberedItem | undefined>();
  readonly onDidChangeTreeData: Event<RememberedItem | undefined> = this._onDidChangeTreeData.event;

  constructor(private readonly store: DurableMemoryStore | null) {
    store?.setOnChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  getTreeItem(element: RememberedItem): TreeItem {
    return element;
  }

  getChildren(): RememberedItem[] {
    if (!this.store?.isReady()) return [];
    return this.store.getEntries().map((e) => new RememberedItem(e));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }
}

/**
 * Management surface for cross-session durable-instruction memory (v0.122).
 *
 * v0.121 shipped memory formation with a one-time chat disclosure; this view
 * completes the trust contract — the user can SEE everything SideCar has
 * remembered, forget individual entries, or clear the store, without touching
 * `.sidecar/memory/durable-instructions.json` by hand. Other writers exist
 * (the MCP server keeps its own store instance over the same file), so
 * refresh re-reads from disk rather than trusting in-memory state.
 */
export function registerDurableMemoryView(context: ExtensionContext, store: DurableMemoryStore | null): Disposable {
  const provider = new DurableMemoryTreeProvider(store);
  const treeView = window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });

  const forgetCmd = commands.registerCommand('sidecar.memory.forgetInstruction', async (item?: RememberedItem) => {
    if (!store) return;
    if (item) {
      await store.remove(item.entry.id);
      return;
    }
    const entries = store.getEntries();
    if (entries.length === 0) {
      void window.showInformationMessage('SideCar: No remembered instructions.');
      return;
    }
    const pick = await window.showQuickPick(
      entries.map((e) => ({ label: labelOf(e.text), description: `seen ×${e.seenCount}`, id: e.id })),
      { placeHolder: 'Select an instruction to forget' },
    );
    if (pick) await store.remove(pick.id);
  });

  const clearCmd = commands.registerCommand('sidecar.memory.clearInstructions', async () => {
    if (!store) return;
    const count = store.size();
    if (count === 0) {
      void window.showInformationMessage('SideCar: No remembered instructions.');
      return;
    }
    const confirmed = await window.showWarningMessage(
      `Forget all ${count} remembered instruction${count === 1 ? '' : 's'}? Future sessions will no longer see them.`,
      { modal: true },
      'Forget All',
    );
    if (confirmed === 'Forget All') {
      await store.clear();
      void window.showInformationMessage('SideCar: Remembered instructions cleared.');
    }
  });

  const refreshCmd = commands.registerCommand('sidecar.memory.refreshInstructions', async () => {
    // Re-read from disk — the MCP server writes the same file from its own
    // store instance, so in-memory state can be stale.
    await store?.load();
    provider.refresh();
  });

  context.subscriptions.push(treeView, forgetCmd, clearCmd, refreshCmd);
  return treeView;
}
