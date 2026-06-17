import { describe, it, expect, vi, afterEach } from 'vitest';
import { delegateToMcp, resolveTaskTool } from './mcpDelegate.js';
import type { ToolExecutorContext } from './shared.js';

// ---------------------------------------------------------------------------
// Tests for mcpDelegate.ts — delegate_to_mcp tool.
//
// MCPManager is stubbed to avoid real network calls. Covers:
//   - disabled guard
//   - missing server / task params
//   - allowlist enforcement
//   - server not connected
//   - auto-detection of task tool (TASK_TOOL_CANDIDATES priority)
//   - explicit tool param
//   - unknown explicit tool
//   - successful delegation
//   - callServerTool error propagation
//   - resolveTaskTool unit tests
// ---------------------------------------------------------------------------

function makeMcpManager(opts: {
  connected?: boolean;
  toolNames?: string[];
  callResult?: string;
  callThrows?: Error;
  serverNames?: string[];
}) {
  return {
    isServerConnected: vi.fn(() => opts.connected ?? true),
    getServerNames: vi.fn(() => opts.serverNames ?? ['math-engine']),
    getServerToolNames: vi.fn(() => opts.toolNames ?? ['run_task']),
    callServerTool: vi.fn(async () => {
      if (opts.callThrows) throw opts.callThrows;
      return opts.callResult ?? 'task result';
    }),
  };
}

function makeContext(mcpManager: ReturnType<typeof makeMcpManager>, enabled = true): ToolExecutorContext {
  return {
    config: {
      mcpDelegationEnabled: enabled,
      mcpDelegationAllowedServers: [],
    } as never,
    mcpManager: mcpManager as never,
  };
}

// ---------------------------------------------------------------------------
// resolveTaskTool unit tests
// ---------------------------------------------------------------------------

describe('resolveTaskTool', () => {
  it('returns explicit tool when it exists', () => {
    const result = resolveTaskTool('s', ['run_task', 'search'], 'search');
    expect('toolName' in result && result.toolName).toBe('search');
  });

  it('errors when explicit tool not in server tools', () => {
    const result = resolveTaskTool('s', ['run_task'], 'unknown');
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('"unknown"');
  });

  it('auto-detects run_task first', () => {
    const result = resolveTaskTool('s', ['run_task', 'execute', 'process']);
    expect('toolName' in result && result.toolName).toBe('run_task');
  });

  it('falls through candidate list in order', () => {
    const result = resolveTaskTool('s', ['process', 'execute']);
    expect('toolName' in result && result.toolName).toBe('execute');
  });

  it('errors when no candidate found', () => {
    const result = resolveTaskTool('s', ['list_items', 'search_docs']);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('No task-entry-point');
    expect((result as { error: string }).error).toContain('list_items');
  });

  it('errors gracefully with no available tools', () => {
    const result = resolveTaskTool('s', []);
    expect('error' in result).toBe(true);
    expect((result as { error: string }).error).toContain('(none)');
  });
});

// ---------------------------------------------------------------------------
// delegateToMcp integration tests
// ---------------------------------------------------------------------------

describe('delegateToMcp — guard paths', () => {
  it('returns disabled message when mcpDelegationEnabled is false', async () => {
    const mgr = makeMcpManager({});
    const ctx = makeContext(mgr, false);
    const result = await delegateToMcp({ server: 'x', task: 'y' }, ctx);
    expect(result).toContain('disabled');
  });

  it('returns error when server param is missing', async () => {
    const mgr = makeMcpManager({});
    const ctx = makeContext(mgr);
    const result = await delegateToMcp({ task: 'do it' }, ctx);
    expect(result).toContain('Missing required parameter: server');
  });

  it('returns error when task param is missing', async () => {
    const mgr = makeMcpManager({});
    const ctx = makeContext(mgr);
    const result = await delegateToMcp({ server: 'math-engine' }, ctx);
    expect(result).toContain('Missing required parameter: task');
  });

  it('returns error when server not in allowlist', async () => {
    const mgr = makeMcpManager({});
    const ctx: ToolExecutorContext = {
      config: {
        mcpDelegationEnabled: true,
        mcpDelegationAllowedServers: ['approved-server'],
      } as never,
      mcpManager: mgr as never,
    };
    const result = await delegateToMcp({ server: 'math-engine', task: 'solve' }, ctx);
    expect(result).toContain('not in the delegation allowlist');
    expect(result).toContain('approved-server');
  });

  it('allows all servers when allowlist is empty', async () => {
    const mgr = makeMcpManager({ toolNames: ['run_task'], callResult: 'ok' });
    const ctx = makeContext(mgr);
    const result = await delegateToMcp({ server: 'any-server', task: 'do it' }, ctx);
    expect(result).toBe('ok');
  });

  it('returns error when mcpManager is not available', async () => {
    const result = await delegateToMcp(
      { server: 'x', task: 'y' },
      { config: { mcpDelegationEnabled: true, mcpDelegationAllowedServers: [] } as never },
    );
    expect(result).toContain('MCP manager not available');
  });

  it('returns error when server is not connected', async () => {
    const mgr = makeMcpManager({ connected: false, serverNames: ['other-server'] });
    const ctx = makeContext(mgr);
    const result = await delegateToMcp({ server: 'math-engine', task: 'solve' }, ctx);
    expect(result).toContain('"math-engine" is not connected');
    expect(result).toContain('other-server');
  });

  it('returns error when no task tool is found and no explicit tool given', async () => {
    const mgr = makeMcpManager({ toolNames: ['list_items', 'search_docs'] });
    const ctx = makeContext(mgr);
    const result = await delegateToMcp({ server: 'math-engine', task: 'solve' }, ctx);
    expect(result).toContain('No task-entry-point');
  });
});

