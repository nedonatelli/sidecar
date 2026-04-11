import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { MCPServerConfig } from '../config/settings.js';
import type { ToolDefinition } from '../ollama/types.js';
import type { RegisteredTool } from './tools.js';

const DEFAULT_MAX_RESULT_CHARS = 50_000;
const RECONNECT_DELAYS = [2000, 5000, 15000]; // Exponential backoff

export type MCPServerStatus = 'connected' | 'connecting' | 'failed' | 'disconnected';

export interface MCPServerInfo {
  name: string;
  status: MCPServerStatus;
  toolCount: number;
  transport: 'stdio' | 'http' | 'sse';
  error?: string;
  /** Milliseconds since last successful connection */
  connectedSinceMs?: number;
}

interface MCPConnection {
  name: string;
  config: MCPServerConfig;
  client: Client;
  transport: StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport;
  transportType: 'stdio' | 'http' | 'sse';
  tools: RegisteredTool[];
  status: MCPServerStatus;
  error?: string;
  connectedAt?: number;
  reconnectAttempts: number;
  reconnectTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Manages MCP server connections, tool discovery, and lifecycle.
 *
 * Supports three transports:
 *  - stdio: spawns a local process
 *  - http: connects to a Streamable HTTP endpoint
 *  - sse: connects to a Server-Sent Events endpoint
 *
 * Also supports:
 *  - .mcp.json project-scope config (merged with VS Code settings)
 *  - Per-tool enable/disable
 *  - Health monitoring and automatic reconnection
 *  - Output size limits
 */
export class MCPManager {
  private connections: MCPConnection[] = [];
  private toolCache: RegisteredTool[] = [];
  private disposed = false;

  /**
   * Connect to all configured MCP servers.
   * Merges settings from VS Code config and .mcp.json project file.
   */
  async connect(servers: Record<string, MCPServerConfig>): Promise<void> {
    // Disconnect existing connections first
    await this.disconnect();

    const connectPromises = Object.entries(servers).map(([name, config]) => this.connectServer(name, config));

    // Connect all servers in parallel — one failure doesn't block others
    await Promise.allSettled(connectPromises);

    // Rebuild cache
    this.rebuildToolCache();
  }

  /**
   * Connect to a single MCP server.
   */
  private async connectServer(name: string, config: MCPServerConfig): Promise<void> {
    const transportType = config.type || 'stdio';

    const conn: MCPConnection = {
      name,
      config,
      client: null!,
      transport: null!,
      transportType,
      tools: [],
      status: 'connecting',
      reconnectAttempts: 0,
    };
    this.connections.push(conn);

    try {
      const transport = this.createTransport(transportType, config);
      const client = new Client({
        name: 'sidecar',
        version: '0.40.0',
      });

      conn.client = client;
      conn.transport = transport;

      await client.connect(transport);

      // Discover tools
      const toolsResult = await client.listTools();
      const maxResultChars = config.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS;
      const toolConfigs = config.tools || {};

      conn.tools = (toolsResult.tools || [])
        .filter((mcpTool) => {
          // Per-tool enable/disable
          const toolConfig = toolConfigs[mcpTool.name];
          if (toolConfig && toolConfig.enabled === false) return false;
          return true;
        })
        .map((mcpTool) => ({
          definition: {
            name: `mcp_${name}_${mcpTool.name}`,
            description: `[MCP: ${name}] ${mcpTool.description || mcpTool.name}`,
            input_schema: (mcpTool.inputSchema || { type: 'object', properties: {} }) as ToolDefinition['input_schema'],
          },
          executor: async (input: Record<string, unknown>) => {
            try {
              const result = await client.callTool({
                name: mcpTool.name,
                arguments: input,
              });
              // Extract text from MCP result content array
              let output: string;
              if (Array.isArray(result.content)) {
                output = result.content
                  .map((block: { type: string; text?: string }) => {
                    if (block.type === 'text' && block.text) return block.text;
                    return JSON.stringify(block);
                  })
                  .join('\n');
              } else {
                output = String(result.content || '(no output)');
              }
              // Enforce output size limit
              if (output.length > maxResultChars) {
                output =
                  output.slice(0, maxResultChars) +
                  `\n\n... (output truncated at ${maxResultChars} chars, ${output.length} total)`;
              }
              return output;
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              throw new Error(
                `MCP tool "${mcpTool.name}" on server "${name}" failed: ${msg}` +
                  ` (input: ${JSON.stringify(input).slice(0, 200)})`,
              );
            }
          },
          requiresApproval: true, // MCP tools always require approval
        }));

      conn.status = 'connected';
      conn.connectedAt = Date.now();
      conn.reconnectAttempts = 0;
      console.log(`[SideCar] Connected to MCP server "${name}" (${transportType}) — ${conn.tools.length} tool(s)`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      conn.status = 'failed';
      conn.error = msg;
      console.error(`[SideCar] Failed to connect to MCP server "${name}" (${transportType}):`, msg);

      // Schedule reconnection
      this.scheduleReconnect(conn);
    }
  }

  /**
   * Create the appropriate transport for the server type.
   */
  private createTransport(
    type: 'stdio' | 'http' | 'sse',
    config: MCPServerConfig,
  ): StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport {
    switch (type) {
      case 'stdio': {
        if (!config.command) throw new Error('stdio transport requires "command"');
        return new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env ? ({ ...process.env, ...config.env } as Record<string, string>) : undefined,
        });
      }

      case 'http': {
        if (!config.url) throw new Error('http transport requires "url"');
        const requestInit: RequestInit = {};
        if (config.headers) {
          requestInit.headers = this.resolveEnvVars(config.headers, config.env);
        }
        return new StreamableHTTPClientTransport(new URL(config.url), { requestInit });
      }

      case 'sse': {
        if (!config.url) throw new Error('sse transport requires "url"');
        const sseInit: RequestInit = {};
        if (config.headers) {
          sseInit.headers = this.resolveEnvVars(config.headers, config.env);
        }
        return new SSEClientTransport(new URL(config.url), { requestInit: sseInit });
      }
    }
  }

