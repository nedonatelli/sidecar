import { window, workspace, commands, ExtensionContext, ConfigurationTarget } from 'vscode';
import type { MCPServerConfig } from '../config/settings.js';

interface NoSqlTemplate {
  id: string;
  label: string;
  detail: string;
  prerequisite: string;
  command: string;
  args: string[];
  envKey: string;
  uriPrompt: string;
  uriPlaceholder: string;
}

const NOSQL_TEMPLATES: NoSqlTemplate[] = [
  {
    id: 'mongodb',
    label: '$(database) MongoDB',
    detail: '@mongodb-js/mongodb-mcp-server — requires Node.js + npx',
    prerequisite: 'Node.js (npx)',
    command: 'npx',
    args: ['-y', '@mongodb-js/mongodb-mcp-server@latest'],
    envKey: 'MDB_MCP_CONNECTION_STRING',
    uriPrompt: 'MongoDB connection string',
    uriPlaceholder: 'mongodb://localhost:27017',
  },
  {
    id: 'redis',
    label: '$(database) Redis',
    detail: 'mcp-redis (Redis official) — requires uv  (pip install uv)',
    prerequisite: 'uv (https://docs.astral.sh/uv/)',
    command: 'uvx',
    args: ['mcp-redis'],
    envKey: 'REDIS_URL',
    uriPrompt: 'Redis connection URL',
    uriPlaceholder: 'redis://localhost:6379',
  },
];

/**
 * Register the `sidecar.noSql.install` command that pre-fills a MongoDB or Redis
 * MCP server config into `sidecar.mcpServers` so the agent can query NoSQL stores.
 */
export function registerNoSqlMcpCommands(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand('sidecar.noSql.install', async () => {
      const pick = await window.showQuickPick(
        NOSQL_TEMPLATES.map((t) => ({ label: t.label, detail: t.detail, template: t })),
        { placeHolder: 'Select a NoSQL server to configure', title: 'SideCar: Install NoSQL MCP Server' },
      );
      if (!pick) return;

      const template = pick.template;

      const uri = await window.showInputBox({
        prompt: template.uriPrompt,
        placeHolder: template.uriPlaceholder,
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? null : 'Connection string is required'),
      });
      if (!uri) return;

      const config = workspace.getConfiguration('sidecar');
      const existing = config.get<Record<string, MCPServerConfig>>('mcpServers', {});

      const serverConfig: MCPServerConfig = {
        type: 'stdio',
        command: template.command,
        args: template.args,
        env: { [template.envKey]: uri.trim() },
      };

      await config.update('mcpServers', { ...existing, [template.id]: serverConfig }, ConfigurationTarget.Global);

      const choice = await window.showInformationMessage(
        `SideCar: ${template.id} MCP server configured. Prerequisite: ${template.prerequisite}. ` +
          `The server connects on next agent turn.`,
        'Open Settings',
        'Dismiss',
      );
      if (choice === 'Open Settings') {
        void commands.executeCommand('workbench.action.openSettings', 'sidecar.mcpServers');
      }
    }),
  );
}
