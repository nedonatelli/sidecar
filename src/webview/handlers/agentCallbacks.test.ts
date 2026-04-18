import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createAgentCallbacks,
  STREAM_FLUSH_MS,
  TOOL_CALL_SUMMARY_MAX,
  TOOL_RESULT_PREVIEW_MAX,
} from './agentCallbacks.js';
import type { ChatState } from '../chatState.js';
import type { ChatMessage } from '../../ollama/types.js';
import type { getConfig } from '../../config/settings.js';
import type { EditPlan } from '../../agent/editPlan.js';

// ---------------------------------------------------------------------------
// Tests for agentCallbacks.ts (v0.65 chunk 5c).
//
// createAgentCallbacks returns the bundle that connects the agent loop
// to the chat webview. Each callback is tested in isolation against a
// minimal ChatState stub so we cover the UI-surfacing logic without
// standing up handleUserMessage + the full run pipeline.
// ---------------------------------------------------------------------------

function makeState(overrides: Partial<ChatState> = {}): ChatState {
  return {
    postMessage: vi.fn(),
    logMessage: vi.fn(),
    requestConfirm: vi.fn(),
    metricsCollector: {
      recordToolStart: vi.fn(),
      recordToolEnd: vi.fn(),
      getToolDuration: vi.fn().mockReturnValue(0),
    },
    auditLog: undefined,
    workspaceIndex: undefined,
    agentMemory: undefined,
    pendingPlan: null,
    pendingPlanMessages: [],
    pendingPartialAssistant: null,
    pendingSteerSnapshot: null,
    currentSteerQueue: null,
    ...overrides,
  } as unknown as ChatState;
}

function makeConfig(overrides: Partial<ReturnType<typeof getConfig>> = {}): ReturnType<typeof getConfig> {
  return {
    verboseMode: false,
    enableAgentMemory: false,
    ...overrides,
  } as ReturnType<typeof getConfig>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createAgentCallbacks — onText streaming + flush', () => {
  it('buffers text and flushes once after STREAM_FLUSH_MS', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onText('Hello ');
    cb.onText('world');
    // Buffered — no postMessage yet.
    expect(state.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'assistantMessage' }));
    vi.advanceTimersByTime(STREAM_FLUSH_MS);
    expect(state.postMessage).toHaveBeenCalledWith({ command: 'assistantMessage', content: 'Hello world' });
  });

  it('does not fire a second flush when no new text arrives', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onText('a');
    vi.advanceTimersByTime(STREAM_FLUSH_MS);
    vi.advanceTimersByTime(STREAM_FLUSH_MS);
    const calls = (state.postMessage as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => (c[0] as { command: string }).command === 'assistantMessage',
    );
    expect(calls).toHaveLength(1);
  });

  it('onDone flushes any pending text immediately and posts done', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onText('unflushed');
    cb.onDone();
    expect(state.postMessage).toHaveBeenCalledWith({ command: 'assistantMessage', content: 'unflushed' });
    expect(state.postMessage).toHaveBeenCalledWith({ command: 'done' });
  });
});

describe('createAgentCallbacks — onThinking', () => {
  it('forwards thinking text as a thinking message', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onThinking?.('pondering the problem');
    expect(state.postMessage).toHaveBeenCalledWith({
      command: 'thinking',
      content: 'pondering the problem',
    });
  });
});

