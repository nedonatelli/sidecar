import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Tests for autoFix.ts (v0.65 chunk 2b — loop helper hardening).
//
// `applyAutoFix` runs after tool execution, pulls diagnostics for
// every write_file / edit_file target, and injects a "fix these"
// reprompt when any file has `[Error]` diagnostics. Branch coverage:
//
//   1. Disabled via `autoFixOnFailure: false` → no-op
//   2. No write_file / edit_file in pendingToolUses → no-op
//   3. Every written file exhausted retry budget → no-op
//   4. Diagnostics come back clean → no-op
//   5. Diagnostics report errors → injection + retry counter bump
//   6. Mixed (some exhausted, one still eligible)
// ---------------------------------------------------------------------------

vi.mock('../tools.js', () => ({
  getDiagnostics: vi.fn(),
}));

import { applyAutoFix } from './autoFix.js';
import { getDiagnostics } from '../tools.js';
import type { LoopState } from './state.js';
import type { AgentCallbacks } from '../loop.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';
import type { getConfig } from '../../config/settings.js';

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
    currentEditPlan: null,
    ...overrides,
  };
}

function stubCallbacks(): AgentCallbacks & { texts: string[] } {
  const texts: string[] = [];
  return {
    texts,
    onText: (t: string) => texts.push(t),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
  };
}

function stubConfig(overrides: Partial<ReturnType<typeof getConfig>> = {}): ReturnType<typeof getConfig> {
  return {
    autoFixOnFailure: true,
    autoFixMaxRetries: 3,
    ...overrides,
  } as unknown as ReturnType<typeof getConfig>;
}

function writeFile(path: string): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${path}`, name: 'write_file', input: { path, content: 'x' } };
}

beforeEach(() => {
  vi.mocked(getDiagnostics).mockReset();
});

describe('applyAutoFix', () => {
  it('returns false immediately when autoFixOnFailure is disabled', async () => {
    const state = stubState();
    const cb = stubCallbacks();
    const result = await applyAutoFix(state, [writeFile('a.ts')], stubConfig({ autoFixOnFailure: false }), cb);
    expect(result).toBe(false);
    expect(getDiagnostics).not.toHaveBeenCalled();
  });

  it('returns false when no write_file / edit_file calls were made this turn', async () => {
    const state = stubState();
    const cb = stubCallbacks();
    const readCall: ToolUseContentBlock = {
      type: 'tool_use',
      id: 'tu-read',
      name: 'read_file',
      input: { path: 'a.ts' },
    };
    const result = await applyAutoFix(state, [readCall], stubConfig(), cb);
    expect(result).toBe(false);
    expect(getDiagnostics).not.toHaveBeenCalled();
  });

  it('returns false when every written file has exhausted its retry budget', async () => {
    const state = stubState({
      autoFixRetriesByFile: new Map([
        ['a.ts', 3],
        ['b.ts', 3],
      ]),
    });
    const cb = stubCallbacks();
    const result = await applyAutoFix(
      state,
      [writeFile('a.ts'), writeFile('b.ts')],
      stubConfig({ autoFixMaxRetries: 3 }),
      cb,
    );
    expect(result).toBe(false);
    expect(getDiagnostics).not.toHaveBeenCalled();
  });

  it('returns false when getDiagnostics reports a clean file (no [Error] marker)', async () => {
    vi.mocked(getDiagnostics).mockResolvedValueOnce('No diagnostics found.');
    const state = stubState();
    const cb = stubCallbacks();
    const result = await applyAutoFix(state, [writeFile('a.ts')], stubConfig(), cb);
    expect(result).toBe(false);
    expect(state.messages).toHaveLength(0);
    expect(state.autoFixRetriesByFile.size).toBe(0);
  });

  it('injects a reprompt + bumps the retry counter when [Error] diagnostics are present', async () => {
    vi.mocked(getDiagnostics).mockResolvedValueOnce('src/a.ts:10 [Error] TS2304: Cannot find name "foo".');
    const state = stubState();
    const cb = stubCallbacks();
    const result = await applyAutoFix(state, [writeFile('a.ts')], stubConfig(), cb);
    expect(result).toBe(true);
    expect(state.autoFixRetriesByFile.get('a.ts')).toBe(1);
    expect(state.messages).toHaveLength(1);
    const content = state.messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    const text = (content as Array<{ type: string; text: string }>)[0].text;
    expect(text).toContain('Errors detected');
    expect(text).toContain('TS2304');
    expect(cb.texts[0]).toContain('Auto-fixing');
    expect(cb.texts[0]).toContain('a.ts');
    expect(cb.texts[0]).toContain('1/3'); // attempt/cap
  });

  it('only counts files with errors toward the retry counter (clean files do NOT bump)', async () => {
    vi.mocked(getDiagnostics)
      .mockResolvedValueOnce('src/a.ts:1 [Error] problem here')
      .mockResolvedValueOnce('b.ts looks clean.');
    const state = stubState();
    const cb = stubCallbacks();
    await applyAutoFix(state, [writeFile('a.ts'), writeFile('b.ts')], stubConfig(), cb);
    expect(state.autoFixRetriesByFile.get('a.ts')).toBe(1);
    expect(state.autoFixRetriesByFile.has('b.ts')).toBe(false);
  });

  it('filters out exhausted files but proceeds with the eligible remainder', async () => {
    vi.mocked(getDiagnostics).mockResolvedValueOnce('src/b.ts:5 [Error] nope');
    const state = stubState({
      autoFixRetriesByFile: new Map([['a.ts', 3]]), // exhausted
    });
    const cb = stubCallbacks();
    const result = await applyAutoFix(
      state,
      [writeFile('a.ts'), writeFile('b.ts')],
      stubConfig({ autoFixMaxRetries: 3 }),
      cb,
    );
    expect(result).toBe(true);
    // a.ts was skipped before the diagnostics call — never examined, never bumped
    expect(state.autoFixRetriesByFile.get('a.ts')).toBe(3);
    expect(state.autoFixRetriesByFile.get('b.ts')).toBe(1);
    expect(getDiagnostics).toHaveBeenCalledTimes(1); // only b.ts probed
  });

  it('handles a rejected getDiagnostics promise by treating it as "no errors"', async () => {
    vi.mocked(getDiagnostics).mockRejectedValueOnce(new Error('LSP offline'));
    const state = stubState();
    const cb = stubCallbacks();
    const result = await applyAutoFix(state, [writeFile('a.ts')], stubConfig(), cb);
    expect(result).toBe(false);
    expect(state.messages).toHaveLength(0);
  });

  it('reads file_path as well as path (compat for tools that use either key)', async () => {
    vi.mocked(getDiagnostics).mockResolvedValueOnce('[Error] something');
    const state = stubState();
    const cb = stubCallbacks();
    const tu: ToolUseContentBlock = {
      type: 'tool_use',
      id: 'tu-x',
      name: 'edit_file',
      input: { file_path: 'uses-file-path-key.ts', content: 'x' },
    };
    const result = await applyAutoFix(state, [tu], stubConfig(), cb);
    expect(result).toBe(true);
    expect(state.autoFixRetriesByFile.get('uses-file-path-key.ts')).toBe(1);
  });
});
