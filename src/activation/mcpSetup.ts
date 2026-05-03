import { workspace, ExtensionContext } from 'vscode';
import { getConfig } from '../config/settings.js';
import { checkWorkspaceConfigTrust } from '../config/workspaceTrust.js';
import { MCPManager, loadProjectMcpConfig, mergeMcpConfigs } from '../agent/mcpManager.js';

/**
 * Wire MCP server connections: merge settings + project .mcp.json, gate on
 * workspace trust, connect. Re-connects on config change.
 * Extracted from extension.ts to keep the entry point lean.
 */
export function initMcpSetup(context: ExtensionContext, mcpManager: MCPManager): void {
  const connectMcp = async () => {
    try {
      const settingsServers = getConfig().mcpServers;
      const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
      const projectServers = workspaceRoot ? await loadProjectMcpConfig(workspaceRoot) : {};
      const allServers = mergeMcpConfigs(projectServers, settingsServers);

      if (Object.keys(allServers).length === 0) return;

      const trust = await checkWorkspaceConfigTrust(
        'mcpServers',
        'SideCar: This workspace defines MCP server configs that may spawn external processes. Only trust these from repositories you control.',
      );
      if (trust === 'blocked') {
        console.log('[SideCar] Workspace MCP servers blocked by user');
        return;
      }
      await mcpManager.connect(allServers);
    } catch (err) {
      console.error('[SideCar] Failed to connect MCP servers:', err);
    }
  };

  const config = getConfig();
  if (Object.keys(config.mcpServers).length > 0 || workspace.workspaceFolders?.length) {
    setImmediate(connectMcp);
  }

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.mcpServers')) {
        connectMcp().catch((err) => console.error('[SideCar] Failed to reconnect MCP servers:', err));
      }
    }),
  );
}