describe('createAgentCallbacks — onToolCall', () => {
  it('flushes buffered text before emitting the tool call', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onText('about to call');
    cb.onToolCall('read_file', { path: 'a.ts' }, 'tu1');
    // Text flushed before the toolCall
    const commands = (state.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { command: string }).command,
    );
    expect(commands.indexOf('assistantMessage')).toBeLessThan(commands.indexOf('toolCall'));
  });

  it('emits a tool_use summary + logs + records tool start', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onToolCall('read_file', { path: 'src/a.ts' }, 'tu1');
    expect(state.postMessage).toHaveBeenCalledWith({
      command: 'toolCall',
      toolName: 'read_file',
      toolCallId: 'tu1',
      content: 'read_file(path: src/a.ts)',
    });
    expect(state.logMessage).toHaveBeenCalledWith('tool', 'read_file(path: src/a.ts)');
    expect(state.metricsCollector.recordToolStart).toHaveBeenCalled();
  });

  it('truncates long string inputs in the summary', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    const longContent = 'x'.repeat(TOOL_CALL_SUMMARY_MAX + 50);
    cb.onToolCall('write_file', { path: 'a.ts', content: longContent }, 'tu1');
    const call = (state.postMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { command: string }).command === 'toolCall',
    );
    expect((call![0] as { content: string }).content).toContain('...');
    expect((call![0] as { content: string }).content.length).toBeLessThan(longContent.length);
  });

  it('tracks workspace file access when workspaceIndex is present', () => {
    const trackFileAccess = vi.fn();
    const state = makeState({
      workspaceIndex: { trackFileAccess } as unknown as ChatState['workspaceIndex'],
    });
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onToolCall('write_file', { path: 'src/a.ts' }, 'tu1');
    expect(trackFileAccess).toHaveBeenCalledWith('src/a.ts', 'write');
    cb.onToolCall('read_file', { path: 'src/b.ts' }, 'tu2');
    expect(trackFileAccess).toHaveBeenCalledWith('src/b.ts', 'read');
  });

  it('records a verbose log entry when verboseMode is on', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig({ verboseMode: true }), []);
    cb.onToolCall('grep', { pattern: 'TODO' }, 'tu1');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'verboseLog', verboseLabel: 'Tool Selected' }),
    );
  });

  it('forwards tool call to auditLog when set', () => {
    const recordToolCall = vi.fn();
    const state = makeState({
      auditLog: { recordToolCall, recordToolResult: vi.fn() } as unknown as ChatState['auditLog'],
    });
    const cb = createAgentCallbacks(state, makeConfig(), []);
    // Fire an iteration-start first so currentIteration is set.
    cb.onIterationStart?.({
      iteration: 3,
      maxIterations: 25,
      elapsedMs: 0,
      estimatedTokens: 0,
      messageCount: 0,
      messagesRemaining: 0,
      atCapacity: false,
    });
    cb.onToolCall('read_file', { path: 'a.ts' }, 'tu1');
    expect(recordToolCall).toHaveBeenCalledWith('read_file', { path: 'a.ts' }, 'tu1', 3);
  });
});

describe('createAgentCallbacks — onToolResult', () => {
  it('truncates result preview and records tool end', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    const long = 'y'.repeat(TOOL_RESULT_PREVIEW_MAX + 50);
    cb.onToolResult('read_file', long, false, 'tu1');
    const call = (state.postMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { command: string }).command === 'toolResult',
    );
    expect((call![0] as { content: string }).content).toHaveLength(TOOL_RESULT_PREVIEW_MAX + 3); // +3 for '...'
    expect(state.metricsCollector.recordToolEnd).toHaveBeenCalledWith('read_file', false);
  });

  it('forwards is_error=true through to recordToolEnd', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onToolResult('run_command', 'permission denied', true, 'tu1');
    expect(state.metricsCollector.recordToolEnd).toHaveBeenCalledWith('run_command', true);
  });
});

describe('createAgentCallbacks — onIterationStart', () => {
  it('emits agentProgress with iteration counters', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onIterationStart?.({
      iteration: 5,
      maxIterations: 25,
      elapsedMs: 12000,
      estimatedTokens: 5000,
      messageCount: 15,
      messagesRemaining: 185,
      atCapacity: false,
    });
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'agentProgress',
        iteration: 5,
        maxIterations: 25,
        atCapacity: false,
      }),
    );
  });

  it('surfaces the at-capacity warning in the verbose log', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig({ verboseMode: true }), []);
    cb.onIterationStart?.({
      iteration: 10,
      maxIterations: 25,
      elapsedMs: 5000,
      estimatedTokens: 9000,
      messageCount: 200,
      messagesRemaining: 0,
      atCapacity: true,
    });
    const verboseCall = (state.postMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { command: string }).command === 'verboseLog',
    );
    expect((verboseCall![0] as { content: string }).content).toContain('At message limit');
  });
});

describe('createAgentCallbacks — onPlanGenerated', () => {
  it('stashes the plan + chatMessages snapshot and emits planReady', () => {
    const state = makeState();
    const messages: ChatMessage[] = [{ role: 'user', content: 'do a thing' }];
    const cb = createAgentCallbacks(state, makeConfig(), messages);
    cb.onPlanGenerated?.('1. step one\n2. step two');
    expect(state.pendingPlan).toBe('1. step one\n2. step two');
    expect(state.pendingPlanMessages).toEqual(messages);
    expect(state.pendingPlanMessages).not.toBe(messages); // defensive copy
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'planReady', content: expect.stringContaining('step one') }),
    );
  });
});

