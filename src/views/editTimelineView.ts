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
import {
  EditTimelineStore,
  type TimelineEntry,
  computeDiffStats,
  formatDiffStats,
  fileLabel,
} from '../agent/editTimeline.js';

const VIEW_ID = 'sidecar.editTimeline';

class TimelineItem implements TreeItem {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly iconPath: ThemeIcon;
  readonly collapsibleState = TreeItemCollapsibleState.None;
  readonly contextValue = 'timelineFile';

  constructor(readonly entry: TimelineEntry) {
    this.label = fileLabel(entry.relPath);
    const stats = computeDiffStats(entry.originalContent, entry.newContent);
    const diffLabel = formatDiffStats(stats);
    const editWord = entry.editCount === 1 ? 'edit' : 'edits';
    this.description = `${entry.editCount} ${editWord} · ${diffLabel}`;
    this.tooltip = [
      entry.relPath,
      `First edit: ${new Date(entry.firstEditAt).toLocaleTimeString()}`,
      `Last edit:  ${new Date(entry.lastEditAt).toLocaleTimeString()}`,
      `Edits: ${entry.editCount}`,
      entry.originalContent === undefined
        ? '(new file — will be deleted on revert)'
        : `Lines: ${formatDiffStats(stats)}`,
    ].join('\n');
    this.iconPath = entry.originalContent === undefined ? new ThemeIcon('file-add') : new ThemeIcon('edit');
  }
}

class EditTimelineTreeProvider implements TreeDataProvider<TimelineItem> {
  private readonly _onDidChangeTreeData = new EventEmitter<TimelineItem | undefined>();
  readonly onDidChangeTreeData: Event<TimelineItem | undefined> = this._onDidChangeTreeData.event;

  private unsub: (() => void) | undefined;

  constructor(private store: EditTimelineStore) {
    this.unsub = store.onChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  /** Swap out the underlying store (e.g. after clearChat). */
  setStore(store: EditTimelineStore): void {
    this.unsub?.();
    this.store = store;
    this.unsub = store.onChange(() => this._onDidChangeTreeData.fire(undefined));
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: TimelineItem): TreeItem {
    return element;
  }

  getChildren(): TimelineItem[] {
    return this.store.list().map((e) => new TimelineItem(e));
  }

  dispose(): void {
    this.unsub?.();
    this._onDidChangeTreeData.dispose();
  }
}

export function registerEditTimelineView(context: ExtensionContext, store: EditTimelineStore): Disposable {
  const provider = new EditTimelineTreeProvider(store);
  const treeView = window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });

  const updateBadge = (): void => {
    const count = store.size;
    treeView.badge = count > 0 ? { value: count, tooltip: `${count} file${count === 1 ? '' : 's'} edited` } : undefined;
  };
  store.onChange(updateBadge);

  const revertCmd = commands.registerCommand('sidecar.editTimeline.revert', async (item?: TimelineItem) => {
    if (!item) return;
    const label =
      item.entry.originalContent === undefined ? 'Delete file (agent created it)' : 'Revert to pre-agent content';
    const choice = await window.showWarningMessage(
      `Revert "${item.entry.relPath}"? ${label}.`,
      { modal: true },
      'Revert',
    );
    if (choice !== 'Revert') return;
    try {
      await store.revert(item.entry.relPath);
    } catch (err) {
      void window.showErrorMessage(`SideCar: Revert failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const revertAllCmd = commands.registerCommand('sidecar.editTimeline.revertAll', async () => {
    const count = store.size;
    if (count === 0) return;
    const choice = await window.showWarningMessage(
      `Revert all ${count} file${count === 1 ? '' : 's'} to their pre-agent state?`,
      { modal: true },
      'Revert All',
    );
    if (choice !== 'Revert All') return;
    try {
      await store.revertAll();
    } catch (err) {
      void window.showErrorMessage(`SideCar: Revert failed — ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const clearCmd = commands.registerCommand('sidecar.editTimeline.clear', () => {
    store.clear();
  });

  context.subscriptions.push(treeView, provider, revertCmd, revertAllCmd, clearCmd);

  return treeView;
}
