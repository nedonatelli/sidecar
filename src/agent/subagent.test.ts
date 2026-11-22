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

  it('passes systemPromptOverride containing the sub-agent prefix + parent prompt', async () => {
    const client = makeClient();
    const callbacks = makeCallbacks();
    await spawnSubAgent(client, 'task', undefined, callbacks, new AbortController().signal);

    // New approach: systemPromptOverride is passed to runAgentLoop so the
    // shared client.systemPrompt field is never mutated.
    const callOptions = vi.mocked(runAgentLoop).mock.calls[0][4];
    expect(callOptions?.systemPromptOverride).toContain('sub-agent');
    expect(callOptions?.systemPromptOverride).toContain('parent system prompt');
    expect(client.updateSystemPrompt).not.toHaveBeenCalled();
  });

  it('does not mutate client system prompt even on failure', async () => {
    vi.mocked(runAgentLoop).mockRejectedValueOnce(new Error('loop crashed'));
    const client = makeClient();
    const callbacks = makeCallbacks();
    const result = await spawnSubAgent(client, 'task', undefined, callbacks, new AbortController().signal);

    expect(result.success).toBe(false);
    expect(result.output).toContain('loop crashed');
    expect(client.updateSystemPrompt).not.toHaveBeenCalled();
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

// #475: the loop returns normally from a timeout, the iteration cap, a stuck
// stop and a caught policy error, and every normal return was reported as
// success. The loop's reported termination now decides.
describe('spawnSubAgent: a sub-agent that did not finish is a failure (#475)', () => {
  const endingWith = (termination: string | undefined, text = 'partial notes') =>
    withSubCallbacks((cbs) => {
      cbs.onText(text);
      cbs.onOutcome?.(null, { aborted: false, scaffoldInterventions: 0, termination: termination as never });
      cbs.onDone();
    });
  const spawn = (opts = {}) =>
    spawnSubAgent(makeClient(), 'find the bug', undefined, makeCallbacks(), new AbortController().signal, opts);

  it('succeeds on a natural finish', async () => {
    vi.mocked(runAgentLoop).mockImplementationOnce(endingWith('natural', 'found it'));
    const r = await spawn();
    expect(r.success).toBe(true);
    expect(r.output).toBe('found it');
  });

  it('fails at the iteration cap, naming the cap and keeping what it produced', async () => {
    vi.mocked(runAgentLoop).mockImplementationOnce(endingWith('max-iterations'));
    const r = await spawn({ maxIterations: 40 });
    expect(r.success).toBe(false);
    expect(r.output).toContain('did not finish: it used all 15 of its iterations without finishing');
    expect(r.output).toContain('What it produced before stopping:\npartial notes');
  });

  it.each([
    ['out-of-resources', 'ran out of time or budget'],
    ['stuck', 'repeating the same actions'],
    ['aborted', 'stopped before it finished'],
    ['error', 'stopped on an error'],
    [undefined, 'an error it caught'],
  ])('fails when the loop ended %s', async (termination, phrase) => {
    vi.mocked(runAgentLoop).mockImplementationOnce(endingWith(termination));
    const r = await spawn();
    expect(r.success).toBe(false);
    expect(r.output).toContain(phrase);
  });

  it('tells the parent in the transcript too', async () => {
    const callbacks = makeCallbacks();
    vi.mocked(runAgentLoop).mockImplementationOnce(endingWith('out-of-resources'));
    await spawnSubAgent(makeClient(), 't', undefined, callbacks, new AbortController().signal);
    const said = vi
      .mocked(callbacks.onText)
      .mock.calls.map((c) => c[0])
      .join('');
    expect(said).toContain('did not finish');
    expect(said).not.toContain('completed]');
  });
});
