import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentCallbacks } from './loop.js';

// Mock runAgentLoop so tests don't drive a real LLM loop
vi.mock('./loop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./loop.js')>();
  return {
    ...actual,
    runAgentLoop: vi.fn().mockResolvedValue([]),
  };
});

import { spawnSubAgent } from './subagent.js';
import { MAX_AGENT_DEPTH } from './loop.js';
import { runAgentLoop } from './loop.js';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(runAgentLoop).mockResolvedValue([] as never);
});

function makeCallbacks(): AgentCallbacks {
  return {
    onText: vi.fn(),
    onCharsConsumed: vi.fn(),
    onThinking: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeClient(): any {
  return {
    getSystemPrompt: vi.fn().mockReturnValue('parent system prompt'),
    updateSystemPrompt: vi.fn(),
  };
}

/** Builds a mock impl that calls a sub-agent callback fn then returns [] */
function withSubCallbacks(fn: (cbs: AgentCallbacks) => void) {
  return (async (_c: unknown, _m: unknown, cbs: AgentCallbacks) => {
    fn(cbs);
    return [];
  }) as never;
}

describe('spawnSubAgent', () => {
  it('returns a depth-exceeded failure when max depth is reached', async () => {
    const callbacks = makeCallbacks();
    const result = await spawnSubAgent(
      makeClient(),
      'do something',
      undefined,
      callbacks,
      new AbortController().signal,
      { depth: MAX_AGENT_DEPTH },
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain('maximum nesting depth');
    expect(runAgentLoop).not.toHaveBeenCalled();
  });

  it('runs the agent loop when depth is below max', async () => {
    const callbacks = makeCallbacks();
    const result = await spawnSubAgent(
      makeClient(),
      'fix the bug',
      undefined,
      callbacks,
      new AbortController().signal,
      { depth: 0 },
    );

    expect(result.success).toBe(true);
    expect(runAgentLoop).toHaveBeenCalledOnce();
  });

  it('includes context in the prompt when provided', async () => {
    const callbacks = makeCallbacks();
    await spawnSubAgent(
      makeClient(),
      'summarize',
      'Here is relevant background info',
      callbacks,
      new AbortController().signal,
    );

    const callArgs = vi.mocked(runAgentLoop).mock.calls[0];
    const messages = callArgs[1];
    expect(messages[0].content).toContain('Context:');
    expect(messages[0].content).toContain('Here is relevant background info');
  });

  it('restores parent system prompt after success', async () => {
    const client = makeClient();
    const callbacks = makeCallbacks();
    await spawnSubAgent(client, 'task', undefined, callbacks, new AbortController().signal);

    expect(client.updateSystemPrompt).toHaveBeenLastCalledWith('parent system prompt');
  });

  it('restores parent system prompt after failure', async () => {
    vi.mocked(runAgentLoop).mockRejectedValueOnce(new Error('loop crashed'));
    const client = makeClient();
    const callbacks = makeCallbacks();
    const result = await spawnSubAgent(client, 'task', undefined, callbacks, new AbortController().signal);

    expect(result.success).toBe(false);
    expect(result.output).toContain('loop crashed');
    expect(client.updateSystemPrompt).toHaveBeenLastCalledWith('parent system prompt');
  });

  it('notifies parent callbacks about tool calls during sub-agent run', async () => {
    vi.mocked(runAgentLoop).mockImplementationOnce(
      withSubCallbacks((cbs) => cbs.onToolCall('read_file', { path: 'src/app.ts' }, 'tool-1')),
    );
    const callbacks = makeCallbacks();
    await spawnSubAgent(makeClient(), 'read something', undefined, callbacks, new AbortController().signal);
    expect(callbacks.onToolCall).toHaveBeenCalledWith('read_file', { path: 'src/app.ts' }, 'tool-1');
  });

  it('accumulates text output via onText callback', async () => {
    vi.mocked(runAgentLoop).mockImplementationOnce(
      withSubCallbacks((cbs) => {
        cbs.onText('hello ');
        cbs.onText('world');
      }),
    );
    const callbacks = makeCallbacks();
    const result = await spawnSubAgent(makeClient(), 'write', undefined, callbacks, new AbortController().signal);
    expect(result.output).toBe('hello world');
  });

  it('accumulates chars consumed via onCharsConsumed callback', async () => {
    vi.mocked(runAgentLoop).mockImplementationOnce(
      withSubCallbacks((cbs) => {
        cbs.onCharsConsumed?.(100);
        cbs.onCharsConsumed?.(200);
      }),
    );
    const callbacks = makeCallbacks();
    const result = await spawnSubAgent(makeClient(), 'task', undefined, callbacks, new AbortController().signal);
    expect(result.charsConsumed).toBe(300);
  });

  it('invokes onToolResult callback forwarding to parent', async () => {
    vi.mocked(runAgentLoop).mockImplementationOnce(
      withSubCallbacks((cbs) => cbs.onToolResult('read_file', 'file content', false, 'tool-2')),
    );
    const callbacks = makeCallbacks();
    await spawnSubAgent(makeClient(), 'read', undefined, callbacks, new AbortController().signal);
    expect(callbacks.onToolResult).toHaveBeenCalledWith('read_file', 'file content', false, 'tool-2');
  });

  it('invokes onThinking callback without error', async () => {
    vi.mocked(runAgentLoop).mockImplementationOnce(
      withSubCallbacks((cbs) => cbs.onThinking?.('I am thinking deeply...')),
    );
    const callbacks = makeCallbacks();
    await expect(
      spawnSubAgent(makeClient(), 'think', undefined, callbacks, new AbortController().signal),
    ).resolves.toBeDefined();
  });

  it('invokes onDone callback without error', async () => {
    vi.mocked(runAgentLoop).mockImplementationOnce(withSubCallbacks((cbs) => cbs.onDone()));
    const callbacks = makeCallbacks();
    await expect(
      spawnSubAgent(makeClient(), 'done task', undefined, callbacks, new AbortController().signal),
    ).resolves.toBeDefined();
  });
});
