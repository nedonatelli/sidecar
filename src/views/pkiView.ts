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
  QuickPickItem,
} from 'vscode';
import type { SymbolEmbeddingIndex } from '../config/symbolEmbeddingIndex.js';
import type { SymbolIndexer } from '../config/symbolIndexer.js';
import type { WorkspaceIndex } from '../config/workspaceIndex.js';

const VIEW_ID = 'sidecar.pki';

// ---------------------------------------------------------------------------
// Tree items
// ---------------------------------------------------------------------------

type PkiItemKind = 'stat' | 'action';

class PkiItem implements TreeItem {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly iconPath: ThemeIcon;
  readonly collapsibleState = TreeItemCollapsibleState.None;
  readonly command?: TreeItem['command'];
  readonly contextValue: string;

  constructor(opts: {
    label: string;
    description?: string;
    tooltip?: string;
    icon: string;
    kind: PkiItemKind;
    command?: string;
    commandTitle?: string;
  }) {
    this.label = opts.label;
    this.description = opts.description;
    this.tooltip = opts.tooltip;
    this.iconPath = new ThemeIcon(opts.icon);
    this.contextValue = opts.kind;
    if (opts.command) {
      this.command = { command: opts.command, title: opts.commandTitle ?? opts.label, arguments: [] };
    }
  }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class PkiTreeProvider implements TreeDataProvider<PkiItem>, Disposable {
  private readonly _onDidChangeTreeData = new EventEmitter<PkiItem | undefined>();
  readonly onDidChangeTreeData: Event<PkiItem | undefined> = this._onDidChangeTreeData.event;

  private symbolEmbeddings: SymbolEmbeddingIndex | null = null;
  private symbolIndexer: SymbolIndexer | null = null;
  private workspaceIndex: WorkspaceIndex | null = null;
  private diskBytes: number | null = null;

  setIndex(symbolEmbeddings: SymbolEmbeddingIndex, symbolIndexer: SymbolIndexer, workspaceIndex: WorkspaceIndex): void {
    this.symbolEmbeddings = symbolEmbeddings;
    this.symbolIndexer = symbolIndexer;
    this.workspaceIndex = workspaceIndex;

    // Refresh the panel whenever the index finishes a drain.
    symbolEmbeddings.setOnDrained(() => {
      void this.refreshDiskBytes();
      this._onDidChangeTreeData.fire(undefined);
    });

    void this.refreshDiskBytes().then(() => this._onDidChangeTreeData.fire(undefined));
  }

  private async refreshDiskBytes(): Promise<void> {
    if (!this.symbolEmbeddings) return;
    this.diskBytes = await this.symbolEmbeddings.getDiskBytes();
  }

  refresh(): void {
    void this.refreshDiskBytes().then(() => this._onDidChangeTreeData.fire(undefined));
  }

  getTreeItem(element: PkiItem): TreeItem {
    return element;
  }

  getChildren(): PkiItem[] {
    if (!this.symbolEmbeddings) {
      return [new PkiItem({ label: 'Not initialised', icon: 'circle-outline', kind: 'stat' })];
    }

    const indexed = this.symbolEmbeddings.getCount();
    const pending = this.symbolEmbeddings.pendingCount();
    const lastMs = this.symbolEmbeddings.getLastUpdatedMs();

    const items: PkiItem[] = [
      new PkiItem({
        label: 'Symbols indexed',
        description: pending > 0 ? `${indexed.toLocaleString()} (${pending} queued)` : indexed.toLocaleString(),
        icon: pending > 0 ? 'loading~spin' : 'database',
        kind: 'stat',
      }),
      new PkiItem({
        label: 'Last update',
        description: lastMs ? timeAgo(lastMs) : 'never',
        tooltip: lastMs ? new Date(lastMs).toLocaleString() : undefined,
        icon: 'calendar',
        kind: 'stat',
      }),
      new PkiItem({
        label: 'Disk usage',
        description: this.diskBytes !== null ? formatBytes(this.diskBytes) : '—',
        icon: 'archive',
        kind: 'stat',
      }),
    ];

    items.push(
      new PkiItem({
        label: 'Rebuild index',
        tooltip: 'Clear the symbol cache and re-embed all workspace symbols from scratch',
        icon: 'refresh',
        kind: 'action',
        command: 'sidecar.pki.rebuild',
        commandTitle: 'Rebuild PKI',
      }),
      new PkiItem({
        label: 'Search symbols…',
        tooltip: 'Run a semantic search over indexed symbols',
        icon: 'search',
        kind: 'action',
        command: 'sidecar.pki.search',
        commandTitle: 'Search PKI',
      }),
    );

    return items;
  }

  async rebuild(): Promise<void> {
    if (!this.symbolEmbeddings || !this.symbolIndexer || !this.workspaceIndex) {
      void window.showWarningMessage('SideCar PKI: index not ready yet.');
      return;
    }
    await this.symbolEmbeddings.clearAll();
    this.refresh();
    for (const file of this.workspaceIndex.getFiles()) {
      this.symbolIndexer.queueUpdate(file.relativePath);
    }
    void window.showInformationMessage('SideCar PKI: rebuilding index from scratch…');
  }

  async search(): Promise<void> {
    if (!this.symbolEmbeddings || !this.symbolEmbeddings.isReady() || this.symbolEmbeddings.getCount() === 0) {
      void window.showWarningMessage('SideCar PKI: index not ready or empty.');
      return;
    }
    const query = await window.showInputBox({
      prompt: 'Semantic symbol search',
      placeHolder: 'e.g. "auth middleware", "rate limiter", "database connection"',
    });
    if (!query) return;

    const results = await this.symbolEmbeddings.search(query, 10);
    if (results.length === 0) {
      void window.showInformationMessage(`SideCar PKI: no results for "${query}"`);
      return;
    }

    const picks: QuickPickItem[] = results.map((r) => ({
      label: r.name,
      description: `${r.kind} · ${r.filePath}:${r.startLine}`,
      detail: `score ${r.similarity.toFixed(3)} · ${r.qualifiedName}`,
    }));

    await window.showQuickPick(picks, {
      title: `PKI search: "${query}" — ${results.length} results`,
      matchOnDescription: true,
      matchOnDetail: true,
    });
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerPkiView(context: ExtensionContext): { view: Disposable; provider: PkiTreeProvider } {
  const provider = new PkiTreeProvider();
  const treeView = window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });

  const rebuildCmd = commands.registerCommand('sidecar.pki.rebuild', () => provider.rebuild());
  const searchCmd = commands.registerCommand('sidecar.pki.search', () => provider.search());

  context.subscriptions.push(treeView, provider, rebuildCmd, searchCmd);
  return { view: treeView, provider };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeAgo(ms: number): string {
  const diff = Math.floor((Date.now() - ms) / 1000);
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}