describe('createAgentCallbacks — memory callbacks', () => {
  it('onMemory no-ops when enableAgentMemory is false', () => {
    const addMem = vi.fn();
    const state = makeState({
      agentMemory: {
        add: addMem,
        recordToolUse: vi.fn(),
        flushToolChain: vi.fn(),
      } as unknown as ChatState['agentMemory'],
    });
    const cb = createAgentCallbacks(state, makeConfig({ enableAgentMemory: false }), []);
    cb.onMemory?.('pattern', 'tool:read_file', 'worked well');
    expect(addMem).not.toHaveBeenCalled();
  });

  it('onMemory records to agentMemory when enableAgentMemory is true', () => {
    const addMem = vi.fn();
    const state = makeState({
      agentMemory: {
        add: addMem,
        recordToolUse: vi.fn(),
        flushToolChain: vi.fn(),
      } as unknown as ChatState['agentMemory'],
    });
    const cb = createAgentCallbacks(state, makeConfig({ enableAgentMemory: true }), []);
    cb.onMemory?.('pattern', 'tool:read_file', 'worked well');
    expect(addMem).toHaveBeenCalledWith(
      'pattern',
      'tool:read_file',
      'worked well',
      expect.stringContaining('Session:'),
    );
  });

  it('onMemory swallows errors from agentMemory.add', () => {
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const addMem = vi.fn().mockImplementation(() => {
      throw new Error('memory full');
    });
    const state = makeState({
      agentMemory: {
        add: addMem,
        recordToolUse: vi.fn(),
        flushToolChain: vi.fn(),
      } as unknown as ChatState['agentMemory'],
    });
    const cb = createAgentCallbacks(state, makeConfig({ enableAgentMemory: true }), []);
    expect(() => cb.onMemory?.('pattern', 'x', 'y')).not.toThrow();
    expect(consoleWarn).toHaveBeenCalled();
  });

  it('onToolChainRecord and onToolChainFlush respect enableAgentMemory', () => {
    const recordToolUse = vi.fn();
    const flushToolChain = vi.fn();
    const state = makeState({
      agentMemory: { add: vi.fn(), recordToolUse, flushToolChain } as unknown as ChatState['agentMemory'],
    });
    const enabled = createAgentCallbacks(state, makeConfig({ enableAgentMemory: true }), []);
    enabled.onToolChainRecord?.('read_file', true);
    enabled.onToolChainFlush?.();
    expect(recordToolUse).toHaveBeenCalledWith('read_file', true);
    expect(flushToolChain).toHaveBeenCalled();

    recordToolUse.mockClear();
    flushToolChain.mockClear();
    const disabled = createAgentCallbacks(state, makeConfig({ enableAgentMemory: false }), []);
    disabled.onToolChainRecord?.('read_file', true);
    disabled.onToolChainFlush?.();
    expect(recordToolUse).not.toHaveBeenCalled();
    expect(flushToolChain).not.toHaveBeenCalled();
  });
});

describe('createAgentCallbacks — onSuggestNextSteps', () => {
  it('no-ops when the suggestion list is empty', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onSuggestNextSteps?.([]);
    expect(state.postMessage).not.toHaveBeenCalled();
  });

  it('forwards non-empty suggestions', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onSuggestNextSteps?.(['Run tests', 'Review diff']);
    expect(state.postMessage).toHaveBeenCalledWith({
      command: 'suggestNextSteps',
      suggestions: ['Run tests', 'Review diff'],
    });
  });
});

describe('createAgentCallbacks — onEditPlan (v0.65 chunk 4.4a wiring)', () => {
  it('flushes pending text and emits the editPlanCard with a deep-copied plan', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onText('about to edit');
    const plan: EditPlan = {
      edits: [
        { path: 'a.ts', op: 'edit', rationale: 'fix', dependsOn: [] },
        { path: 'b.ts', op: 'edit', rationale: 'follow-up', dependsOn: ['a.ts'] },
      ],
    };
    cb.onEditPlan?.(plan);
    // Pending text flushes before the plan card.
    const commands = (state.postMessage as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as { command: string }).command,
    );
    expect(commands.indexOf('assistantMessage')).toBeLessThan(commands.indexOf('editPlanCard'));
    const planCard = (state.postMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { command: string }).command === 'editPlanCard',
    );
    const emittedPlan = (planCard![0] as { editPlan: { edits: Array<{ dependsOn: string[] }> } }).editPlan;
    expect(emittedPlan.edits).toHaveLength(2);
    // dependsOn array is a copy — mutating it doesn't affect the source.
    emittedPlan.edits[1].dependsOn.push('c.ts');
    expect(plan.edits[1].dependsOn).toEqual(['a.ts']);
  });
});

