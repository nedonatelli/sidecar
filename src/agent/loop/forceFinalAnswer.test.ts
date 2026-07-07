import { describe, it, expect, vi } from 'vitest';
import { maybeForceFinalAnswer } from './forceFinalAnswer.js';
import type { LoopState } from './state.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks } from '../loop.js';
import type { StreamEvent } from '../../ollama/types.js';

function makeState(over: Partial<LoopState> = {}): LoopState {
  return {
    termination: 'max-iterations',
    messages: [
      { role: 'user', content: 'What does src/helpers.ts export?' },
      { role: 'assistant', content: '{"name":"read_file","arguments":{"path":"src/utils.ts"}}' },
    ],
    modelOverride: undefined,
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
    ...over,
  } as unknown as LoopState;
}

function mockClient(events: StreamEvent[], spy?: (args: unknown[]) => void): SideCarClient {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    streamChat: vi.fn(async function* (...args: any[]) {
      spy?.(args);
      for (const e of events) yield e;
    }),
  } as unknown as SideCarClient;
}

const text = (t: string): StreamEvent => ({ type: 'text', text: t }) as StreamEvent;

describe('maybeForceFinalAnswer', () => {
  const signal = new AbortController().signal;

  it('runs a tools-disabled synthesis turn on max-iterations and appends the answer', async () => {
    let seen: unknown[] = [];
    const client = mockClient([text('src/utils.ts exports '), text('clamp(n, min, max).')], (a) => (seen = a));
    const state = makeState();
    const onText = vi.fn();
    const callbacks = { onText } as unknown as AgentCallbacks;

    await maybeForceFinalAnswer(state, client, callbacks, signal);

    // Streamed to the user.
    expect(onText).toHaveBeenCalledWith('src/utils.ts exports ');
    expect(onText).toHaveBeenCalledWith('clamp(n, min, max).');
    // Appended as an assistant message for finalize().
    const last = state.messages.at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.content).toBe('src/utils.ts exports clamp(n, min, max).');
    // Tools disabled: third positional arg to streamChat is an empty array.
    expect(seen[2]).toEqual([]);
    // A forcing user message was appended before the call (not persisted to state).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sentMessages = seen[0] as any[];
    expect(sentMessages.at(-1).role).toBe('user');
    expect(String(sentMessages.at(-1).content)).toMatch(/final answer/i);
  });

  it('fires on stuck termination too', async () => {
    const client = mockClient([text('done')]);
    const state = makeState({ termination: 'stuck' });
    const callbacks = { onText: vi.fn() } as unknown as AgentCallbacks;
    await maybeForceFinalAnswer(state, client, callbacks, signal);
    expect(client.streamChat as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    expect(state.messages.at(-1)!.content).toBe('done');
  });

  it.each(['natural', 'aborted', 'out-of-resources'] as const)(
    'is a no-op on %s termination (model answered / user stopped / no budget)',
    async (termination) => {
      const client = mockClient([text('should not run')]);
      const state = makeState({ termination });
      const callbacks = { onText: vi.fn() } as unknown as AgentCallbacks;
      await maybeForceFinalAnswer(state, client, callbacks, signal);
      expect(client.streamChat as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
      expect(callbacks.onText).not.toHaveBeenCalled();
    },
  );

  it('is a no-op when the signal is already aborted', async () => {
    const client = mockClient([text('x')]);
    const state = makeState();
    const ac = new AbortController();
    ac.abort();
    const callbacks = { onText: vi.fn() } as unknown as AgentCallbacks;
    await maybeForceFinalAnswer(state, client, callbacks, ac.signal);
    expect(client.streamChat as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it('does not append an empty/whitespace answer', async () => {
    const client = mockClient([text('   \n  ')]);
    const state = makeState();
    const before = state.messages.length;
    const callbacks = { onText: vi.fn() } as unknown as AgentCallbacks;
    await maybeForceFinalAnswer(state, client, callbacks, signal);
    expect(state.messages.length).toBe(before);
  });

  it('swallows a synthesis-turn error without throwing', async () => {
    const client = {
      streamChat: vi.fn(async function* () {
        throw new Error('backend exploded');
        yield undefined as never; // unreachable; satisfies require-yield
      }),
    } as unknown as SideCarClient;
    const state = makeState();
    const before = state.messages.length;
    const callbacks = { onText: vi.fn() } as unknown as AgentCallbacks;
    await expect(maybeForceFinalAnswer(state, client, callbacks, signal)).resolves.toBeUndefined();
    expect(state.messages.length).toBe(before);
    expect(state.logger!.warn).toHaveBeenCalled();
  });
});
