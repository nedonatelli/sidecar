import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Tests for postTurnPolicies.ts (v0.65 chunk 2a — loop helper hardening).
//
// The composer itself is a three-liner: auto-fix → stub → critic. Each
// underlying policy is tested in its own module (autoFix.test.ts,
// stubCheck.test.ts, critic.runner.test.ts). These tests pin the
// composer's responsibility: sequencing + passing the right args to
// each policy.
//
// Because the composer imports from `./autoFix`, `./stubCheck`, and
// `./criticHook` directly, we vi.mock those modules to keep the test
// focused on the ordering, not on re-exercising every policy's
// internals.
// ---------------------------------------------------------------------------

vi.mock('./autoFix.js', () => ({
  applyAutoFix: vi.fn(async () => false),
}));
vi.mock('./stubCheck.js', () => ({
  applyStubCheck: vi.fn(() => false),
}));
vi.mock('./criticHook.js', () => ({
  applyCritic: vi.fn(async () => {}),
}));

import { applyPostTurnPolicies } from './postTurnPolicies.js';
import { applyAutoFix } from './autoFix.js';
import { applyStubCheck } from './stubCheck.js';
import { applyCritic } from './criticHook.js';
import type { LoopState } from './state.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks } from '../loop.js';
import type { ToolUseContentBlock, ToolResultContentBlock } from '../../ollama/types.js';

function stubState(): LoopState {
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
  };
}

function stubCallbacks(): AgentCallbacks {
  return {
    onText: vi.fn(),
    onToolCall: vi.fn(),
    onToolResult: vi.fn(),
    onDone: vi.fn(),
  };
}

describe('applyPostTurnPolicies', () => {
  beforeEach(() => {
    vi.mocked(applyAutoFix).mockClear();
    vi.mocked(applyStubCheck).mockClear();
    vi.mocked(applyCritic).mockClear();
  });

  it('runs all three policies in order: auto-fix → stub → critic', async () => {
    const callOrder: string[] = [];
    vi.mocked(applyAutoFix).mockImplementation(async () => {
      callOrder.push('autoFix');
      return false;
    });
    vi.mocked(applyStubCheck).mockImplementation(() => {
      callOrder.push('stubCheck');
      return false;
    });
    vi.mocked(applyCritic).mockImplementation(async () => {
      callOrder.push('critic');
    });

    const state = stubState();
    const cb = stubCallbacks();
    const client = {} as SideCarClient;
    const config = {} as Parameters<typeof applyPostTurnPolicies>[2];
    const signal = new AbortController().signal;

    await applyPostTurnPolicies(state, client, config, [], [], '', cb, signal);

    expect(callOrder).toEqual(['autoFix', 'stubCheck', 'critic']);
  });

  it('passes the signal through to both async policies (autoFix + critic)', async () => {
    const state = stubState();
    const cb = stubCallbacks();
    const client = {} as SideCarClient;
    const config = {} as Parameters<typeof applyPostTurnPolicies>[2];
    const controller = new AbortController();

    await applyPostTurnPolicies(state, client, config, [], [], '', cb, controller.signal);

    // autoFix does NOT take a signal in the current API (see autoFix.ts)
    // — only critic does. Pin that behavior so a future refactor
    // doesn't silently drop the signal from the critic path.
    const criticArgs = vi.mocked(applyCritic).mock.calls[0];
    expect(criticArgs[criticArgs.length - 1]).toBe(controller.signal);
  });

  it('passes toolUses + toolResults to every policy that needs them', async () => {
    const state = stubState();
    const cb = stubCallbacks();
    const client = {} as SideCarClient;
    const config = {} as Parameters<typeof applyPostTurnPolicies>[2];

    const tu: ToolUseContentBlock = {
      type: 'tool_use',
      id: 'tu1',
      name: 'write_file',
      input: { path: 'x.ts', content: 'y' },
    };
    const tr: ToolResultContentBlock = {
      type: 'tool_result',
      tool_use_id: 'tu1',
      content: 'ok',
      is_error: false,
    };

    await applyPostTurnPolicies(state, client, config, [tu], [tr], 'final text', cb, new AbortController().signal);

    // autoFix gets state + pendingToolUses + config + callbacks
    expect(vi.mocked(applyAutoFix).mock.calls[0]).toEqual([state, [tu], config, cb]);
    // stubCheck gets state + pendingToolUses + callbacks
    expect(vi.mocked(applyStubCheck).mock.calls[0]).toEqual([state, [tu], cb]);
    // critic gets state + client + config + pendingToolUses + toolResults + fullText + callbacks + signal
    const criticCall = vi.mocked(applyCritic).mock.calls[0];
    expect(criticCall[3]).toEqual([tu]);
    expect(criticCall[4]).toEqual([tr]);
    expect(criticCall[5]).toBe('final text');
  });

  it('awaits each async policy before moving to the next', async () => {
    const events: string[] = [];
    vi.mocked(applyAutoFix).mockImplementation(async () => {
      events.push('autoFix-start');
      await new Promise((r) => setTimeout(r, 5));
      events.push('autoFix-end');
      return false;
    });
    vi.mocked(applyStubCheck).mockImplementation(() => {
      events.push('stubCheck');
      return false;
    });
    vi.mocked(applyCritic).mockImplementation(async () => {
      events.push('critic-start');
      await new Promise((r) => setTimeout(r, 5));
      events.push('critic-end');
    });

    const state = stubState();
    const cb = stubCallbacks();
    const client = {} as SideCarClient;
    const config = {} as Parameters<typeof applyPostTurnPolicies>[2];

    await applyPostTurnPolicies(state, client, config, [], [], '', cb, new AbortController().signal);

    expect(events).toEqual(['autoFix-start', 'autoFix-end', 'stubCheck', 'critic-start', 'critic-end']);
  });
});
