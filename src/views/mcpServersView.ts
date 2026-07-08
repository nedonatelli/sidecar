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
  ThemeColor,
  commands,
} from 'vscode';
import type { MCPManager, MCPServerInfo } from '../agent/mcpManager.js';
import { getConfig } from '../config/settings.js';

const VIEW_ID = 'sidecar.mcpServers';

const STATUS_ICON: Record<string, string> = {
  connected: 'circle-filled',
  connecting: 'sync~spin',
  failed: 'error',
  disconnected: 'circle-outline',
};

const STATUS_COLOR: Record<string, string> = {
  connected: 'testing.iconPassed',
  connecting: 'charts.yellow',
  failed: 'testing.iconFailed',
  disconnected: 'disabledForeground',
};

class McpServerItem implements TreeItem {
  readonly label: string;
  readonly description: string;
  readonly tooltip: string;
  readonly iconPath: ThemeIcon;
  readonly collapsibleState = TreeItemCollapsibleState.None;
  readonly contextValue: string;

  constructor(readonly info: MCPServerInfo) {
    this.label = info.name;
    const toolLabel = `${info.toolCount} tool${info.toolCount === 1 ? '' : 's'}`;
    this.description = info.status === 'connected' ? toolLabel : info.status;
    this.tooltip = [
      `Server: ${info.name}`,
      `Status: ${info.status}`,
      `Transport: ${info.transport}`,
      info.status === 'connected' ? `Tools: ${toolLabel}` : '',
      info.status === 'connected'
        ? `Schemas: ${info.lazyToolSchemas ? 'lazy (describe_tool on first use)' : 'full (alwaysLoad)'}`
        : '',
      info.error ? `Error: ${info.error}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    this.iconPath = new ThemeIcon(
      STATUS_ICON[info.status] ?? 'circle-outline',
      new ThemeColor(STATUS_COLOR[info.status] ?? 'foreground'),
    );
    this.contextValue = info.status === 'failed' || info.status === 'disconnected' ? 'mcpServerFailed' : 'mcpServerOk';
  }
}

class McpServersTreeProvider implements TreeDataProvider<McpServerItem> {
  private readonly _onDidChangeTreeData = new EventEmitter<McpServerItem | undefined>();
  readonly onDidChangeTreeData: Event<McpServerItem | undefined> = this._onDidChangeTreeData.event;

  private unsub: (() => void) | undefined;

  constructor(private readonly manager: MCPManager) {
    this.unsub = manager.onStatusChange(() => this._onDidChangeTreeData.fire(undefined));
  }

  getTreeItem(element: McpServerItem): TreeItem {
    return element;
  }

  getChildren(): McpServerItem[] {
    return this.manager.getServerStatus().map((s) => new McpServerItem(s));
  }

  dispose(): void {
    this.unsub?.();
    this._onDidChangeTreeData.dispose();
  }
}

export function registerMcpServersView(context: ExtensionContext, manager: MCPManager): Disposable {
  const provider = new McpServersTreeProvider(manager);
  const treeView = window.createTreeView(VIEW_ID, { treeDataProvider: provider, showCollapseAll: false });

  const updateBadge = (): void => {
    const failed = manager.getServerStatus().filter((s) => s.status === 'failed' || s.status === 'disconnected').length;
    treeView.badge =
      failed > 0 ? { value: failed, tooltip: `${failed} server${failed === 1 ? '' : 's'} offline` } : undefined;
  };
  manager.onStatusChange(updateBadge);

  const reconnectCmd = commands.registerCommand('sidecar.mcp.reconnectServer', (item?: McpServerItem) => {
    if (item) void manager.reconnectServer(item.info.name);
  });

  const reconnectAllCmd = commands.registerCommand('sidecar.mcp.reconnectAll', () => {
    void manager.connect(getConfig().mcpServers ?? {});
  });

  context.subscriptions.push(treeView, provider, reconnectCmd, reconnectAllCmd);

  return treeView;
}
