import * as http from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { runAgentLoop } from '../agent/loop.js';
import { DurableMemoryStore, renderDurableMemorySection } from '../agent/memory/durableMemory.js';
import type { AgentCallbacks } from '../agent/loop.js';
import { createClient } from '../ollama/factory.js';
import { getConfig } from '../config/settings.js';
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
// Auth: bearer token from caller settings. When `requireAuth` is true, every
// request must include `Authorization: Bearer <token>`. Auth is fail-closed —
// if `requireAuth` is set but no `authToken` is configured, the server refuses
// to start rather than silently accepting unauthenticated requests.
//
// Concurrency: a simple busy flag rejects concurrent calls — the agent loop
// is a stateful, workspace-mutating operation and running two in parallel
// would produce interlocked writes and unpredictable results.
//
// Transport: stateless StreamableHTTP — a fresh Server + transport is created
// per HTTP request so the MCP initialize/notification handshake can complete
// within a single client session without reusing consumed transport state.
// ---------------------------------------------------------------------------

/** Maps the MCP-facing approval names to the loop's real ApprovalMode values. */
const MCP_APPROVAL_MODE_MAP: Record<string, ApprovalMode> = {
  auto: 'autonomous',
  suggest: 'cautious',
  manual: 'manual',
};

export interface McpAgentServerOptions {
  /** Cross-session durable-instruction store — MCP tasks form and recall memory like chat sessions (parity, v0.121). */
  durableMemoryStore?: DurableMemoryStore;
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
  private activeTaskCount = 0;
  private readonly options: McpAgentServerOptions;

  constructor(options: McpAgentServerOptions) {
    this.options = options;
  }

  /**
   * Build a fresh MCP Server with request handlers registered.
   * Called once per HTTP request so every client session gets its own
   * transport instance — required by the stateless StreamableHTTP spec.
   */
  private buildMcpServer(): Server {
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

    return mcpServer;
  }

  async start(): Promise<void> {
    if (this.httpServer) return; // already running

    // Fail closed: refuse to start an "authenticated" server with no token.
    // Without this guard the auth check below would be skipped entirely,
    // leaving the server open to any local process despite requireAuth.
    if (this.options.requireAuth && !this.options.authToken) {
      throw new Error(
        'MCP server auth is required but no authToken is set — refusing to start. ' +
          'Set sidecar.mcpServer.authToken or disable sidecar.mcpServer.requireAuth.',
      );
    }

    const httpServer = http.createServer(async (req, res) => {
      // Auth check — fail closed. When requireAuth is on, every request must
      // carry a matching bearer token; a missing server token rejects all.
      if (this.options.requireAuth) {
        const authHeader = req.headers['authorization'] ?? '';
        const expected = this.options.authToken ? `Bearer ${this.options.authToken}` : null;
        if (!expected || authHeader !== expected) {
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

      // Buffer body then hand to a fresh per-request transport
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

        // Fresh Server + transport per request: correct stateless MCP pattern.
        // The StreamableHTTPServerTransport tracks per-session initialized state;
        // reusing a single instance across requests causes 500s on the second POST
        // (notifications/initialized) because the transport's state is consumed.
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        const mcpServer = this.buildMcpServer();
        await mcpServer.connect(transport);
        await transport.handleRequest(req, res, body);
      });
    });

    await new Promise<void>((resolve, reject) => {
      httpServer.listen(this.options.port, '127.0.0.1', () => resolve());
      httpServer.once('error', reject);
    });

    this.httpServer = httpServer;
  }

  async stop(): Promise<void> {
    if (!this.httpServer) return;
    await new Promise<void>((resolve, reject) => this.httpServer!.close((err) => (err ? reject(err) : resolve())));
    this.httpServer = null;
  }

  getStatus(): McpAgentServerStatus {
    const addr = this.httpServer?.address();
    const port = addr && typeof addr === 'object' ? addr.port : this.options.port;
    return {
      running: this.httpServer !== null,
      port,
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
    // Map the MCP-facing approval names to real ApprovalMode values. The schema
    // exposes 'auto'/'suggest'/'manual', but the loop expects
    // 'autonomous'/'cautious'/'manual'/'plan'/'review'. Casting the raw input
    // through (the previous behavior) produced an enum value that matched no
    // real mode and silently fell through to "no approval required". Note: the
    // MCP server wires no confirmFn, so 'cautious'/'manual' auto-deny any tool
    // that requires approval — only 'autonomous' executes such tools.
    const resolvedApprovalMode = MCP_APPROVAL_MODE_MAP[approvalModeInput ?? ''] ?? 'autonomous';

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

    // Memory parity with the chat path (v0.121): remembered instructions are
    // injected into the task's system prompt, and instructions latched at
    // compaction during this task persist for future sessions. Without this,
    // MCP-driven tasks silently bypassed the durable-context defaults.
    const memStore = this.options.durableMemoryStore;
    if (memStore) {
      await memStore.load();
      const section = renderDurableMemorySection(memStore.getEntries());
      if (section) client.updateSystemPrompt(client.getSystemPrompt() + section);
    }

    await runAgentLoop(client, messages, callbacks, controller.signal, {
      approvalMode: resolvedApprovalMode,
      maxIterations: clampedMaxIterations,
      durableMemoryStore: memStore,
      // Parity with the chat path: without this the loop's compression budget
      // defaults to 100k tokens and MCP tasks essentially never compact —
      // silently disabling the durable-context chain on this surface (same
      // unwired-budget class as the eval-harness bug).
      maxTokens: getConfig().agentMaxTokens,
    });

    const output = textParts.join('').trim();
    return output || '(Agent completed with no text output)';
  }
}
