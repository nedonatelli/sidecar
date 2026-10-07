import { workspace, ExtensionContext } from 'vscode';
import { logger } from '../system/logger.js';
import { getConfig } from '../config/settings.js';
import { checkWorkspaceConfigTrust } from '../config/workspaceTrust.js';
import { MCPManager, loadProjectMcpConfig, mergeMcpConfigs } from '../agent/mcpManager.js';

/**
 * Wire MCP server connections: merge settings + project .mcp.json, gate on
 * workspace trust, connect. Re-connects on config change.
 * Extracted from extension.ts to keep the entry point lean.
 */
/**
 * Connect every configured MCP server -- settings plus the project's
 * `.mcp.json` -- behind the workspace trust prompt. The ONE path to connect:
 * "Reconnect All" in the MCP view used to call `manager.connect` directly,
 * which skipped the prompt (re-spawning servers the user had blocked) and
 * dropped the `.mcp.json` servers.
 */
export async function connectMcpServers(mcpManager: MCPManager): Promise<void> {
  try {
    const settingsServers = getConfig().mcpServers;
    const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
    const projectServers = workspaceRoot ? await loadProjectMcpConfig(workspaceRoot) : {};
    const allServers = mergeMcpConfigs(projectServers, settingsServers);

    if (Object.keys(allServers).length === 0) return;

    const trust = await checkWorkspaceConfigTrust(
      'mcpServers',
      'SideCar: This workspace defines MCP server configs that may spawn external processes. Only trust these from repositories you control.',
      // A project .mcp.json is workspace content even though it is not a
      // setting; without this the prompt only fired for settings-defined servers.
      {
        modal: true,
        workspaceProvided: Object.keys(projectServers).length > 0,
        fingerprint: JSON.stringify(projectServers),
      },
    );
    if (trust === 'blocked') {
      logger.info('[SideCar] Workspace MCP servers blocked by user');
      return;
    }
    await mcpManager.connect(allServers);
  } catch (err) {
    logger.error('[SideCar] Failed to connect MCP servers:', err);
  }
}

export function initMcpSetup(context: ExtensionContext, mcpManager: MCPManager): void {
  const connectMcp = () => connectMcpServers(mcpManager);

  const config = getConfig();
  if (Object.keys(config.mcpServers).length > 0 || workspace.workspaceFolders?.length) {
    setImmediate(connectMcp);
  }

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.mcpServers')) {
        connectMcp().catch((err) => logger.error('[SideCar] Failed to reconnect MCP servers:', err));
      }
    }),
  );
}
