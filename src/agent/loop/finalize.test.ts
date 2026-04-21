import { describe, it, expect, vi } from 'vitest';
import { finalize } from './finalize.js';
import type { LoopState } from './state.js';
import type { AgentCallbacks } from '../loop.js';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';

// ---------------------------------------------------------------------------
// Tests for finalize.ts (v0.65 chunk 2b — loop helper hardening).
//
// `finalize` does three things at loop teardown:
//   1. onToolChainFlush (optional — fires when defined)
//   2. onSuggestNextSteps (only when iteration > 1 AND suggestions > 0)
//   3. logDone + onDone (always)
//
// The private `generateNextStepSuggestions` isn't exported but it's
// exercised through finalize() by observing the onSuggestNextSteps
// callback payload.
// ---------------------------------------------------------------------------

function stubState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    startTime: Date.now(),
    taskId: 'test-task',
    maxIterations: 25,
    maxTokens: 100_000,
    approvalMode: 'cautious',
    tools: [],
    logger: undefined,
    changelog: undefined,
    mcpManager: undefined,
    messages: [],
    iteration: 2,
    totalChars: 0,
    recentToolCalls: [],
    autoFixRetriesByFile: new Map(),
    stubFixRetries: 0,
    criticInjectionsByFile: new Map(),
    criticInjectionsByTestHash: new Map(),
    toolCallCounts: new Map(),
    gateState: {} as LoopState['gateState'],
    currentEditPlan: null,
    ...overrides,
  };
}

function stubCallbacks(overrides: Partial<AgentCallbacks> = {}): AgentCallbacks {
  return {
    onText: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
    ...overrides,
  };
}

