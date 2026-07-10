/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { stubLoopState } from './testHelpers.js';
import { streamOneTurn, resolveTurnContent } from './streamTurn';
import type { AgentCallbacks } from '../loop.js';
import type { StreamEvent } from '../../ollama/types.js';

function makeState() {
  return stubLoopState({
    approvalMode: 'autonomous',
    messages: [{ role: 'user', content: 'hi' }],
  });
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

describe('streamOneTurn episodic memory abort race', () => {
  it('does not hang when buildContextBlock never resolves — abort signal wins the race', async () => {
    const ac = new AbortController();
    const state = makeState();
    // Replace episodic memory: isEmpty=false (enters retrieval path) but
    // buildContextBlock fires the abort and returns a never-resolving promise.
    (state.episodicMemory as unknown as Record<string, unknown>) = {
      isEmpty: () => false,
      buildContextBlock: () => {
        ac.abort();
        return new Promise<string>(() => {});
      },
    };
    const abortError = new Error('aborted');
    abortError.name = 'AbortError';
    const client = clientThatThrows([], abortError);

    const result = await streamOneTurn(client, state, ac.signal, makeCallbacks(), 0);
    expect(result.terminated).toBe('aborted');
  });
});

describe('resolveTurnContent text tool call parsing', () => {
  it('parses tool calls from model text when no structured tool_use blocks are present', () => {
    const toolCallText = '<tool_call>\n{"name": "read_file", "arguments": {"path": "src/foo.ts"}}\n</tool_call>';

    const onToolCall = vi.fn();
    const state = makeState();
    (state as any).tools = [
      {
        name: 'read_file',
        description: 'Reads a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ];
    const callbacks = makeCallbacks({ onToolCall });
    const turn = { fullText: toolCallText, pendingToolUses: [], stopReason: 'stop', terminated: undefined };

    const result = resolveTurnContent(turn as never, state, callbacks);

    expect(onToolCall).toHaveBeenCalledWith(
      'read_file',
      expect.objectContaining({ path: 'src/foo.ts' }),
      expect.any(String),
    );
    expect(result.pendingToolUses).toHaveLength(1);
    expect(result.stopReason).toBe('tool_use');
  });
});

describe('streamOneTurn answer-in-thinking fallback', () => {
  function clientYielding(events: StreamEvent[]): any {
    return {
      async *streamChat() {
        for (const ev of events) yield ev;
      },
    };
  }

  it('promotes thinking to text when a turn ends with thinking but no text and no tool call', async () => {
    // qwen3.5 under a large system prompt: whole answer arrives as thinking,
    // content empty. The thinking IS the answer — surface it as text.
    const events: StreamEvent[] = [
      { type: 'thinking', thinking: 'The file exports a greet function ' },
      { type: 'thinking', thinking: 'that returns a hello message.' },
      { type: 'stop', stopReason: 'end_turn' },
    ];
    const onText = vi.fn();
    const result = await streamOneTurn(
      clientYielding(events),
      makeState(),
      new AbortController().signal,
      makeCallbacks({ onText }),
      0,
    );
    expect(result.fullText).toBe('The file exports a greet function that returns a hello message.');
    // finalText/observers must see it — the empty-answer bug was that onText never fired.
    expect(onText).toHaveBeenCalledWith('The file exports a greet function that returns a hello message.');
  });

  it('does NOT promote thinking when the turn also produced real text', async () => {
    const events: StreamEvent[] = [
      { type: 'thinking', thinking: 'reasoning...' },
      { type: 'text', text: 'The real answer.' },
      { type: 'stop', stopReason: 'end_turn' },
    ];
    const result = await streamOneTurn(
      clientYielding(events),
      makeState(),
      new AbortController().signal,
      makeCallbacks(),
      0,
    );
    expect(result.fullText).toBe('The real answer.');
  });

  it('does NOT promote thinking when the turn produced a tool call (thinking is genuine reasoning)', async () => {
    const events: StreamEvent[] = [
      { type: 'thinking', thinking: 'I should read the file first.' },
      { type: 'tool_use', toolUse: { type: 'tool_use', id: 't1', name: 'read_file', input: { path: 'x.ts' } } },
      { type: 'stop', stopReason: 'tool_use' },
    ];
    const result = await streamOneTurn(
      clientYielding(events),
      makeState(),
      new AbortController().signal,
      makeCallbacks(),
      0,
    );
    expect(result.fullText).toBe('');
    expect(result.pendingToolUses).toHaveLength(1);
  });
});

describe('streamOneTurn <plan_state> injection (S1)', () => {
  function clientCapturingPrompt(captured: { prompt?: string }): any {
    return {
      getSystemPrompt: () => 'BASE PROMPT',
      async *streamChat(_msgs: unknown, _sig: unknown, _tools: unknown, systemPrompt?: string) {
        captured.prompt = systemPrompt;
        yield { type: 'stop', stopReason: 'end_turn' } as StreamEvent;
      },
    };
  }

  it('re-injects the current plan into the system prompt every turn', async () => {
    const captured: { prompt?: string } = {};
    const state = makeState();
    state.planRef.plan = { steps: ['locate', 'fix', 'verify'], current: 2, lastResult: 'found it' };

    await streamOneTurn(clientCapturingPrompt(captured), state, new AbortController().signal, makeCallbacks(), 0);

    expect(captured.prompt).toContain('BASE PROMPT');
    expect(captured.prompt).toContain('<plan_state>');
    expect(captured.prompt).toContain('Step 2/3 (current): fix');
    expect(captured.prompt).toContain('Last result: found it');
  });

  it('leaves the system prompt untouched when no plan exists', async () => {
    const captured: { prompt?: string } = {};
    const state = makeState();

    await streamOneTurn(clientCapturingPrompt(captured), state, new AbortController().signal, makeCallbacks(), 0);

    expect(captured.prompt ?? '').not.toContain('<plan_state>');
  });
});

describe('plan nudge before a plan exists (S1 adoption)', () => {
  function clientCapturing(captured: { prompt?: string }): any {
    return {
      getSystemPrompt: () => 'BASE',
      async *streamChat(_m: unknown, _s: unknown, _t: unknown, systemPrompt?: string) {
        captured.prompt = systemPrompt;
        yield { type: 'stop', stopReason: 'end_turn' } as StreamEvent;
      },
    };
  }

  it('injects the call-update_plan nudge when the gate is on and no plan exists', async () => {
    const captured: { prompt?: string } = {};
    const state = makeState();
    (state.config as { planExternalizedEnabled?: boolean }).planExternalizedEnabled = true;
    await streamOneTurn(clientCapturing(captured), state, new AbortController().signal, makeCallbacks(), 0);
    expect(captured.prompt).toContain('call update_plan with the full step list');
    expect(captured.prompt).toContain('SAME message as your first real tool call');
  });

  it('injects nothing when the gate is off', async () => {
    const captured: { prompt?: string } = {};
    const state = makeState();
    (state.config as { planExternalizedEnabled?: boolean }).planExternalizedEnabled = false;
    await streamOneTurn(clientCapturing(captured), state, new AbortController().signal, makeCallbacks(), 0);
    expect(captured.prompt ?? '').not.toContain('plan_state');
  });
});
