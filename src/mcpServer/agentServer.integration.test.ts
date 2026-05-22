/**
 * HTTP integration tests for McpAgentServer.
 *
 * These tests start a real HTTP server on an OS-assigned port and make
 * actual HTTP requests to verify the full request-handling path: routing,
 * auth enforcement, JSON parsing, MCP protocol dispatch, and response shaping.
 *
 * runAgentLoop and createClient are mocked so tests are hermetic — no real
 * LLM or workspace needed. The MCP SDK server-side (Server + transport) is
 * real; only the agent execution layer is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpAgentServer } from './agentServer.js';

vi.mock('../agent/loop.js', () => ({ runAgentLoop: vi.fn() }));
vi.mock('../ollama/factory.js', () => ({ createClient: vi.fn(() => ({})) }));

import { runAgentLoop } from '../agent/loop.js';
const mockLoop = runAgentLoop as ReturnType<typeof vi.fn>;

function makeOptions(overrides?: Partial<ConstructorParameters<typeof McpAgentServer>[0]>) {
  return { port: 0, authToken: null, requireAuth: false, maxConcurrent: 5, ...overrides };
}

function getPort(server: McpAgentServer): number {
  return server.getStatus().port;
}

async function rawPost(
  port: number,
  body: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body,
  });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    /* body may not be JSON */
  }
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// HTTP routing
// ---------------------------------------------------------------------------

describe('McpAgentServer — HTTP routing', () => {
  let server: McpAgentServer;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = new McpAgentServer(makeOptions());
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  it('getStatus().port reflects the actual bound port after start', () => {
    const port = getPort(server);
    expect(port).toBeGreaterThan(0);
  });

  it('returns 404 for GET /mcp', async () => {
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/mcp`, { method: 'GET' });
    expect(res.status).toBe(404);
  });

  it('returns 404 for POST to wrong path', async () => {
    const res = await fetch(`http://127.0.0.1:${getPort(server)}/other`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('returns 400 for malformed JSON body', async () => {
    const { status, json } = await rawPost(getPort(server), 'not-valid-json');
    expect(status).toBe(400);
    expect((json as { error?: string }).error).toMatch(/invalid json/i);
  });
});

// ---------------------------------------------------------------------------
// Bearer-token auth
// ---------------------------------------------------------------------------

describe('McpAgentServer — bearer token auth', () => {
  let server: McpAgentServer;
  let port: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    server = new McpAgentServer(makeOptions({ requireAuth: true, authToken: 'secret-token' }));
    await server.start();
    port = getPort(server);
  });

  afterEach(async () => {
    await server.stop();
  });

  it('returns 401 when Authorization header is absent', async () => {
    const { status, json } = await rawPost(port, '{}');
    expect(status).toBe(401);
    expect((json as { error?: string }).error).toBe('Unauthorized');
  });

  it('returns 401 for wrong bearer token', async () => {
    const { status } = await rawPost(port, '{}', { Authorization: 'Bearer wrong-token' });
    expect(status).toBe(401);
  });

  it('does not return 401 when correct bearer token is supplied', async () => {
    // Body can be non-MCP — we only verify auth passes, not the MCP response.
    const { status } = await rawPost(port, '{}', { Authorization: 'Bearer secret-token' });
    expect(status).not.toBe(401);
  });

  it('does not require auth when requireAuth is false', async () => {
    const openServer = new McpAgentServer(makeOptions({ requireAuth: false, authToken: 'secret' }));
    await openServer.start();
    const { status } = await rawPost(openServer.getStatus().port, '{}');
    expect(status).not.toBe(401);
    await openServer.stop();
  });
});

// ---------------------------------------------------------------------------
// MCP protocol via SDK client — full round-trip without real LLM
// ---------------------------------------------------------------------------

