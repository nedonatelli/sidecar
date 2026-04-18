import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window } from 'vscode';
import { applyAgentLoopRouting } from './routing.js';
import { SideCarClient } from '../../ollama/client.js';
import { ModelRouter } from '../../ollama/modelRouter.js';
import type { LoopState } from './state.js';
import type { ChatMessage } from '../../ollama/types.js';

const showWarning = vi.spyOn(window, 'showWarningMessage');
beforeEach(() => showWarning.mockReset());

function stubState(overrides: Partial<LoopState> = {}): LoopState {
  // Minimal LoopState stub — applyAgentLoopRouting only reads `iteration`
  // and `messages`. The rest is filled with empty/zero values so the
  // type checks.
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
    // applyAgentLoopRouting never touches gateState — a minimal shape
    // with no fields is enough for the type check.
    gateState: {} as LoopState['gateState'],
    currentEditPlan: null,
    ...overrides,
  };
}

describe('applyAgentLoopRouting', () => {
  const showInfo = vi.spyOn(window, 'showInformationMessage');

  beforeEach(() => {
    showInfo.mockReset();
  });

  it('is a no-op when no router is attached', () => {
    const client = new SideCarClient('ollama/qwen3-coder:30b', 'http://localhost:11434', 'ollama');
    const state = stubState();
    applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: true, modelRoutingDryRun: false });
    expect(client.getModel()).toBe('ollama/qwen3-coder:30b');
    expect(showInfo).not.toHaveBeenCalled();
  });

  it('swaps the active model when a rule matches', () => {
    const client = new SideCarClient('ollama/qwen3-coder:30b', 'http://localhost:11434', 'ollama');
    client.setRouter(
      new ModelRouter([{ when: 'agent-loop.complexity=high', model: 'claude-opus-4-6' }], 'ollama/qwen3-coder:30b'),
    );
    const state = stubState({ iteration: 10 }); // triggers complexity=high
    applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: true, modelRoutingDryRun: false });
    expect(client.getModel()).toBe('claude-opus-4-6');
  });

  it('surfaces a toast on swap when visibleSwaps is on', () => {
    const client = new SideCarClient('ollama/qwen3-coder:30b', 'http://localhost:11434', 'ollama');
    client.setRouter(
      new ModelRouter([{ when: 'agent-loop.complexity=high', model: 'claude-opus-4-6' }], 'ollama/qwen3-coder:30b'),
    );
    const state = stubState({ iteration: 10 });
    applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: true, modelRoutingDryRun: false });
    expect(showInfo).toHaveBeenCalledOnce();
    expect(showInfo.mock.calls[0][0]).toContain('claude-opus-4-6');
    expect(showInfo.mock.calls[0][0]).toContain('agent-loop.complexity=high');
  });

  it('suppresses the toast when visibleSwaps is off', () => {
    const client = new SideCarClient('ollama/qwen3-coder:30b', 'http://localhost:11434', 'ollama');
    client.setRouter(
      new ModelRouter([{ when: 'agent-loop.complexity=high', model: 'claude-opus-4-6' }], 'ollama/qwen3-coder:30b'),
    );
    const state = stubState({ iteration: 10 });
    applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: false, modelRoutingDryRun: false });
    expect(client.getModel()).toBe('claude-opus-4-6'); // still swaps
    expect(showInfo).not.toHaveBeenCalled();
  });

  it('dryRun logs the decision and leaves the active model untouched', () => {
    const infoLog = vi.spyOn(console, 'info').mockImplementation(() => void 0);
    const client = new SideCarClient('ollama/qwen3-coder:30b', 'http://localhost:11434', 'ollama');
    client.setRouter(
      new ModelRouter([{ when: 'agent-loop.complexity=high', model: 'claude-opus-4-6' }], 'ollama/qwen3-coder:30b'),
    );
    const state = stubState({ iteration: 10 });
    applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: true, modelRoutingDryRun: true });
    expect(client.getModel()).toBe('ollama/qwen3-coder:30b');
    expect(infoLog).toHaveBeenCalled();
    expect(infoLog.mock.calls[0][0]).toContain('dryRun');
    expect(infoLog.mock.calls[0][0]).toContain('claude-opus-4-6');
    expect(showInfo).not.toHaveBeenCalled();
    infoLog.mockRestore();
  });

  it('dryRun resyncs router.activeModel on revert so a later non-dryRun swap still fires its toast', () => {
    const infoLog = vi.spyOn(console, 'info').mockImplementation(() => void 0);
    const client = new SideCarClient('ollama/qwen3-coder:30b', 'http://localhost:11434', 'ollama');
    client.setRouter(
      new ModelRouter([{ when: 'agent-loop.complexity=high', model: 'claude-opus-4-6' }], 'ollama/qwen3-coder:30b'),
    );
    const state = stubState({ iteration: 10 });

    // Turn 1: dryRun on — decision recorded, model reverted.
    applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: true, modelRoutingDryRun: true });
    expect(client.getModel()).toBe('ollama/qwen3-coder:30b');

    // Turn 2: dryRun off — expect a real swap + toast. Before the
    // resync fix, `router.activeModel` still said "claude-opus-4-6"
    // (from turn 1's route call), so swap=false and the toast was
    // suppressed even though the client was actually on qwen.
    showInfo.mockReset();
    applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: true, modelRoutingDryRun: false });
    expect(client.getModel()).toBe('claude-opus-4-6');
    expect(showInfo).toHaveBeenCalledOnce();
    infoLog.mockRestore();
  });

  it('escalates when the user prompt contains reasoning cues', () => {
    const client = new SideCarClient('ollama/qwen3-coder:30b', 'http://localhost:11434', 'ollama');
    client.setRouter(
      new ModelRouter([{ when: 'agent-loop.complexity=high', model: 'claude-opus-4-6' }], 'ollama/qwen3-coder:30b'),
    );
    const messages: ChatMessage[] = [{ role: 'user', content: 'Please prove this theorem step by step' }];
    const state = stubState({ messages });
    applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: false, modelRoutingDryRun: false });
    expect(client.getModel()).toBe('claude-opus-4-6');
  });

  it('counts tool_use blocks on the most recent assistant message for complexity', () => {
    const client = new SideCarClient('ollama/qwen3-coder:30b', 'http://localhost:11434', 'ollama');
    client.setRouter(
      new ModelRouter([{ when: 'agent-loop.complexity=high', model: 'claude-opus-4-6' }], 'ollama/qwen3-coder:30b'),
    );
    const tenToolUses = Array.from({ length: 10 }, (_, i) => ({
      type: 'tool_use' as const,
      id: `t${i}`,
      name: 'read_file',
      input: {},
    }));
    const messages: ChatMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: tenToolUses },
    ];
    const state = stubState({ messages });
    applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: false, modelRoutingDryRun: false });
    expect(client.getModel()).toBe('claude-opus-4-6');
  });

  describe('downgrade toast (v0.64 phase 4c.3)', () => {
    it('fires a warning toast the first time a rule downgrades due to budget', () => {
      const client = new SideCarClient('claude-opus-4-6', 'https://api.anthropic.com', 'sk-test');
      const router = new ModelRouter(
        [{ when: 'agent-loop', model: 'claude-opus-4-6', fallbackModel: 'claude-haiku-4-5', sessionBudget: 0.5 }],
        'default',
      );
      client.setRouter(router);

      // First call: in-budget, no downgrade, no warning.
      const state = stubState();
      applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: true, modelRoutingDryRun: false });
      expect(showWarning).not.toHaveBeenCalled();

      // Charge the rule over its cap.
      router.recordSpend(router.getRules()[0], 1.0);

      // Second call: downgrade fires, warning shown.
      applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: true, modelRoutingDryRun: false });
      expect(showWarning).toHaveBeenCalledOnce();
      expect(showWarning.mock.calls[0][0]).toContain('budget cap hit');
      expect(showWarning.mock.calls[0][0]).toContain('claude-haiku-4-5');
    });

    it('does not re-fire the warning on subsequent downgraded dispatches of the same rule', () => {
      const client = new SideCarClient('claude-opus-4-6', 'https://api.anthropic.com', 'sk-test');
      const router = new ModelRouter(
        [{ when: 'agent-loop', model: 'claude-opus-4-6', fallbackModel: 'claude-haiku-4-5', sessionBudget: 0.5 }],
        'default',
      );
      client.setRouter(router);
      router.recordSpend(router.getRules()[0], 1.0);

      const state = stubState();
      applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: true, modelRoutingDryRun: false });
      applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: true, modelRoutingDryRun: false });
      applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: true, modelRoutingDryRun: false });
      expect(showWarning).toHaveBeenCalledOnce();
    });

    it('fires the downgrade warning even when visibleSwaps is off (budget events are always surfaced)', () => {
      const client = new SideCarClient('claude-opus-4-6', 'https://api.anthropic.com', 'sk-test');
      const router = new ModelRouter(
        [{ when: 'agent-loop', model: 'claude-opus-4-6', fallbackModel: 'claude-haiku-4-5', sessionBudget: 0.5 }],
        'default',
      );
      client.setRouter(router);
      router.recordSpend(router.getRules()[0], 1.0);

      const state = stubState();
      applyAgentLoopRouting(client, state, { modelRoutingVisibleSwaps: false, modelRoutingDryRun: false });
      expect(showWarning).toHaveBeenCalledOnce();
    });
  });
});
