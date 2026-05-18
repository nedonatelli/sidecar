import { window, type ExtensionContext } from 'vscode';
import { getConfig } from '../config/settings.js';
import { McpAgentServer } from '../mcpServer/agentServer.js';

// ---------------------------------------------------------------------------
// MCP Agent Server activation — wires the lifecycle of the
// McpAgentServer singleton into the extension context.
//
// Gated by `sidecar.mcpServer.enabled`. When enabled, starts the server
// on the configured port at activation and stops it on deactivation.
// Auth token is read from the config; `requireAuth: false` by default so
// the local-only server is accessible without setup friction.
// ---------------------------------------------------------------------------

let serverInstance: McpAgentServer | null = null;

/**
 * Initialize the MCP agent server if enabled. Registers a disposable that
 * stops the server when the extension deactivates. Call once from activate().
 */
export async function initMcpServer(context: ExtensionContext): Promise<void> {
  const config = getConfig();
  if (!config.mcpServerEnabled) return;

  const server = new McpAgentServer({
    port: config.mcpServerPort,
    authToken: config.mcpServerAuthToken ?? null,
    requireAuth: config.mcpServerRequireAuth,
    maxConcurrent: config.mcpServerMaxConcurrent,
  });

  try {
    await server.start();
    serverInstance = server;

    const { port } = server.getStatus();
    context.subscriptions.push({
      dispose: () => {
        server.stop().catch(() => {
          /* best-effort shutdown */
        });
        serverInstance = null;
      },
    });

    window.showInformationMessage(
      `SideCar MCP server started on 127.0.0.1:${port} — external agents can now delegate tasks.`,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    window.showErrorMessage(`SideCar: Failed to start MCP server on port ${config.mcpServerPort}: ${msg}`);
  }
}

/** Return the running server instance, if any. Useful for status-bar display. */
export function getMcpServerInstance(): McpAgentServer | null {
  return serverInstance;
}
