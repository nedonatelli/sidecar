import * as http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runAgentLoop } from '../agent/loop.js';
import type { AgentCallbacks } from '../agent/loop.js';
import { createClient } from '../ollama/factory.js';
import type { ChatMessage } from '../ollama/types.js';
import type { ApprovalMode } from '../agent/executor.js';

// ---------------------------------------------------------------------------
// SideCar MCP Agent Server — Direction B of "Agentic Task Delegation via MCP"
//
// Exposes SideCar's agent loop as an MCP server so external clients
// (other AI systems, Claude Desktop, Cursor, etc.) can delegate tasks to
// SideCar's local agent. Listens on 127.0.0.1 only — no external exposure.
//
// Exposed tool:
//   run_agent_task(task, maxIterations?, approvalMode?)
//     Runs the SideCar agent loop with the supplied task as the first user
//     message. Collects all onText output and returns a single batch result.
//
// Auth: optional bearer token from caller settings. When `requireAuth` is
// true, every request must include `Authorization: Bearer <token>`.
//
// Concurrency: a simple busy flag rejects concurrent calls — the agent loop
// is a stateful, workspace-mutating operation and running two in parallel
// would produce interlocked writes and unpredictable results.
// ---------------------------------------------------------------------------

export interface McpAgentServerOptions {
  port: number;
  authToken: string | null;
  requireAuth: boolean;
  maxConcurrent: number;
}

export interface McpAgentServerStatus {
  running: boolean;
  port: number;
  activeTaskCount: number;
}

export class McpAgentServer {
  private httpServer: http.Server | null = null;
  private mcpServer: Server | null = null;
  private activeTaskCount = 0;
  private readonly options: McpAgentServerOptions;

  constructor(options: McpAgentServerOptions) {
    this.options = options;
  }

  async start(): Promise<void> {
    if (this.httpServer) return; // already running

    const mcpServer = new Server({ name: 'sidecar-agent', version: '0.95.0' }, { capabilities: { tools: {} } });

    mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'run_agent_task',
          description:
            'Run a task using the SideCar agent loop. The agent has full access to the ' +
            'local workspace — it can read/write files, run shell commands, search the ' +
            "codebase, and call other tools. Returns the agent's final text output.",
          inputSchema: {
            type: 'object',
            properties: {
              task: {
                type: 'string',
                description: 'Natural language description of the task for the agent to complete',
              },
              maxIterations: {
                type: 'number',
                description: 'Maximum number of agent loop iterations (default: 20, max: 40)',
              },
              approvalMode: {
                type: 'string',
                enum: ['auto', 'suggest', 'manual'],
                description: 'Tool approval mode (default: auto)',
              },
            },
            required: ['task'],
          },
        },
      ],
    }));

    mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
      if (request.params.name !== 'run_agent_task') {
        return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }] };
      }

      const { task, maxIterations, approvalMode } = request.params.arguments as {
        task?: string;
        maxIterations?: number;
        approvalMode?: string;
      };

      if (!task || typeof task !== 'string' || !task.trim()) {
        return { isError: true, content: [{ type: 'text', text: 'Missing required parameter: task' }] };
      }

      if (this.activeTaskCount >= this.options.maxConcurrent) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `SideCar agent is busy (${this.activeTaskCount} active task(s)). Try again shortly.`,
            },
          ],
        };
      }

      this.activeTaskCount++;
      try {
        const result = await this.runTask(task.trim(), maxIterations, approvalMode);
        return { content: [{ type: 'text', text: result }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { isError: true, content: [{ type: 'text', text: `Agent task failed: ${msg}` }] };
      } finally {
        this.activeTaskCount--;
      }
    });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless — no session affinity needed
    });

    const httpServer = http.createServer(async (req, res) => {
      // Auth check
      if (this.options.requireAuth && this.options.authToken) {
        const authHeader = req.headers['authorization'] ?? '';
        const expected = `Bearer ${this.options.authToken}`;
        if (authHeader !== expected) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }
      }

      // Only handle POST /mcp
      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.writeHead(404);
        res.end();
        return;
      }

      // Buffer body then hand to transport
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', async () => {
        let body: unknown;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
          return;
        }
        await transport.handleRequest(req, res, body);
      });
    });

    await mcpServer.connect(transport);

    await new Promise<void>((resolve, reject) => {
      httpServer.listen(this.options.port, '127.0.0.1', () => resolve());
      httpServer.once('error', reject);
    });

    this.httpServer = httpServer;
    this.mcpServer = mcpServer;
  }

  async stop(): Promise<void> {
    if (!this.httpServer) return;
    await Promise.all([
      new Promise<void>((resolve, reject) => this.httpServer!.close((err) => (err ? reject(err) : resolve()))),
      this.mcpServer?.close(),
    ]);
    this.httpServer = null;
    this.mcpServer = null;
  }

  getStatus(): McpAgentServerStatus {
    return {
      running: this.httpServer !== null,
      port: this.options.port,
      activeTaskCount: this.activeTaskCount,
    };
  }

  private async runTask(
    task: string,
    maxIterationsInput: number | undefined,
    approvalModeInput: string | undefined,
  ): Promise<string> {
    const controller = new AbortController();
    const textParts: string[] = [];

    const clampedMaxIterations = Math.min(Math.max(1, maxIterationsInput ?? 20), 40);
    const resolvedApprovalMode = (
      ['auto', 'suggest', 'manual'].includes(approvalModeInput ?? '') ? approvalModeInput : 'auto'
    ) as ApprovalMode;

    const callbacks: AgentCallbacks = {
      onText: (text) => textParts.push(text),
      onToolCall: () => {
        /* no-op — MCP caller doesn't see mid-task tool events */
      },
      onToolResult: () => {
        /* no-op */
      },
      onDone: () => {
        /* no-op */
      },
    };

    const messages: ChatMessage[] = [{ role: 'user', content: task }];
    const client = createClient();

    await runAgentLoop(client, messages, callbacks, controller.signal, {
      approvalMode: resolvedApprovalMode,
      maxIterations: clampedMaxIterations,
    });

    const output = textParts.join('').trim();
    return output || '(Agent completed with no text output)';
  }
}
