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

  it('in PLAN MODE, a text-form call to a non-plan tool is NOT parsed as a call', () => {
    // The qwen3.5 bug: plan mode restricts the catalog to ask_user, but the text
    // parser used to validate against the FULL tool set — so a text-form read_file
    // (which qwen3.5 emits every time in plan mode) was parsed and recorded as a
    // call, and plan-mode-no-tools failed 0/15 while every other model passed.
    // In plan mode that text is the PLAN, not an action.
    const toolCallText = '<tool_call>\n{"name": "read_file", "arguments": {"path": "src/foo.ts"}}\n</tool_call>';
    const onToolCall = vi.fn();
    const state = makeState();
    (state as any).approvalMode = 'plan';
    (state as any).tools = [
      {
        name: 'read_file',
        description: 'Reads a file',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      { name: 'ask_user', description: 'Ask the user', input_schema: { type: 'object', properties: {}, required: [] } },
    ];
    const callbacks = makeCallbacks({ onToolCall });
    const turn = { fullText: toolCallText, pendingToolUses: [], stopReason: 'stop', terminated: undefined };

    const result = resolveTurnContent(turn as never, state, callbacks);

    expect(onToolCall).not.toHaveBeenCalled();
    expect(result.pendingToolUses).toHaveLength(0);
    // The turn ends as text (the plan), not a tool_use.
    expect(result.stopReason).not.toBe('tool_use');
  });

  it('in plan mode a text-form ask_user IS still parsed — plan mode permits it', () => {
    const toolCallText =
      '<tool_call>\n{"name": "ask_user", "arguments": {"question": "which framework?"}}\n</tool_call>';
    const onToolCall = vi.fn();
    const state = makeState();
    (state as any).approvalMode = 'plan';
    (state as any).tools = [
      {
        name: 'read_file',
        description: 'Reads a file',
        input_schema: { type: 'object', properties: {}, required: [] },
      },
      { name: 'ask_user', description: 'Ask the user', input_schema: { type: 'object', properties: {}, required: [] } },
    ];
    const callbacks = makeCallbacks({ onToolCall });
    const turn = { fullText: toolCallText, pendingToolUses: [], stopReason: 'stop', terminated: undefined };

    const result = resolveTurnContent(turn as never, state, callbacks);

    expect(onToolCall).toHaveBeenCalledWith(
      'ask_user',
      expect.objectContaining({ question: 'which framework?' }),
      expect.any(String),
    );
    expect(result.pendingToolUses).toHaveLength(1);
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

describe('fence-write coercion — already-done escape', () => {
  // v0.122 gemma4 (fix-wrong-comparison-operator): after edit_file answered
  // "No change needed", the model printed the correct final file as a
  // completion summary. Coercion read the fence as an unapplied edit and
  // synthesized a write_file over it, re-entering the loop the already-applied
  // response exists to end. A fence after that signal is a summary, not work.
  const FENCE_TURN =
    'The fix is in place. Final state of src/minmax.ts:\n' +
    '```typescript\nexport function max(a: number, b: number): number {\n  return a >= b ? a : b;\n}\n```\n';

  function makeCoercionState(latestResultText: string) {
    const state = stubLoopState({
      approvalMode: 'autonomous',
      messages: [
        { role: 'user', content: 'fix the max function in src/minmax.ts' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'edit_file', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: latestResultText }] },
      ] as never,
      config: { codeAsTextRecoveryEnabled: true } as never,
    });
    (state as any).tools = [
      {
        name: 'write_file',
        description: 'Writes a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
      },
    ];
    return state;
  }

  it('does NOT synthesize a write after a "No change needed" result', () => {
    const state = makeCoercionState(
      '<tool_output tool="edit_file">\nNo change needed: src/minmax.ts already contains the result of this edit.\n</tool_output>',
    );
    const onToolCall = vi.fn();
    const turn = { fullText: FENCE_TURN, pendingToolUses: [], stopReason: 'stop', terminated: undefined };
    const result = resolveTurnContent(turn as never, state, makeCallbacks({ onToolCall }));
    expect(onToolCall).not.toHaveBeenCalled();
    expect(result.pendingToolUses).toHaveLength(0);
    expect(result.stopReason).not.toBe('tool_use');
  });

  it('still synthesizes the write when the latest result shows real progress', () => {
    const state = makeCoercionState('<tool_output tool="edit_file">\nFile edited: src/other.ts\n</tool_output>');
    const onToolCall = vi.fn();
    const turn = { fullText: FENCE_TURN, pendingToolUses: [], stopReason: 'stop', terminated: undefined };
    const result = resolveTurnContent(turn as never, state, makeCallbacks({ onToolCall }));
    expect(onToolCall).toHaveBeenCalledWith(
      'write_file',
      expect.objectContaining({ path: 'src/minmax.ts' }),
      expect.any(String),
    );
    expect(result.pendingToolUses).toHaveLength(1);
  });
});
