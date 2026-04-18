import { describe, it, expect } from 'vitest';
import { pushAssistantMessage, pushToolResultsMessage, accountToolTokens } from './messageBuild.js';
import type { LoopState } from './state.js';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';

// ---------------------------------------------------------------------------
// Tests for messageBuild.ts (v0.65 chunk 2a — loop helper hardening).
//
// Three tiny helpers that wrap message-push + char-accounting. All
// pure over state.messages / state.totalChars; no side effects beyond
// mutation of those two fields. Branch coverage targets:
//
//   - pushAssistantMessage: empty turn, text-only, tool-use-only,
//     text + tool_use, multiple tool_use blocks
//   - pushToolResultsMessage: appends a user-role message
//   - accountToolTokens: sums both sides into state.totalChars
// ---------------------------------------------------------------------------

function stubState(overrides: Partial<LoopState> = {}): LoopState {
  return {
    startTime: Date.now(),
    maxIterations: 25,
    maxTokens: 100_000,
    approvalMode: 'cautious',
    tools: [],
    logger: undefined,
    changelog: undefined,
    mcpManager: undefined,
    messages: [],
    iteration: 1,
    totalChars: 0,
    recentToolCalls: [],
    autoFixRetriesByFile: new Map(),
    stubFixRetries: 0,
    criticInjectionsByFile: new Map(),
    criticInjectionsByTestHash: new Map(),
    toolCallCounts: new Map(),
    gateState: {} as LoopState['gateState'],
    ...overrides,
  };
}

function toolUse(name: string, input: Record<string, unknown> = {}): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${name}`, name, input };
}

function toolResult(toolUseId: string, content: string, isError = false): ToolResultContentBlock {
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError };
}

describe('pushAssistantMessage', () => {
  it('does not push anything when both text AND tool-uses are empty', () => {
    const state = stubState();
    pushAssistantMessage(state, '', []);
    expect(state.messages).toHaveLength(0);
  });

  it('pushes a text-only assistant message', () => {
    const state = stubState();
    pushAssistantMessage(state, 'Hello there.', []);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('assistant');
    expect(state.messages[0].content).toEqual([{ type: 'text', text: 'Hello there.' }]);
  });

  it('pushes tool-uses only (empty text)', () => {
    const state = stubState();
    const tu = toolUse('read_file', { path: 'a.ts' });
    pushAssistantMessage(state, '', [tu]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toEqual([tu]);
  });

  it('pushes text + tool-uses in order (text first)', () => {
    const state = stubState();
    const tu1 = toolUse('read_file', { path: 'a.ts' });
    const tu2 = toolUse('grep', { pattern: 'foo' });
    pushAssistantMessage(state, 'Reasoning first.', [tu1, tu2]);
    const content = state.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect((content as Array<{ type: string }>)[0]).toEqual({ type: 'text', text: 'Reasoning first.' });
    expect((content as Array<{ type: string }>)[1]).toBe(tu1);
    expect((content as Array<{ type: string }>)[2]).toBe(tu2);
  });

  it('leaves prior messages in place when appending', () => {
    const state = stubState({
      messages: [{ role: 'user', content: 'hi' }],
    });
    pushAssistantMessage(state, 'hello', []);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[0].role).toBe('user');
    expect(state.messages[1].role).toBe('assistant');
  });
});

describe('pushToolResultsMessage', () => {
  it('wraps tool results in a user-role message', () => {
    const state = stubState();
    const results = [toolResult('tu-1', 'ok'), toolResult('tu-2', 'done')];
    pushToolResultsMessage(state, results);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('user');
    expect(state.messages[0].content).toBe(results);
  });

  it('accepts an empty results list (still pushes a user turn)', () => {
    // This isn't a use case the loop invokes — if there are no tool
    // uses there should be no results call — but the helper doesn't
    // guard and test pins current behavior.
    const state = stubState();
    pushToolResultsMessage(state, []);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].content).toEqual([]);
  });
});

describe('accountToolTokens', () => {
  it('adds both tool-use and tool-result content sizes to state.totalChars', () => {
    // Delegates sizing to `getContentLength` (covered in types.test.ts);
    // this test pins that BOTH sides get accounted, without depending on
    // the exact byte formula inside `getContentLength`.
    const state = stubState({ totalChars: 100 });
    const tu = toolUse('read_file', { path: 'a.ts' });
    const tr = toolResult(tu.id, 'file content here');

    const beforeOnlyUse = stubState({ totalChars: 100 });
    accountToolTokens(beforeOnlyUse, [tu], []);
    const deltaUseOnly = beforeOnlyUse.totalChars - 100;

    const beforeOnlyResult = stubState({ totalChars: 100 });
    accountToolTokens(beforeOnlyResult, [], [tr]);
    const deltaResultOnly = beforeOnlyResult.totalChars - 100;

    accountToolTokens(state, [tu], [tr]);
    expect(state.totalChars).toBe(100 + deltaUseOnly + deltaResultOnly);
    expect(deltaUseOnly).toBeGreaterThan(0);
    expect(deltaResultOnly).toBeGreaterThan(0);
  });

  it('is a no-op for empty tool-use + tool-result arrays', () => {
    const state = stubState({ totalChars: 500 });
    accountToolTokens(state, [], []);
    expect(state.totalChars).toBe(500);
  });

  it('accumulates across multiple calls within the same turn', () => {
    const state = stubState();
    const tu1 = toolUse('read_file', { path: 'a' });
    const tu2 = toolUse('grep', { pattern: 'x' });
    accountToolTokens(state, [tu1], []);
    const after1 = state.totalChars;
    accountToolTokens(state, [tu2], []);
    expect(state.totalChars).toBeGreaterThan(after1);
  });
});
