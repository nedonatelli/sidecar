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
  StatusBarAlignment,
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

// Duration (ms) the "done / failed" state lingers in the status bar
// before the item hides itself. Short enough not to be annoying; long
// enough that a user glancing at the bar after switching tabs sees it.
const BG_DONE_LINGER_MS = 6000;

export function registerBackgroundAgentsView(context: ExtensionContext, manager: BackgroundAgentManager): Disposable {
  const provider = new BackgroundAgentsTreeProvider(manager);
  const treeView = window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });

  // ── Status bar item ──────────────────────────────────────────────────────
  // Visible anywhere in VS Code (not just when the bg-agents panel is open).
  // Clicking it focuses the Background Agents panel.
  const statusItem = window.createStatusBarItem(StatusBarAlignment.Left, 10);
  statusItem.command = 'sidecar.backgroundAgents.focus';
  let lingerTimer: ReturnType<typeof setTimeout> | undefined;

  const updateStatusBar = (): void => {
    const runs = manager.list();
    const active = runs.filter((r) => r.status === 'running' || r.status === 'queued');
    const lastCompleted = runs.find((r) => r.status === 'completed' || r.status === 'failed');

    if (active.length > 0) {
      clearTimeout(lingerTimer);
      const n = active.length;
      statusItem.text = `$(sync~spin) ${n} bg agent${n === 1 ? '' : 's'}`;
      statusItem.tooltip = `${n} background agent${n === 1 ? '' : 's'} running — click to view`;
      statusItem.show();
    } else if (lastCompleted) {
      // All tasks are done — show a brief done/failed state then hide.
      clearTimeout(lingerTimer);
      if (lastCompleted.status === 'failed') {
        statusItem.text = `$(error) bg agent failed`;
        statusItem.tooltip = `Background agent failed: "${lastCompleted.task}" — click to view`;
      } else {
        statusItem.text = `$(check) bg agent done`;
        statusItem.tooltip = `Background agent completed: "${lastCompleted.task}" — click to view`;
      }
      statusItem.show();
      lingerTimer = setTimeout(() => statusItem.hide(), BG_DONE_LINGER_MS);
    } else {
      clearTimeout(lingerTimer);
      statusItem.hide();
    }
  };

  manager.onStatusChange(updateStatusBar);

  // ── Tree view badge ──────────────────────────────────────────────────────
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

  context.subscriptions.push(treeView, provider, statusItem, cancelCmd, clearCmd);

  return treeView;
}