describe('McpAgentServer — MCP protocol (SDK client)', () => {
  let server: McpAgentServer;
  let client: Client;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoop.mockImplementation(async (_c, _m, callbacks) => {
      callbacks.onText('Agent says hello');
      callbacks.onDone();
      return [];
    });

    server = new McpAgentServer(makeOptions());
    await server.start();

    client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${getPort(server)}/mcp`));
    await client.connect(transport);
  });

  afterEach(async () => {
    await client.close().catch(() => {});
    await server.stop();
  });

  it('ListTools returns exactly run_agent_task', async () => {
    const result = await client.listTools();
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('run_agent_task');
    expect((result.tools[0].inputSchema as { required?: string[] }).required).toContain('task');
  });

  it('run_agent_task returns the agent text output', async () => {
    const result = await client.callTool({ name: 'run_agent_task', arguments: { task: 'say hello' } });
    expect(result.isError).toBeFalsy();
    const block = (result.content as Array<{ type: string; text: string }>)[0];
    expect(block.type).toBe('text');
    expect(block.text).toBe('Agent says hello');
    // Server returns raw text — MCPManager adds the boundary wrapper on the client side
    expect(block.text).not.toContain('<mcp_tool_output');
  });

  it('run_agent_task with empty task returns isError', async () => {
    const result = await client.callTool({ name: 'run_agent_task', arguments: { task: '   ' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Missing required parameter');
  });

  it('run_agent_task with missing task param returns isError', async () => {
    const result = await client.callTool({ name: 'run_agent_task', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('unknown tool name returns isError', async () => {
    const result = await client.callTool({ name: 'nonexistent_tool', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Unknown tool');
  });

  it('agent error is surfaced as isError response', async () => {
    mockLoop.mockRejectedValueOnce(new Error('LLM unavailable'));
    const result = await client.callTool({ name: 'run_agent_task', arguments: { task: 'test' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('LLM unavailable');
  });

  it('agent with no text output returns placeholder', async () => {
    mockLoop.mockImplementationOnce(async (_c, _m, callbacks) => {
      callbacks.onDone();
      return [];
    });
    const result = await client.callTool({ name: 'run_agent_task', arguments: { task: 'silent' } });
    expect(result.isError).toBeFalsy();
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('no text output');
  });
});

// ---------------------------------------------------------------------------
// Concurrency guard via MCP protocol
// ---------------------------------------------------------------------------

describe('McpAgentServer — concurrency guard (MCP)', () => {
  it('rejects CallTool when maxConcurrent is 0', async () => {
    vi.clearAllMocks();
    const server = new McpAgentServer(makeOptions({ maxConcurrent: 0 }));
    await server.start();

    const client = new Client({ name: 'test', version: '1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.getStatus().port}/mcp`));
    await client.connect(transport);

    const result = await client.callTool({ name: 'run_agent_task', arguments: { task: 'hi' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('busy');

    await client.close().catch(() => {});
    await server.stop();
  });

  it('allows second call once the first completes', async () => {
    vi.clearAllMocks();
    mockLoop
      .mockImplementationOnce(async (_c, _m, callbacks) => {
        callbacks.onText('first done');
        callbacks.onDone();
        return [];
      })
      .mockImplementationOnce(async (_c, _m, callbacks) => {
        callbacks.onText('second done');
        callbacks.onDone();
        return [];
      });

    const server = new McpAgentServer(makeOptions({ maxConcurrent: 1 }));
    await server.start();

    const client = new Client({ name: 'test', version: '1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.getStatus().port}/mcp`));
    await client.connect(transport);

    // First call completes; activeTaskCount returns to 0
    const first = await client.callTool({ name: 'run_agent_task', arguments: { task: 'task1' } });
    expect(first.isError).toBeFalsy();

    // Second call must not be rejected — concurrency slot was freed correctly
    const second = await client.callTool({ name: 'run_agent_task', arguments: { task: 'task2' } });
    expect(second.isError).toBeFalsy();

    await client.close().catch(() => {});
    await server.stop();
  });
});
