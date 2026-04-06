import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockClient = {
  connect: vi.fn().mockResolvedValue(undefined),
  listTools: vi.fn().mockResolvedValue({
    tools: [
      {
        name: 'read',
        description: 'Read a resource',
        inputSchema: { type: 'object', properties: { uri: { type: 'string' } } },
      },
      {
        name: 'write',
        description: 'Write a resource',
        inputSchema: { type: 'object', properties: { uri: { type: 'string' }, content: { type: 'string' } } },
      },
    ],
  }),
  callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'result' }] }),
  close: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(function () {
    return { ...mockClient };
  }),
}));

vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({
  StdioClientTransport: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

import { MCPManager } from './mcpManager.js';

describe('MCPManager', () => {
  let manager: MCPManager;

  beforeEach(() => {
    manager = new MCPManager();
    vi.clearAllMocks();
    // Restore default mock behavior after clearAllMocks
    mockClient.connect.mockResolvedValue(undefined);
    mockClient.listTools.mockResolvedValue({
      tools: [
        { name: 'read', description: 'Read a resource', inputSchema: { type: 'object', properties: {} } },
        { name: 'write', description: 'Write a resource', inputSchema: { type: 'object', properties: {} } },
      ],
    });
    mockClient.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'result' }] });
    mockClient.close.mockResolvedValue(undefined);
  });

  it('starts with no tools', () => {
    expect(manager.getToolCount()).toBe(0);
    expect(manager.getServerNames()).toEqual([]);
  });

  it('connects to servers and discovers tools', async () => {
    await manager.connect({
      testServer: { command: 'echo', args: ['hi'] },
    });

    expect(manager.getToolCount()).toBe(2);
    expect(manager.getServerNames()).toEqual(['testServer']);
  });

  it('namespaces tool names with mcp_ prefix', async () => {
    await manager.connect({
      fs: { command: 'echo' },
    });

    const defs = manager.getToolDefinitions();
    expect(defs[0].name).toBe('mcp_fs_read');
    expect(defs[1].name).toBe('mcp_fs_write');
  });

  it('finds tool by prefixed name', async () => {
    await manager.connect({
      fs: { command: 'echo' },
    });

    const tool = manager.getTool('mcp_fs_read');
    expect(tool).toBeDefined();
    expect(tool?.definition.name).toBe('mcp_fs_read');
  });

  it('returns undefined for unknown tool', async () => {
    await manager.connect({
      fs: { command: 'echo' },
    });

    expect(manager.getTool('mcp_fs_nonexistent')).toBeUndefined();
  });

  it('disconnects and clears tools', async () => {
    await manager.connect({
      fs: { command: 'echo' },
    });
    expect(manager.getToolCount()).toBe(2);

    await manager.disconnect();
    expect(manager.getToolCount()).toBe(0);
    expect(manager.getServerNames()).toEqual([]);
  });

  it('reconnects by disconnecting first', async () => {
    await manager.connect({
      server1: { command: 'echo' },
    });
    expect(manager.getServerNames()).toEqual(['server1']);

    await manager.connect({
      server2: { command: 'echo' },
    });
    expect(manager.getServerNames()).toEqual(['server2']);
  });

  it('handles connection failure for one server gracefully', async () => {
    let callCount = 0;
    mockClient.connect.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('connection failed'));
      return Promise.resolve();
    });

    await manager.connect({
      failing: { command: 'bad' },
      working: { command: 'good' },
    });

    // The failing server should be skipped, working server should connect
    expect(manager.getServerNames()).toEqual(['working']);
  });

  it('tool executor calls MCP client and extracts text', async () => {
    await manager.connect({
      fs: { command: 'echo' },
    });

    const tool = manager.getTool('mcp_fs_read');
    expect(tool).toBeDefined();

    const result = await tool!.executor({ uri: 'test.txt' });
    expect(result).toBe('result');
  });
});