function use(name: string, input: Record<string, unknown> = {}): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${name}`, name, input };
}

function result(id: string, isError = false, content = 'ok'): ToolResultContentBlock {
  return { type: 'tool_result', tool_use_id: id, content, is_error: isError };
}

describe('finalize — plumbing', () => {
  it('always fires onDone and returns state.messages', () => {
    const onDone = vi.fn();
    const state = stubState({ messages: [{ role: 'user', content: 'hi' }] });
    const result = finalize(state, stubCallbacks({ onDone }));
    expect(onDone).toHaveBeenCalledOnce();
    expect(result).toBe(state.messages);
  });

  it('calls onToolChainFlush when the callback is defined', () => {
    const onToolChainFlush = vi.fn();
    finalize(stubState(), stubCallbacks({ onToolChainFlush }));
    expect(onToolChainFlush).toHaveBeenCalledOnce();
  });

  it('no-ops silently when onToolChainFlush is undefined', () => {
    expect(() => finalize(stubState(), stubCallbacks())).not.toThrow();
  });

  it('logs done with the iteration count via state.logger.logDone', () => {
    const logDone = vi.fn();
    const state = stubState({
      iteration: 7,
      logger: { logDone, warn: vi.fn(), info: vi.fn() } as unknown as LoopState['logger'],
    });
    finalize(state, stubCallbacks());
    expect(logDone).toHaveBeenCalledWith(7);
  });
});

describe('finalize — next-step suggestions gating', () => {
  it('skips suggestions entirely when iteration <= 1 (single Q&A turn)', () => {
    const onSuggestNextSteps = vi.fn();
    const state = stubState({
      iteration: 1,
      messages: [{ role: 'assistant', content: [use('write_file', { path: 'a.ts' })] }],
    });
    finalize(state, stubCallbacks({ onSuggestNextSteps }));
    expect(onSuggestNextSteps).not.toHaveBeenCalled();
  });

  it('skips suggestions when onSuggestNextSteps callback is undefined', () => {
    const state = stubState({
      iteration: 3,
      messages: [{ role: 'assistant', content: [use('write_file', { path: 'a.ts' })] }],
    });
    expect(() => finalize(state, stubCallbacks())).not.toThrow();
  });

  it('skips the emit when the analysis produces zero suggestions', () => {
    const onSuggestNextSteps = vi.fn();
    const state = stubState({
      iteration: 3,
      // Assistant turns with no tool_use — nothing to suggest.
      messages: [{ role: 'assistant', content: 'Just text, no tool calls.' }],
    });
    finalize(state, stubCallbacks({ onSuggestNextSteps }));
    expect(onSuggestNextSteps).not.toHaveBeenCalled();
  });
});

describe('finalize — suggestion contents', () => {
  it('suggests "Run tests" when files were written but no tests ran', () => {
    const onSuggestNextSteps = vi.fn();
    const state = stubState({
      iteration: 3,
      messages: [{ role: 'assistant', content: [use('write_file', { path: 'a.ts' })] }],
    });
    finalize(state, stubCallbacks({ onSuggestNextSteps }));
    const suggestions = onSuggestNextSteps.mock.calls[0][0] as string[];
    expect(suggestions.some((s) => s.includes('Run tests'))).toBe(true);
  });

  it('does NOT suggest tests when run_tests already ran', () => {
    const onSuggestNextSteps = vi.fn();
    const state = stubState({
      iteration: 3,
      messages: [{ role: 'assistant', content: [use('write_file', { path: 'a.ts' }), use('run_tests')] }],
    });
    finalize(state, stubCallbacks({ onSuggestNextSteps }));
    const suggestions = onSuggestNextSteps.mock.calls[0][0] as string[];
    expect(suggestions.some((s) => s.includes('Run tests'))).toBe(false);
  });

  it('suggests "Review errors" when any tool_result had is_error: true', () => {
    const onSuggestNextSteps = vi.fn();
    const state = stubState({
      iteration: 3,
      messages: [
        { role: 'assistant', content: [use('write_file', { path: 'a.ts' })] },
        { role: 'user', content: [result('tu-write_file', true, 'permission denied')] },
      ],
    });
    finalize(state, stubCallbacks({ onSuggestNextSteps }));
    const suggestions = onSuggestNextSteps.mock.calls[0][0] as string[];
    expect(suggestions.some((s) => s.includes('Review errors'))).toBe(true);
  });

  it('suggests "Review the diff" when files were written', () => {
    const onSuggestNextSteps = vi.fn();
    const state = stubState({
      iteration: 3,
      messages: [{ role: 'assistant', content: [use('edit_file', { path: 'a.ts' })] }],
    });
    finalize(state, stubCallbacks({ onSuggestNextSteps }));
    const suggestions = onSuggestNextSteps.mock.calls[0][0] as string[];
    expect(suggestions.some((s) => s.includes('Review the diff'))).toBe(true);
  });

  it('suggests "Apply the findings" when search_files ran but nothing was written', () => {
    const onSuggestNextSteps = vi.fn();
    const state = stubState({
      iteration: 3,
      messages: [{ role: 'assistant', content: [use('search_files', { query: 'x' })] }],
    });
    finalize(state, stubCallbacks({ onSuggestNextSteps }));
    const suggestions = onSuggestNextSteps.mock.calls[0][0] as string[];
    expect(suggestions.some((s) => s.includes('Apply the findings'))).toBe(true);
  });

  it('caps suggestions at 3 even when every trigger fires', () => {
    const onSuggestNextSteps = vi.fn();
    const state = stubState({
      iteration: 3,
      messages: [
        {
          role: 'assistant',
          content: [use('write_file', { path: 'a.ts' }), use('search_files', { query: 'x' })],
        },
        { role: 'user', content: [result('tu-write_file', true)] },
      ],
    });
    finalize(state, stubCallbacks({ onSuggestNextSteps }));
    const suggestions = onSuggestNextSteps.mock.calls[0][0] as string[];
    expect(suggestions.length).toBeLessThanOrEqual(3);
  });

  it('ignores string-content messages when scanning for tool_use (only array content has blocks)', () => {
    const onSuggestNextSteps = vi.fn();
    const state = stubState({
      iteration: 3,
      messages: [{ role: 'assistant', content: 'This is just text with no tool calls.' }],
    });
    finalize(state, stubCallbacks({ onSuggestNextSteps }));
    expect(onSuggestNextSteps).not.toHaveBeenCalled(); // no tools scanned → no suggestions
  });
});
