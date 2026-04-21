/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { streamOneTurn } from './streamTurn';
import type { LoopState } from './state';
import type { AgentCallbacks } from '../loop.js';
import type { StreamEvent } from '../../ollama/types.js';

/**
 * Minimum viable LoopState + callbacks for streamOneTurn. We only
 * need the fields the helper actually touches; unrelated ones are
 * filled with safe defaults so the test stays focused on the partial-
 * capture behavior added for /resume.
 */
function makeState(): LoopState {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    totalChars: 0,
    iteration: 1,
    maxIterations: 10,
    maxTokens: 100_000,
    approvalMode: 'autonomous',
    tools: [],
    recentToolCalls: [],
    autoFixRetriesByFile: new Map(),
    stubFixRetries: 0,
    criticInjectionsByFile: new Map(),
    gateState: null,
    logger: undefined,
    changelog: undefined,
    mcpManager: undefined,
    startTime: Date.now(),
    taskId: 'test-task',
  } as unknown as LoopState;
}

function makeCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onText: () => {},
    onToolCall: () => {},
    onToolResult: () => {},
    onDone: () => {},
    ...overrides,
  };
}

/** Build a SideCarClient stub whose streamChat yields `events` then throws `error`. */
function clientThatThrows(events: StreamEvent[], error: Error): any {
  return {
    async *streamChat() {
      for (const ev of events) yield ev;
      throw error;
    },
  };
}

describe('streamOneTurn onStreamFailure capture', () => {
  it('fires onStreamFailure with the accumulated partial when the stream throws non-abort', async () => {
    const partialEvents: StreamEvent[] = [
      { type: 'text', text: 'Here is part one. ' },
      { type: 'text', text: 'And part two before the failure.' },
    ];
    const error = new Error('ECONNRESET');
    const client = clientThatThrows(partialEvents, error);

    const onStreamFailure = vi.fn();
    const onText = vi.fn();
    const state = makeState();
    const callbacks = makeCallbacks({ onStreamFailure, onText });

    await expect(streamOneTurn(client, state, new AbortController().signal, callbacks, 0)).rejects.toThrow(
      'ECONNRESET',
    );

    expect(onStreamFailure).toHaveBeenCalledTimes(1);
    const [partial, capturedErr] = onStreamFailure.mock.calls[0];
    expect(partial).toBe('Here is part one. And part two before the failure.');
    expect(capturedErr).toBe(error);
    // Text callbacks still fired for each chunk before the throw.
    expect(onText).toHaveBeenCalledTimes(2);
  });

  it('does not fire onStreamFailure when no text was streamed before the throw', async () => {
    const error = new Error('immediate-failure');
    const client = clientThatThrows([], error);

    const onStreamFailure = vi.fn();
    const state = makeState();
    const callbacks = makeCallbacks({ onStreamFailure });

    await expect(streamOneTurn(client, state, new AbortController().signal, callbacks, 0)).rejects.toThrow(
      'immediate-failure',
    );

    expect(onStreamFailure).not.toHaveBeenCalled();
  });

  it('swallows onStreamFailure listener errors so they cannot mask the original throw', async () => {
    const partialEvents: StreamEvent[] = [{ type: 'text', text: 'some partial text' }];
    const originalError = new Error('original');
    const client = clientThatThrows(partialEvents, originalError);

    const onStreamFailure = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const state = makeState();
    const callbacks = makeCallbacks({ onStreamFailure });

    // The thrown error must still be the original backend error, not the
    // listener's secondary error — otherwise we'd be hiding the real cause.
    await expect(streamOneTurn(client, state, new AbortController().signal, callbacks, 0)).rejects.toThrow('original');
    expect(onStreamFailure).toHaveBeenCalledTimes(1);
  });

  it('does not fire onStreamFailure on abort errors', async () => {
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const client = clientThatThrows([{ type: 'text', text: 'partial' }], abortError);

    const onStreamFailure = vi.fn();
    const state = makeState();
    const callbacks = makeCallbacks({ onStreamFailure });

    // Abort errors are swallowed to a `terminated: 'aborted'` result, not re-thrown.
    const result = await streamOneTurn(client, state, new AbortController().signal, callbacks, 0);
    expect(result.terminated).toBe('aborted');
    expect(onStreamFailure).not.toHaveBeenCalled();
  });
});