  /**
   * Resolve ${VAR} references in header values using env config + process.env.
   */
  private resolveEnvVars(headers: Record<string, string>, env?: Record<string, string>): Record<string, string> {
    const resolved: Record<string, string> = {};
    const envMap = { ...process.env, ...env };
    for (const [key, value] of Object.entries(headers)) {
      resolved[key] = value.replace(/\$\{(\w+)\}/g, (_, varName) => envMap[varName] || '');
    }
    return resolved;
  }

  /**
   * Schedule automatic reconnection with exponential backoff.
   */
  private scheduleReconnect(conn: MCPConnection): void {
    if (this.disposed) return;
    if (conn.reconnectAttempts >= RECONNECT_DELAYS.length) {
      console.warn(`[SideCar] MCP server "${conn.name}" — max reconnect attempts reached`);
      return;
    }

    const delay = RECONNECT_DELAYS[conn.reconnectAttempts];
    conn.reconnectAttempts++;

    console.log(`[SideCar] MCP server "${conn.name}" — reconnecting in ${delay}ms (attempt ${conn.reconnectAttempts})`);

    conn.reconnectTimer = setTimeout(async () => {
      if (this.disposed) return;

      try {
        // Clean up old connection
        try {
          await conn.client?.close();
        } catch {
          // Ignore
        }

        // Remove from connections list — connectServer will re-add
        this.connections = this.connections.filter((c) => c !== conn);
        await this.connectServer(conn.name, conn.config);
        this.rebuildToolCache();
      } catch (err) {
        console.error(`[SideCar] MCP reconnect failed for "${conn.name}":`, err);
      }
    }, delay);
  }

  /**
   * Rebuild the flat tool cache from all active connections.
   */
  private rebuildToolCache(): void {
    this.toolCache = this.connections.filter((c) => c.status === 'connected').flatMap((c) => c.tools);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  getToolDefinitions(): ToolDefinition[] {
    return this.toolCache.map((t) => t.definition);
  }

  getTool(name: string): RegisteredTool | undefined {
    return this.toolCache.find((t) => t.definition.name === name);
  }

  getToolCount(): number {
    return this.toolCache.length;
  }

  getServerNames(): string[] {
    return this.connections.map((c) => c.name);
  }

  /** Get detailed status for all servers. */
  getServerStatus(): MCPServerInfo[] {
    return this.connections.map((c) => ({
      name: c.name,
      status: c.status,
      toolCount: c.tools.length,
      transport: c.transportType,
      error: c.error,
      connectedSinceMs: c.connectedAt ? Date.now() - c.connectedAt : undefined,
    }));
  }

  /** Check if a specific server is healthy. */
  isServerConnected(name: string): boolean {
    return this.connections.some((c) => c.name === name && c.status === 'connected');
  }

  async disconnect(): Promise<void> {
    for (const conn of this.connections) {
      if (conn.reconnectTimer) clearTimeout(conn.reconnectTimer);
      try {
        await conn.client?.close();
      } catch {
        // Ignore close errors
      }
    }
    this.connections = [];
    this.toolCache = [];
  }

  dispose(): void {
    this.disposed = true;
    this.disconnect().catch((err) => {
      console.error('[SideCar] MCP disconnect error during dispose:', err);
    });
  }
}

// ---------------------------------------------------------------------------
// .mcp.json project-scope configuration
// ---------------------------------------------------------------------------

/**
 * Load MCP server configs from a `.mcp.json` file at the workspace root.
 * Format compatible with Claude Code's project-scope config.
 *
 * Returns empty object if the file doesn't exist or is invalid.
 */
export async function loadProjectMcpConfig(workspaceRoot: string): Promise<Record<string, MCPServerConfig>> {
  const { workspace, Uri } = await import('vscode');
  const mcpJsonUri = Uri.file(`${workspaceRoot}/.mcp.json`);

  try {
    const bytes = await workspace.fs.readFile(mcpJsonUri);
    const content = Buffer.from(bytes).toString('utf-8');
    const parsed = JSON.parse(content);

    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') return {};

    // Convert Claude Code format to SideCar format
    const result: Record<string, MCPServerConfig> = {};
    for (const [name, raw] of Object.entries(parsed.mcpServers)) {
      const cfg = raw as Record<string, unknown>;
      const type = (cfg.type as string) || 'stdio';

      if (type === 'stdio') {
        result[name] = {
          type: 'stdio',
          command: cfg.command as string,
          args: cfg.args as string[] | undefined,
          env: cfg.env as Record<string, string> | undefined,
        };
      } else if (type === 'http' || type === 'url') {
        result[name] = {
          type: 'http',
          url: cfg.url as string,
          headers: cfg.headers as Record<string, string> | undefined,
        };
      } else if (type === 'sse') {
        result[name] = {
          type: 'sse',
          url: cfg.url as string,
          headers: cfg.headers as Record<string, string> | undefined,
        };
      }
    }

    return result;
  } catch {
    // File doesn't exist or is invalid
    return {};
  }
}

/**
 * Merge MCP configs from multiple sources.
 * VS Code settings take precedence over .mcp.json (local overrides shared).
 */
export function mergeMcpConfigs(...sources: Record<string, MCPServerConfig>[]): Record<string, MCPServerConfig> {
  const merged: Record<string, MCPServerConfig> = {};
  for (const source of sources) {
    Object.assign(merged, source);
  }
  return merged;
}
