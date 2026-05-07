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
import type { BackgroundAgentManager, BackgroundAgentRunInfo } from '../agent/backgroundAgent.js';

const VIEW_ID = 'sidecar.backgroundAgents';

const STATUS_ICON: Record<string, string> = {
  queued: 'clock',
  running: 'sync~spin',
  completed: 'check',
  failed: 'error',
  cancelled: 'circle-slash',
};

class BgRunItem implements TreeItem {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly iconPath: ThemeIcon;
  readonly collapsibleState = TreeItemCollapsibleState.None;
  readonly contextValue: string;

  constructor(readonly run: BackgroundAgentRunInfo) {
    this.label = run.task.length > 60 ? run.task.slice(0, 57) + '…' : run.task;
    this.description = `${run.status} · ${run.toolCalls} tool${run.toolCalls === 1 ? '' : 's'}`;
    this.tooltip = [
      `Task: ${run.task}`,
      `Status: ${run.status}`,
      `Tools used: ${run.toolCalls}`,
      run.error ? `Error: ${run.error}` : '',
      run.output ? `\nOutput:\n${run.output.slice(0, 300)}${run.output.length > 300 ? '…' : ''}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    this.iconPath = new ThemeIcon(STATUS_ICON[run.status] ?? 'circle-outline');
    this.contextValue = run.status === 'running' || run.status === 'queued' ? 'bgRunActive' : 'bgRunDone';
  }
}

class BackgroundAgentsTreeProvider implements TreeDataProvider<BgRunItem> {
  private readonly _onDidChangeTreeData = new EventEmitter<BgRunItem | undefined>();
  readonly onDidChangeTreeData: Event<BgRunItem | undefined> = this._onDidChangeTreeData.event;

  private unsub: (() => void) | undefined;

  constructor(private readonly manager: BackgroundAgentManager) {
    this.unsub = manager.onStatusChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  getTreeItem(element: BgRunItem): TreeItem {
    return element;
  }

  getChildren(): BgRunItem[] {
    return this.manager
      .list()
      .sort((a, b) => b.startedAt - a.startedAt)
      .map((r) => new BgRunItem(r));
  }

  dispose(): void {
    this.unsub?.();
    this._onDidChangeTreeData.dispose();
  }
}

export function registerBackgroundAgentsView(context: ExtensionContext, manager: BackgroundAgentManager): Disposable {
  const provider = new BackgroundAgentsTreeProvider(manager);
  const treeView = window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });

  const updateBadge = (): void => {
    const active = manager.list().filter((r) => r.status === 'running' || r.status === 'queued').length;
    treeView.badge =
      active > 0 ? { value: active, tooltip: `${active} agent${active === 1 ? '' : 's'} running` } : undefined;
  };
  manager.onStatusChange(updateBadge);

  const cancelCmd = commands.registerCommand('sidecar.bgAgents.cancelRun', (item?: BgRunItem) => {
    if (item) manager.stop(item.run.id);
  });

  const clearCmd = commands.registerCommand('sidecar.bgAgents.clearCompleted', () => {
    manager.removeTerminated();
  });

  context.subscriptions.push(treeView, provider, cancelCmd, clearCmd);

  return treeView;
}
