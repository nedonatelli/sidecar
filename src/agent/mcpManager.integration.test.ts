/**
 * End-to-end integration: MCPManager (client) ↔ McpAgentServer (server).
 *
 * The MCP SDK client transport is NOT mocked — both sides use real SDK
 * code over a real loopback HTTP connection. runAgentLoop is mocked so
 * the agent loop returns deterministic output without an LLM.
 *
 * Tests cover the full path:
 *   MCPManager.connect(http) → SDK initialize handshake → tool discovery
 *   → MCPManager.callServerTool → SDK callTool → McpAgentServer runs loop
 *   → text collected → MCP response → MCPManager wraps output → returned
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { McpAgentServer } from '../mcpServer/agentServer.js';
import { MCPManager } from './mcpManager.js';

vi.mock('./loop.js', () => ({ runAgentLoop: vi.fn() }));
vi.mock('../ollama/factory.js', () => ({ createClient: vi.fn(() => ({})) }));

import { runAgentLoop } from './loop.js';
const mockLoop = runAgentLoop as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Happy path — full round-trip
// ---------------------------------------------------------------------------

describe('MCPManager ↔ McpAgentServer — round-trip', () => {
  let agentServer: McpAgentServer;
  let manager: MCPManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoop.mockImplementation(async (_c, _m, callbacks) => {
      callbacks.onText('task complete');
      callbacks.onDone();
      return [];
    });

    agentServer = new McpAgentServer({ port: 0, authToken: null, requireAuth: false, maxConcurrent: 5 });
    await agentServer.start();

    manager = new MCPManager();
    await manager.connect({
      sidecar: { type: 'http', url: `http://127.0.0.1:${agentServer.getStatus().port}/mcp` },
    });
  });

  afterEach(async () => {
    await manager.disconnect();
    await agentServer.stop();
  });

  it('discovers run_agent_task and registers it with mcp_ namespace', () => {
    expect(manager.getToolCount()).toBe(1);
    const tool = manager.getTool('mcp_sidecar_run_agent_task');
    expect(tool).toBeDefined();
    expect(tool!.definition.name).toBe('mcp_sidecar_run_agent_task');
    expect(tool!.definition.description).toContain('[MCP: sidecar]');
  });

  it('getServerStatus reflects connected state and correct transport', () => {
    const status = manager.getServerStatus();
    expect(status).toHaveLength(1);
    expect(status[0].name).toBe('sidecar');
    expect(status[0].status).toBe('connected');
    expect(status[0].toolCount).toBe(1);
    expect(status[0].transport).toBe('http');
    expect(status[0].connectedSinceMs).toBeGreaterThanOrEqual(0);
  });

  it('isServerConnected returns true after successful connect', () => {
    expect(manager.isServerConnected('sidecar')).toBe(true);
    expect(manager.isServerConnected('other')).toBe(false);
  });

  it('getServerToolNames returns bare tool name without mcp_ prefix', () => {
    expect(manager.getServerToolNames('sidecar')).toEqual(['run_agent_task']);
  });

  it('getToolDefinitions includes input schema from server', () => {
    const defs = manager.getToolDefinitions();
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe('mcp_sidecar_run_agent_task');
    expect(defs[0].input_schema).toBeDefined();
    expect((defs[0].input_schema as { required?: string[] }).required).toContain('task');
  });

  it('callServerTool invokes agent and returns output wrapped in boundary markers', async () => {
    const result = await manager.callServerTool('sidecar', 'run_agent_task', { task: 'do a thing' });
    expect(result).toContain('task complete');
    expect(result).toContain('<mcp_tool_output server="sidecar" tool="run_agent_task" trust="untrusted">');
    expect(result).toContain('</mcp_tool_output>');
  });

  it('callServerTool throws for unknown tool name', async () => {
    await expect(manager.callServerTool('sidecar', 'nonexistent', {})).rejects.toThrow(/not found/i);
  });

  it('tool executor produces wrapped output consistent with wrapMcpOutput contract', async () => {
    const tool = manager.getTool('mcp_sidecar_run_agent_task');
    const result = await tool!.executor({ task: 'hello' });
    // Boundary markers carry server + tool attribution
    expect(result).toMatch(/<mcp_tool_output server="sidecar" tool="run_agent_task" trust="untrusted">/);
    expect(result).toContain('task complete');
    expect(result).toContain('</mcp_tool_output>');
  });

  it('disconnect clears all tools and server entries', async () => {
    await manager.disconnect();
    expect(manager.getToolCount()).toBe(0);
    expect(manager.getServerNames()).toEqual([]);
    expect(manager.isServerConnected('sidecar')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multiple outputs from agent — joined into single text block
// ---------------------------------------------------------------------------

describe('MCPManager ↔ McpAgentServer — multi-chunk agent output', () => {
  let agentServer: McpAgentServer;
  let manager: MCPManager;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoop.mockImplementation(async (_c, _m, callbacks) => {
      callbacks.onText('chunk one. ');
      callbacks.onText('chunk two. ');
      callbacks.onText('chunk three.');
      callbacks.onDone();
      return [];
    });

    agentServer = new McpAgentServer({ port: 0, authToken: null, requireAuth: false, maxConcurrent: 5 });
    await agentServer.start();

    manager = new MCPManager();
    await manager.connect({
      sidecar: { type: 'http', url: `http://127.0.0.1:${agentServer.getStatus().port}/mcp` },
    });
  });

  afterEach(async () => {
    await manager.disconnect();
    await agentServer.stop();
  });

  it('joins multiple onText calls into one result string', async () => {
    const result = await manager.callServerTool('sidecar', 'run_agent_task', { task: 'multi' });
    expect(result).toContain('chunk one. chunk two. chunk three.');
  });
});

// ---------------------------------------------------------------------------
// Auth enforcement across the connection boundary
// ---------------------------------------------------------------------------

describe('MCPManager ↔ McpAgentServer — auth enforcement', () => {
  it('connect fails when server requires auth and no token provided', async () => {
    vi.clearAllMocks();
    const agentServer = new McpAgentServer({
      port: 0,
      authToken: 'secret',
      requireAuth: true,
      maxConcurrent: 5,
    });
    await agentServer.start();

    const manager = new MCPManager();
    // connect() uses Promise.allSettled internally so it doesn't throw —
    // but the server shows up as 'failed' in status.
    await manager.connect({
      secured: { type: 'http', url: `http://127.0.0.1:${agentServer.getStatus().port}/mcp` },
    });

    const status = manager.getServerStatus();
    expect(status[0].status).toBe('failed');
    expect(manager.isServerConnected('secured')).toBe(false);

    await manager.disconnect();
    await agentServer.stop();
  });
});

// ---------------------------------------------------------------------------
// toolAllowlist filtering
// ---------------------------------------------------------------------------

describe('MCPManager — toolAllowlist via HTTP server', () => {
  it('only registers tools that are on the allowlist', async () => {
    vi.clearAllMocks();
    mockLoop.mockImplementation(async (_c, _m, callbacks) => {
      callbacks.onDone();
      return [];
    });

    const agentServer = new McpAgentServer({ port: 0, authToken: null, requireAuth: false, maxConcurrent: 5 });
    await agentServer.start();

    const manager = new MCPManager();
    // Server only exposes run_agent_task; allowlist includes it → tool registered
    await manager.connect({
      sidecar: {
        type: 'http',
        url: `http://127.0.0.1:${agentServer.getStatus().port}/mcp`,
        toolAllowlist: ['run_agent_task'],
      },
    });
    expect(manager.getToolCount()).toBe(1);

    await manager.disconnect();

    // Now connect with an allowlist that excludes the tool
    await manager.connect({
      sidecar: {
        type: 'http',
        url: `http://127.0.0.1:${agentServer.getStatus().port}/mcp`,
        toolAllowlist: ['some_other_tool'],
      },
    });
    expect(manager.getToolCount()).toBe(0);

    await manager.disconnect();
    await agentServer.stop();
  });
});
