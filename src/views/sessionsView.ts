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
  readonly iconPath = new ThemeIcon('comment-discussion');
  readonly collapsibleState = TreeItemCollapsibleState.None;
  readonly contextValue = 'sessionEntry';
  readonly command = {
    command: 'sidecar.sessions.load',
    title: 'Load Session',
    arguments: [this],
  };

  constructor(readonly session: SavedSession) {
    this.label = session.name;
    const date = new Date(session.updatedAt ?? session.createdAt).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
    });
    const turns = session.messages.filter((m) => m.role === 'user').length;
    this.description = `${date} · ${turns} turn${turns === 1 ? '' : 's'}`;
    this.tooltip = [
      `Session: ${session.name}`,
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

  getChildren(): SessionItem[] {
    return this.manager
      .list()
      .sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt))
      .map((s) => new SessionItem(s));
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
}

export function registerSessionsView(
  context: ExtensionContext,
  manager: SessionManager,
  deps: SessionsViewDeps,
): Disposable {
  const provider = new SessionsTreeProvider(manager);
  const treeView = window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });

  const loadCmd = commands.registerCommand('sidecar.sessions.load', (item?: SessionItem) => {
    if (item) {
      deps.loadSession(item.session.id);
      provider.refresh();
    }
  });

  const deleteCmd = commands.registerCommand('sidecar.sessions.delete', (item?: SessionItem) => {
    if (!item) return;
    manager.delete(item.session.id);
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

  context.subscriptions.push(treeView, provider, loadCmd, deleteCmd, saveCmd);

  return treeView;
}
