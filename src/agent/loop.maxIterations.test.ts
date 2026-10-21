import { describe, it, expect, vi } from 'vitest';
import { runAgentLoop } from './loop.js';
import { getConfig } from '../config/settings.js';
import type { StreamEvent } from '../ollama/types.js';
import type { SideCarClient } from '../ollama/client.js';
import type { AgentCallbacks, AgentOptions } from './loop.js';

vi.mock('./tools.js', () => ({
  getToolDefinitions: () => [],
  getToolDefinitionsForTier: () => [],
  getDiagnostics: async () => 'No diagnostics',
}));

// #237: the iteration ceiling defaults by capability tier when neither the
// caller nor the user set one. Observed through the run's own log line, which
// is logged after the tier resolves.

function client(model: string): SideCarClient {
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      yield { type: 'text', text: 'done' };
      yield { type: 'stop', stopReason: 'end_turn' };
    },
    getSystemPrompt: () => '',
    getRouter: () => null,
    getModel: () => model,
  } as unknown as SideCarClient;
}

const callbacks: AgentCallbacks = { onText: () => {}, onToolCall: () => {}, onToolResult: () => {}, onDone: () => {} };

async function ceiling(model: string, options: Partial<AgentOptions>, adaptive = true): Promise<number> {
  const lines: string[] = [];
  // Every AgentLogger method is a no-op except info, which is captured.
  const logger = new Proxy({} as Record<string, unknown>, {
    get: (_t, key) => (key === 'info' ? (l: string) => lines.push(l) : () => {}),
  });
  await runAgentLoop(client(model), [{ role: 'user', content: 'hi' }], callbacks, new AbortController().signal, {
    ...options,
    config: { ...getConfig(), adaptiveScaffoldingEnabled: adaptive, completionGateEnabled: false },
    logger: logger as never,
  });
  const line = lines.find((l) => l.startsWith('Agent run '));
  return Number(/maxIterations=(\d+)/.exec(line ?? '')?.[1]);
}

describe('iteration ceiling by tier (#237)', () => {
  it('a strong model with no ceiling from the caller gets 150', async () => {
    expect(await ceiling('claude-haiku-4-5', {})).toBe(150);
  });

  it('a medium or weak model with no ceiling gets 50, as before', async () => {
    expect(await ceiling('gemma4:e4b', {})).toBe(50);
    expect(await ceiling('llama3.2', {})).toBe(50);
  });

  it("the caller's value always wins: the user's setting or a skill's", async () => {
    expect(await ceiling('claude-haiku-4-5', { maxIterations: 50 })).toBe(50);
    expect(await ceiling('claude-haiku-4-5', { maxIterations: 7 })).toBe(7);
    expect(await ceiling('gemma4:e4b', { maxIterations: 120 })).toBe(120);
  });

  it('with adaptive scaffolding off, every model keeps the historical 50', async () => {
    expect(await ceiling('claude-haiku-4-5', {}, false)).toBe(50);
  });
});
