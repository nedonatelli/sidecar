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
import { SessionManager, type SavedSession } from '../agent/sessions.js';

const VIEW_ID = 'sidecar.sessions';

class SessionItem implements TreeItem {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly iconPath: ThemeIcon;
  readonly collapsibleState: TreeItemCollapsibleState;
  readonly contextValue = 'sessionEntry';
  readonly command = {
    command: 'sidecar.sessions.load',
    title: 'Load Session',
    arguments: [this],
  };

  constructor(
    readonly session: SavedSession,
    hasBranches = false,
  ) {
    this.label = session.name;
    const isBranch = !!session.parentId;
    this.iconPath = new ThemeIcon(isBranch ? 'git-branch' : 'comment-discussion');
    this.collapsibleState = hasBranches ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None;
    const date = new Date(session.updatedAt ?? session.createdAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    const turns = session.messages.filter((m) => m.role === 'user').length;
    this.description = `${date} · ${turns} turn${turns === 1 ? '' : 's'}`;
    this.tooltip = [
      `${isBranch ? 'Branch' : 'Session'}: ${session.name}`,
      `Created: ${new Date(session.createdAt).toLocaleString()}`,
      `Last updated: ${new Date(session.updatedAt ?? session.createdAt).toLocaleString()}`,
      `User turns: ${turns}`,
    ].join('\n');
  }
}

class SessionsTreeProvider implements TreeDataProvider<SessionItem> {
  private readonly _onDidChangeTreeData = new EventEmitter<SessionItem | undefined>();
  readonly onDidChangeTreeData: Event<SessionItem | undefined> = this._onDidChangeTreeData.event;

  constructor(private readonly manager: SessionManager) {}

  getTreeItem(element: SessionItem): TreeItem {
    return element;
  }

  getChildren(element?: SessionItem): SessionItem[] {
    const all = this.manager.list();

    if (!element) {
      // Root: sessions without a parentId, sorted newest first.
      const childIds = new Set(all.filter((s) => s.parentId).map((s) => s.parentId!));
      return all
        .filter((s) => !s.parentId)
        .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
        .map((s) => new SessionItem(s, childIds.has(s.id)));
    }

    // Children of a parent, sorted newest first.
    return all
      .filter((s) => s.parentId === element.session.id)
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
      .map((s) => new SessionItem(s, false));
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  dispose(): void {
    this._onDidChangeTreeData.dispose();
  }
}

export interface SessionsViewDeps {
  /** Load a session by ID into the active chat. */
  loadSession: (id: string) => void;
  /** Save the current chat under a user-supplied name. */
  saveCurrentSession: (name: string) => void;
  /** Fork the current chat into a new named branch. */
  branchCurrentSession: (name?: string) => void;
}

export function registerSessionsView(
  context: ExtensionContext,
  manager: SessionManager,
  deps: SessionsViewDeps,
): Disposable {
  const provider = new SessionsTreeProvider(manager);
  const treeView = window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });

  const loadCmd = commands.registerCommand('sidecar.sessions.load', (item?: SessionItem) => {
    const target = item ?? treeView.selection[0];
    if (!target) return;
    deps.loadSession(target.session.id);
    provider.refresh();
  });

  const deleteCmd = commands.registerCommand('sidecar.sessions.delete', (item?: SessionItem) => {
    const target = item ?? treeView.selection[0];
    if (!target) return;
    manager.delete(target.session.id);
    provider.refresh();
  });

  const renameCmd = commands.registerCommand('sidecar.sessions.rename', async (item?: SessionItem) => {
    const target = item ?? treeView.selection[0];
    if (!target) return;
    const newName = await window.showInputBox({
      prompt: 'Rename session',
      value: target.session.name,
      valueSelection: [0, target.session.name.length],
    });
    if (!newName?.trim()) return;
    manager.rename(target.session.id, newName.trim());
    provider.refresh();
  });

  const saveCmd = commands.registerCommand('sidecar.sessions.save', async () => {
    const name = await window.showInputBox({
      prompt: 'Name for this session',
      placeHolder: 'e.g. "Auth refactor"',
    });
    if (!name?.trim()) return;
    deps.saveCurrentSession(name.trim());
    provider.refresh();
    void window.showInformationMessage(`SideCar: Session "${name}" saved.`);
  });

  const branchCmd = commands.registerCommand('sidecar.sessions.branch', async (item?: SessionItem) => {
    // If invoked from the tree (on a specific session), load it first then branch.
    if (item) {
      deps.loadSession(item.session.id);
    }
    const name = await window.showInputBox({
      prompt: 'Name for this branch',
      placeHolder: 'e.g. "try-different-approach"',
    });
    if (!name?.trim()) return;
    deps.branchCurrentSession(name.trim());
    provider.refresh();
  });

  context.subscriptions.push(treeView, provider, loadCmd, deleteCmd, renameCmd, saveCmd, branchCmd);

  return treeView;
}
