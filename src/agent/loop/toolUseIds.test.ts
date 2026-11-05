import { describe, it, expect, vi } from 'vitest';
import { claimToolUseId, toolUseIdsIn } from './toolUseIds.js';
import { runAgentLoop, type AgentCallbacks } from '../loop.js';
import { getConfig } from '../../config/settings.js';
import type { ChatMessage, ContentBlock, StreamEvent, ToolUseContentBlock } from '../../ollama/types.js';
import type { SideCarClient } from '../../ollama/client.js';

vi.mock('../tools.js', () => ({
  getToolDefinitions: () => [],
  getToolDefinitionsForTier: () => [],
  getDiagnostics: async () => 'No diagnostics',
}));

// #417: backends and parsers number calls per request -- native Ollama's first
// call is `ollama_tc_0` on every turn -- while state.toolOutcomes (ADR-008) is
// keyed by id for the whole run, so a later call read an earlier call's outcome.

const use = (id: string): ToolUseContentBlock => ({ type: 'tool_use', id, name: 'probe', input: {} });

describe('claimToolUseId', () => {
  it('keeps an unused id and records it', () => {
    const ids = new Set<string>();
    const tu = use('ollama_tc_0');
    claimToolUseId(ids, tu);
    expect(tu.id).toBe('ollama_tc_0');
    expect([...ids]).toEqual(['ollama_tc_0']);
  });

  it('renames a repeated id with a suffix a provider accepts', () => {
    const ids = new Set<string>();
    const got = ['ollama_tc_0', 'ollama_tc_0', 'ollama_tc_0'].map((id) => {
      const tu = use(id);
      claimToolUseId(ids, tu);
      return tu.id;
    });
    expect(got).toEqual(['ollama_tc_0', 'ollama_tc_0-2', 'ollama_tc_0-3']);
    for (const id of got) expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });

  it('counts ids already in the conversation', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [use('text_tc_0') as ContentBlock] },
    ];
    const ids = toolUseIdsIn(history);
    const tu = use('text_tc_0');
    claimToolUseId(ids, tu);
    expect(tu.id).toBe('text_tc_0-2');
  });
});

describe('a run whose backend repeats ids every turn', () => {
  it('gives every call its own id, and pairs each result with it', async () => {
    let turn = 0;
    let lastSent: ChatMessage[] = [];
    const client = {
      async *streamChat(_model: string, _sys: string, messages: ChatMessage[]): AsyncGenerator<StreamEvent> {
        lastSent = messages;
        turn++;
        if (turn <= 2) {
          yield { type: 'tool_use', toolUse: use('ollama_tc_0') };
          yield { type: 'stop', stopReason: 'tool_use' };
        } else {
          yield { type: 'text', text: 'done' };
          yield { type: 'stop', stopReason: 'end_turn' };
        }
      },
      getSystemPrompt: () => '',
      getRouter: () => null,
      getModel: () => 'mock-model',
    } as unknown as SideCarClient;
    const probe = {
      definition: { name: 'probe', description: 'probe', input_schema: { type: 'object', properties: {} } },
      requiresApproval: false,
      executor: async () => 'ok',
    };
    const calls: string[] = [];
    const results: string[] = [];
    const callbacks: AgentCallbacks = {
      onText: () => {},
      onToolCall: (_n, _i, id) => calls.push(id),
      onToolResult: (_n, _r, _e, id) => results.push(id),
      onDone: () => {},
    };
    // An earlier run in the same chat already used ollama_tc_0.
    const history: ChatMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: [use('ollama_tc_0') as ContentBlock] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ollama_tc_0', content: 'ok' }] },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'probe twice' },
    ];
    await runAgentLoop(client, history, callbacks, new AbortController().signal, {
      extraTools: [probe] as never,
      approvalMode: 'autonomous',
      maxIterations: 4,
      config: { ...getConfig(), completionGateEnabled: false },
    });

    expect(calls).toEqual(['ollama_tc_0-2', 'ollama_tc_0-3']);
    expect(results).toEqual(calls);
    // What the backend was sent pairs every result with its own call.
    const sentUses = lastSent.flatMap((m) =>
      typeof m.content === 'string' ? [] : m.content.filter((b) => b.type === 'tool_use').map((b) => b.id),
    );
    const sentResults = lastSent.flatMap((m) =>
      typeof m.content === 'string' ? [] : m.content.filter((b) => b.type === 'tool_result').map((b) => b.tool_use_id),
    );
    expect(new Set(sentUses).size).toBe(sentUses.length);
    expect(sentResults).toEqual(sentUses);
  });
});
