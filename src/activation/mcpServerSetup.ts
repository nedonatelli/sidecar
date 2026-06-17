import { randomBytes } from 'node:crypto';
import { env, window, type ExtensionContext } from 'vscode';
import { getConfig } from '../config/settings.js';
import { McpAgentServer } from '../mcpServer/agentServer.js';

// ---------------------------------------------------------------------------
// MCP Agent Server activation — wires the lifecycle of the
// McpAgentServer singleton into the extension context.
//
// Gated by `sidecar.mcpServer.enabled`. When enabled, starts the server
// on the configured port at activation and stops it on deactivation.
//
// Auth is on by default. If `requireAuth` is set (the default) but no
// `authToken` is configured, a per-session token is generated and shown to
// the user so the local-only server is protected without setup friction.
// Disabling auth requires an explicit opt-out and surfaces a warning.
// ---------------------------------------------------------------------------

let serverInstance: McpAgentServer | null = null;

/**
 * Initialize the MCP agent server if enabled. Registers a disposable that
 * stops the server when the extension deactivates. Call once from activate().
 */
export async function initMcpServer(context: ExtensionContext): Promise<void> {
  const config = getConfig();
  if (!config.mcpServerEnabled) return;

  const requireAuth = config.mcpServerRequireAuth;
  let authToken = config.mcpServerAuthToken;
  let tokenWasGenerated = false;
  if (requireAuth && !authToken) {
    authToken = randomBytes(32).toString('hex');
    tokenWasGenerated = true;
  }

  const server = new McpAgentServer({
    port: config.mcpServerPort,
    authToken: authToken ?? null,
    requireAuth,
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

    if (!requireAuth) {
      window.showWarningMessage(
        `SideCar MCP server started on 127.0.0.1:${port} WITHOUT authentication — any local process can drive the agent. Enable sidecar.mcpServer.requireAuth.`,
      );
    } else if (tokenWasGenerated) {
      const generated = authToken as string;
      void window
        .showInformationMessage(
          `SideCar MCP server started on 127.0.0.1:${port}. A session auth token was generated — clients must send it as a bearer token.`,
          'Copy token',
        )
        .then((choice) => {
          if (choice === 'Copy token') void env.clipboard.writeText(generated);
        });
    } else {
      window.showInformationMessage(
        `SideCar MCP server started on 127.0.0.1:${port} — external agents can now delegate tasks.`,
      );
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    window.showErrorMessage(`SideCar: Failed to start MCP server on port ${config.mcpServerPort}: ${msg}`);
  }
}

/** Return the running server instance, if any. Useful for status-bar display. */
export function getMcpServerInstance(): McpAgentServer | null {
  return serverInstance;
}
