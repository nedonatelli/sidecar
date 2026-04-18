import { describe, it, expect, vi } from 'vitest';
import { applyStubCheck } from './stubCheck.js';
import type { LoopState } from './state.js';
import type { AgentCallbacks } from '../loop.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';

// ---------------------------------------------------------------------------
// Tests for stubCheck.ts (v0.65 chunk 2a — loop helper hardening).
//
// `applyStubCheck` composes `buildStubReprompt` from stubValidator.ts
// with the loop's retry-budget + state-mutation ceremony. The
// detection itself is separately covered by stubValidator.test.ts, so
// these tests focus on the helper's responsibilities:
//
//   1. Retry budget (MAX_STUB_RETRIES = 1) — second call returns false
//   2. Injects a user message when stubs are detected
//   3. Returns false when the content is clean (no stubs)
//   4. Bumps state.stubFixRetries on each injection
//   5. Surfaces a user-visible warning via callbacks.onText
//   6. Logs the attempt via state.logger when present
// ---------------------------------------------------------------------------

function toolUseWriteFile(path: string, content: string): ToolUseContentBlock {
  return { type: 'tool_use', id: `tu-${path}`, name: 'write_file', input: { path, content } };
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

describe('applyStubCheck', () => {
  it('returns false when no stub patterns are found in the written content', () => {
    const state = stubState();
    const cb = stubCallbacks();
    const clean = toolUseWriteFile(
      'src/real.ts',
      'export function add(a: number, b: number): number { return a + b; }',
    );
    expect(applyStubCheck(state, [clean], cb)).toBe(false);
    expect(state.messages).toHaveLength(0);
    expect(state.stubFixRetries).toBe(0);
  });

  it('returns true + injects a reprompt when a stub pattern is detected', () => {
    const state = stubState();
    const cb = stubCallbacks();
    const stubbed = toolUseWriteFile('src/stub.ts', 'export function hello(): void {\n  // TODO: implement this\n}');
    expect(applyStubCheck(state, [stubbed], cb)).toBe(true);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('user');
    expect(state.stubFixRetries).toBe(1);
    expect(cb.texts[0]).toContain('Incomplete code');
  });

  it('refuses to inject a second reprompt — MAX_STUB_RETRIES=1 is a hard cap', () => {
    const state = stubState({ stubFixRetries: 1 }); // already at the cap
    const cb = stubCallbacks();
    const stubbed = toolUseWriteFile('src/stub.ts', '// TODO: implement\nfunction x() {}');
    expect(applyStubCheck(state, [stubbed], cb)).toBe(false);
    expect(state.messages).toHaveLength(0);
    expect(state.stubFixRetries).toBe(1); // unchanged
  });

  it('logs the retry attempt via state.logger.info when present', () => {
    const info = vi.fn();
    const state = stubState({ logger: { info, warn: vi.fn() } as unknown as LoopState['logger'] });
    const cb = stubCallbacks();
    const stubbed = toolUseWriteFile('src/stub.ts', '// TODO: implement\nfunction x() {}');
    applyStubCheck(state, [stubbed], cb);
    expect(info).toHaveBeenCalledOnce();
    expect(info.mock.calls[0][0]).toContain('Stub validator');
    expect(info.mock.calls[0][0]).toContain('1/1');
  });

  it('silently returns false when there are no write_file / edit_file calls', () => {
    const state = stubState();
    const cb = stubCallbacks();
    const readCall: ToolUseContentBlock = {
      type: 'tool_use',
      id: 'tu-read',
      name: 'read_file',
      input: { path: 'x.ts' },
    };
    expect(applyStubCheck(state, [readCall], cb)).toBe(false);
    expect(state.stubFixRetries).toBe(0);
  });

  it('handles edit_file with a stubbed replacement', () => {
    const state = stubState();
    const cb = stubCallbacks();
    const edit: ToolUseContentBlock = {
      type: 'tool_use',
      id: 'tu-edit',
      name: 'edit_file',
      input: {
        path: 'src/broken.ts',
        search: 'return 0;',
        replace: '// TODO: finish this\nthrow new Error("not implemented");',
      },
    };
    expect(applyStubCheck(state, [edit], cb)).toBe(true);
    expect(state.stubFixRetries).toBe(1);
  });
});
