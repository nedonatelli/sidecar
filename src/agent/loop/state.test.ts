import { describe, it, expect, vi } from 'vitest';
import { initLoopState, DEFAULT_MAX_ITERATIONS } from './state.js';
import type { AgentOptions } from '../loop.js';
import type { ChatMessage } from '../../ollama/types.js';

// ---------------------------------------------------------------------------
// Tests for state.ts (v0.65 chunk 2b — loop helper hardening).
//
// `initLoopState` is a pure struct initializer: copies messages, seeds
// the char counter from existing content, applies option defaults for
// missing fields, and starts the iteration/retry maps empty. No I/O,
// no vscode deps — tests run synchronously.
// ---------------------------------------------------------------------------

function emptyOptions(): AgentOptions {
  return {};
}

describe('initLoopState', () => {
  describe('defaults', () => {
    it('uses DEFAULT_MAX_ITERATIONS when options.maxIterations is missing', () => {
      const state = initLoopState([], emptyOptions());
      expect(state.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
    });

    it('falls back to 100K tokens when options.maxTokens is missing', () => {
      const state = initLoopState([], emptyOptions());
      expect(state.maxTokens).toBe(100_000);
    });

    it('defaults approvalMode to "cautious"', () => {
      const state = initLoopState([], emptyOptions());
      expect(state.approvalMode).toBe('cautious');
    });

    it('starts iteration at 0 (orchestrator bumps to 1 on first turn)', () => {
      const state = initLoopState([], emptyOptions());
      expect(state.iteration).toBe(0);
    });

    it('seeds all retry maps + ring buffer as empty', () => {
      const state = initLoopState([], emptyOptions());
      expect(state.recentToolCalls).toEqual([]);
      expect(state.autoFixRetriesByFile.size).toBe(0);
      expect(state.stubFixRetries).toBe(0);
      expect(state.criticInjectionsByFile.size).toBe(0);
      expect(state.criticInjectionsByTestHash.size).toBe(0);
      expect(state.toolCallCounts.size).toBe(0);
    });

    it('records startTime near the current clock', () => {
      const before = Date.now();
      const state = initLoopState([], emptyOptions());
      const after = Date.now();
      expect(state.startTime).toBeGreaterThanOrEqual(before);
      expect(state.startTime).toBeLessThanOrEqual(after);
    });

    it('attaches a fresh gate state object', () => {
      const state1 = initLoopState([], emptyOptions());
      const state2 = initLoopState([], emptyOptions());
      expect(state1.gateState).not.toBe(state2.gateState); // distinct instances
    });
  });

  describe('option passthroughs', () => {
    it('honors explicit maxIterations / maxTokens / approvalMode', () => {
      const state = initLoopState([], {
        maxIterations: 7,
        maxTokens: 50_000,
        approvalMode: 'autonomous',
      });
      expect(state.maxIterations).toBe(7);
      expect(state.maxTokens).toBe(50_000);
      expect(state.approvalMode).toBe('autonomous');
    });

    it('propagates logger + changelog + mcpManager references verbatim', () => {
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as AgentOptions['logger'];
      const changelog = {} as AgentOptions['changelog'];
      // Minimal shape — getToolDefinitions is the only method initLoopState's
      // default tool-resolution path reaches through mcpManager when
      // toolOverride is not supplied.
      const mcpManager = { getToolDefinitions: () => [] } as unknown as AgentOptions['mcpManager'];
      const state = initLoopState([], { logger, changelog, mcpManager });
      expect(state.logger).toBe(logger);
      expect(state.changelog).toBe(changelog);
      expect(state.mcpManager).toBe(mcpManager);
    });

    it('uses options.toolOverride when provided (bypasses getToolDefinitions)', () => {
      const toolOverride: AgentOptions['toolOverride'] = [
        { name: 'custom', description: 'x', input_schema: { type: 'object', properties: {} } },
      ];
      const state = initLoopState([], { toolOverride });
      expect(state.tools).toBe(toolOverride);
    });

    it('maxIterations 0 is treated as "not provided" and falls back to DEFAULT', () => {
      // Current behavior: `options.maxIterations || DEFAULT` — zero is falsy.
      // This test pins the quirk so anyone changing to `?? DEFAULT` knows
      // they're changing behavior for the edge case.
      const state = initLoopState([], { maxIterations: 0 });
      expect(state.maxIterations).toBe(DEFAULT_MAX_ITERATIONS);
    });
  });

  describe('message history + char accounting', () => {
    it('copies the messages array — original remains untouched', () => {
      const original: ChatMessage[] = [{ role: 'user', content: 'hi' }];
      const state = initLoopState(original, emptyOptions());
      state.messages.push({ role: 'user', content: 'appended' });
      expect(original).toHaveLength(1);
      expect(state.messages).toHaveLength(2);
    });

    it('seeds totalChars from content length across all initial messages', () => {
      const messages: ChatMessage[] = [
        { role: 'user', content: 'hello' }, // 5 chars
        { role: 'assistant', content: 'hi there' }, // 8 chars
        { role: 'user', content: 'short' }, // 5 chars
      ];
      const state = initLoopState(messages, emptyOptions());
      expect(state.totalChars).toBe(18);
    });

    it('starts totalChars at 0 for an empty initial history', () => {
      const state = initLoopState([], emptyOptions());
      expect(state.totalChars).toBe(0);
    });

    it('accounts content-block arrays correctly (delegates to getContentLength)', () => {
      const messages: ChatMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'text', text: 'world' },
          ],
        },
      ];
      const state = initLoopState(messages, emptyOptions());
      expect(state.totalChars).toBe(10); // 5 + 5
    });
  });
});