describe('delegateToMcp — successful delegation', () => {
  it('calls auto-detected run_task tool and returns result', async () => {
    const mgr = makeMcpManager({ toolNames: ['run_task', 'list'], callResult: 'solution: 42' });
    const ctx = makeContext(mgr);
    const result = await delegateToMcp({ server: 'math-engine', task: 'compute 6*7' }, ctx);
    expect(result).toBe('solution: 42');
    expect(mgr.callServerTool).toHaveBeenCalledWith('math-engine', 'run_task', { task: 'compute 6*7' });
  });

  it('uses explicit tool when provided', async () => {
    const mgr = makeMcpManager({ toolNames: ['run_task', 'solve'], callResult: 'done' });
    const ctx = makeContext(mgr);
    await delegateToMcp({ server: 'math-engine', task: 'integrate', tool: 'solve' }, ctx);
    expect(mgr.callServerTool).toHaveBeenCalledWith('math-engine', 'solve', { task: 'integrate' });
  });

  it('includes context in tool input when provided', async () => {
    const mgr = makeMcpManager({ toolNames: ['run_task'], callResult: 'ok' });
    const ctx = makeContext(mgr);
    await delegateToMcp({ server: 's', task: 'do it', context: 'prior work: X' }, ctx);
    expect(mgr.callServerTool).toHaveBeenCalledWith('s', 'run_task', {
      task: 'do it',
      context: 'prior work: X',
    });
  });

  it('does not include context key when context is empty', async () => {
    const mgr = makeMcpManager({ toolNames: ['run_task'], callResult: 'ok' });
    const ctx = makeContext(mgr);
    await delegateToMcp({ server: 's', task: 'do it', context: '  ' }, ctx);
    const callArg = (mgr.callServerTool.mock.calls[0] as unknown[])[2] as Record<string, unknown>;
    expect('context' in callArg).toBe(false);
  });

  it('redacts secrets in task and context before forwarding to the server', async () => {
    const mgr = makeMcpManager({ toolNames: ['run_task'], callResult: 'ok' });
    const ctx = makeContext(mgr);
    await delegateToMcp(
      {
        server: 's',
        task: 'use key AKIA1234567890ABCDEF to fetch data',
        context: 'token is ghp_0123456789012345678901234567890123456',
      },
      ctx,
    );
    const callArg = (mgr.callServerTool.mock.calls[0] as unknown[])[2] as Record<string, string>;
    expect(callArg.task).not.toContain('AKIA1234567890ABCDEF');
    expect(callArg.task).toContain('[REDACTED:AWS Access Key]');
    expect(callArg.context).not.toContain('ghp_0123456789012345678901234567890123456');
    expect(callArg.context).toContain('[REDACTED:GitHub Token]');
  });

  it('propagates callServerTool errors as a string result', async () => {
    const mgr = makeMcpManager({ toolNames: ['run_task'], callThrows: new Error('server crashed') });
    const ctx = makeContext(mgr);
    const result = await delegateToMcp({ server: 'math-engine', task: 'x' }, ctx);
    expect(result).toContain('server crashed');
    expect(result).toContain('math-engine/run_task');
  });
});

describe('delegateToMcp — timeout and abort', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns an error after 60 s when callServerTool never resolves', async () => {
    vi.useFakeTimers();
    // callServerTool hangs forever
    const mgr = {
      isServerConnected: vi.fn(() => true),
      getServerNames: vi.fn(() => ['math-engine']),
      getServerToolNames: vi.fn(() => ['run_task']),
      callServerTool: vi.fn(() => new Promise(() => {})),
    };
    const ctx = makeContext(mgr as never);

    const promise = delegateToMcp({ server: 'math-engine', task: 'compute' }, ctx);
    // Advance past MCP_DELEGATE_TIMEOUT_MS (60 000 ms)
    vi.advanceTimersByTime(60_001);
    const result = await promise;

    expect(result).toContain('timed out');
    expect(result).toContain('60');
    expect(result).toContain('math-engine/run_task');
  });

  it('returns an error immediately when the abort signal fires', async () => {
    const controller = new AbortController();
    const mgr = {
      isServerConnected: vi.fn(() => true),
      getServerNames: vi.fn(() => ['math-engine']),
      getServerToolNames: vi.fn(() => ['run_task']),
      callServerTool: vi.fn(() => new Promise(() => {})),
    };
    const ctx: ReturnType<typeof makeContext> = {
      ...makeContext(mgr as never),
      signal: controller.signal,
    };

    const promise = delegateToMcp({ server: 'math-engine', task: 'compute' }, ctx);
    controller.abort();
    const result = await promise;

    expect(result).toContain('aborted');
    expect(result).toContain('math-engine/run_task');
  });
});