describe('createAgentCallbacks — onStreamFailure (v0.65 chunk 3.4 persistence)', () => {
  it('flushes buffered text, stashes the partial, and emits the resume affordance', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onText('mid-stream ');
    cb.onStreamFailure?.('mid-stream partial', new Error('ECONNRESET'));
    expect(state.pendingPartialAssistant).toBe('mid-stream partial');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'assistantMessage',
        content: expect.stringContaining('Stream interrupted'),
      }),
    );
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'resumeAvailable' }));
  });

  it('stashes serialized steer queue when one is active and has items', () => {
    const serialize = vi.fn().mockReturnValue([{ id: 's1', text: 'keep going', urgency: 'nudge', createdAt: 1 }]);
    const state = makeState({
      currentSteerQueue: { serialize } as unknown as ChatState['currentSteerQueue'],
    });
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onStreamFailure?.('partial', new Error('boom'));
    expect(state.pendingSteerSnapshot).toEqual([{ id: 's1', text: 'keep going', urgency: 'nudge', createdAt: 1 }]);
  });

  it('leaves pendingSteerSnapshot null when the queue is empty', () => {
    const state = makeState({
      currentSteerQueue: { serialize: vi.fn().mockReturnValue([]) } as unknown as ChatState['currentSteerQueue'],
    });
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onStreamFailure?.('partial', new Error('boom'));
    expect(state.pendingSteerSnapshot).toBeNull();
  });

  it('carries the stashed steer count on the resumeAvailable message (v0.65 chunk 7b)', () => {
    const serialize = vi.fn().mockReturnValue([
      { id: 's1', text: 'a', urgency: 'nudge', createdAt: 1 },
      { id: 's2', text: 'b', urgency: 'interrupt', createdAt: 2 },
    ]);
    const state = makeState({
      currentSteerQueue: { serialize } as unknown as ChatState['currentSteerQueue'],
    });
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onStreamFailure?.('partial', new Error('boom'));
    const resumeMsg = (state.postMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { command: string }).command === 'resumeAvailable',
    );
    expect(resumeMsg).toBeDefined();
    expect((resumeMsg![0] as { steerCount: number }).steerCount).toBe(2);
  });

  it('sets steerCount=0 on resumeAvailable when no queue was active', () => {
    const state = makeState(); // currentSteerQueue: null
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onStreamFailure?.('partial', new Error('boom'));
    const resumeMsg = (state.postMessage as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => (c[0] as { command: string }).command === 'resumeAvailable',
    );
    expect((resumeMsg![0] as { steerCount: number }).steerCount).toBe(0);
  });
});

describe('createAgentCallbacks — onCheckpoint', () => {
  it('prompts via requestConfirm and returns true on "Continue"', async () => {
    const requestConfirm = vi.fn().mockResolvedValue('Continue');
    const state = makeState({ requestConfirm });
    const cb = createAgentCallbacks(state, makeConfig(), []);
    vi.useRealTimers(); // async confirm + promise chain needs real timers
    const result = await cb.onCheckpoint!('halfway there', 15, 10);
    expect(result).toBe(true);
    const prompt = requestConfirm.mock.calls[0][0];
    expect(prompt).toContain('halfway there');
    expect(prompt).toContain('10 iterations remaining');
  });

  it('returns false on "Stop here"', async () => {
    const requestConfirm = vi.fn().mockResolvedValue('Stop here');
    const state = makeState({ requestConfirm });
    const cb = createAgentCallbacks(state, makeConfig(), []);
    vi.useRealTimers();
    expect(await cb.onCheckpoint!('progress', 15, 10)).toBe(false);
  });

  it('returns true (safe default: keep running) when requestConfirm throws', async () => {
    const requestConfirm = vi.fn().mockRejectedValue(new Error('UI gone'));
    const state = makeState({ requestConfirm });
    const cb = createAgentCallbacks(state, makeConfig(), []);
    vi.useRealTimers();
    expect(await cb.onCheckpoint!('progress', 15, 10)).toBe(true);
  });
});

describe('createAgentCallbacks — onToolOutput + onProgressSummary', () => {
  it('forwards toolOutput streaming chunks', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onToolOutput?.('run_command', 'some stdout chunk', 'tu1');
    expect(state.postMessage).toHaveBeenCalledWith({
      command: 'toolOutput',
      content: 'some stdout chunk',
      toolName: 'run_command',
      toolCallId: 'tu1',
    });
  });

  it('forwards progress summaries', () => {
    const state = makeState();
    const cb = createAgentCallbacks(state, makeConfig(), []);
    cb.onProgressSummary?.('Analyzed 5 files');
    expect(state.postMessage).toHaveBeenCalledWith({ command: 'agentProgress', content: 'Analyzed 5 files' });
  });
});
