import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { MCPServerConfig } from '../config/settings.js';
import type { ToolDefinition } from '../ollama/types.js';
import type { RegisteredTool } from './tools.js';

interface MCPConnection {
  name: string;
  client: Client;
  transport: StdioClientTransport;
  tools: RegisteredTool[];
}

export class MCPManager {
  private connections: MCPConnection[] = [];
  private toolCache: RegisteredTool[] = [];

  async connect(servers: Record<string, MCPServerConfig>): Promise<void> {
    // Disconnect existing connections first
    await this.disconnect();

    for (const [name, config] of Object.entries(servers)) {
      try {
        const transport = new StdioClientTransport({
          command: config.command,
          args: config.args,
          env: config.env ? ({ ...process.env, ...config.env } as Record<string, string>) : undefined,
        });

        const client = new Client({
          name: 'sidecar',
          version: '0.4.0',
        });

        await client.connect(transport);

        // Discover tools
        const toolsResult = await client.listTools();
        const tools: RegisteredTool[] = (toolsResult.tools || []).map((mcpTool) => ({
          definition: {
            name: `mcp_${name}_${mcpTool.name}`,
            description: `[MCP: ${name}] ${mcpTool.description || mcpTool.name}`,
            input_schema: (mcpTool.inputSchema || { type: 'object', properties: {} }) as ToolDefinition['input_schema'],
          },
          executor: async (input: Record<string, unknown>) => {
            const result = await client.callTool({
              name: mcpTool.name,
              arguments: input,
            });
            // Extract text from MCP result content array
            if (Array.isArray(result.content)) {
              return result.content
                .map((block: { type: string; text?: string }) => {
                  if (block.type === 'text' && block.text) return block.text;
                  return JSON.stringify(block);
                })
                .join('\n');
            }
            return String(result.content || '(no output)');
          },
          requiresApproval: true, // MCP tools always require approval
        }));

        this.connections.push({ name, client, transport, tools });
        console.log(`[SideCar] Connected to MCP server "${name}" — ${tools.length} tool(s)`);
      } catch (err) {
        console.error(`[SideCar] Failed to connect to MCP server "${name}":`, err);
      }
    }

    // Rebuild cache
    this.toolCache = this.connections.flatMap((c) => c.tools);
  }

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

  async disconnect(): Promise<void> {
    for (const conn of this.connections) {
      try {
        await conn.client.close();
      } catch {
        // Ignore close errors
      }
    }
    this.connections = [];
    this.toolCache = [];
  }

  dispose(): void {
    this.disconnect().catch((err) => {
      console.error('[SideCar] MCP disconnect error during dispose:', err);
    });
  }
}
