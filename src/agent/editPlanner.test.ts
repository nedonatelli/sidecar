import { describe, it, expect, vi } from 'vitest';
import { shouldRunPlannerPass, requestEditPlan, extractPlanJson, NO_PLAN_SENTINEL } from './editPlanner.js';
import type { SideCarClient } from '../ollama/client.js';
import type { ChatMessage, StreamEvent, ToolUseContentBlock } from '../ollama/types.js';

// ---------------------------------------------------------------------------
// Tests for editPlanner.ts (v0.65 chunk 4.2).
//
// Covers:
//   - shouldRunPlannerPass gating: enabled/planningPass/minFilesForPlan/
//     @no-plan sentinel, distinct-path counting (not raw tool_use count)
//   - extractPlanJson tolerance: ```json fenced, bare ```, raw object,
//     unbalanced braces, no-JSON-at-all rejection
//   - requestEditPlan end-to-end with a mocked streamChat:
//     happy path, one-retry on validation failure, two-failure → null
//   - plannerModel override: setTurnOverride / restore
// ---------------------------------------------------------------------------

function toolUse(name: string, input: Record<string, unknown>, id = `tu-${name}`): ToolUseContentBlock {
  return { type: 'tool_use', id, name, input };
}

function mockClient(streamText: string | string[]): SideCarClient {
  const chunks = Array.isArray(streamText) ? streamText : [streamText];
  let callIdx = 0;
  return {
    async *streamChat(): AsyncGenerator<StreamEvent> {
      const chunk = chunks[callIdx++] ?? chunks[chunks.length - 1];
      yield { type: 'text', text: chunk };
      yield { type: 'stop', stopReason: 'end_turn' };
    },
    getTurnOverride: () => null,
    setTurnOverride: vi.fn(),
  } as unknown as SideCarClient;
}

describe('shouldRunPlannerPass', () => {
  const base = { enabled: true, planningPass: true, minFilesForPlan: 3, userPromptText: 'refactor the auth module' };

  it('returns true when distinct write paths >= minFilesForPlan', () => {
    const tus = [
      toolUse('write_file', { path: 'a.ts' }),
      toolUse('write_file', { path: 'b.ts' }),
      toolUse('write_file', { path: 'c.ts' }),
    ];
    expect(shouldRunPlannerPass(tus, base)).toBe(true);
  });

  it('returns false when distinct paths < threshold', () => {
    const tus = [toolUse('write_file', { path: 'a.ts' }), toolUse('write_file', { path: 'b.ts' })];
    expect(shouldRunPlannerPass(tus, base)).toBe(false);
  });

  it('counts distinct paths, not raw tool_use count (two writes to same file = 1)', () => {
    const tus = [
      toolUse('write_file', { path: 'a.ts' }, 'tu1'),
      toolUse('write_file', { path: 'a.ts' }, 'tu2'),
      toolUse('write_file', { path: 'b.ts' }, 'tu3'),
    ];
    expect(shouldRunPlannerPass(tus, base)).toBe(false); // only 2 distinct paths
  });

  it('ignores non-file-write tool_uses when counting', () => {
    const tus = [
      toolUse('write_file', { path: 'a.ts' }),
      toolUse('read_file', { path: 'b.ts' }),
      toolUse('grep', { pattern: 'x' }),
      toolUse('run_command', { command: 'ls' }),
    ];
    expect(shouldRunPlannerPass(tus, base)).toBe(false); // only 1 write
  });

  it('counts edit_file, create_file, delete_file — not just write_file', () => {
    const tus = [
      toolUse('write_file', { path: 'a.ts' }),
      toolUse('edit_file', { path: 'b.ts' }),
      toolUse('delete_file', { path: 'c.ts' }),
    ];
    expect(shouldRunPlannerPass(tus, base)).toBe(true);
  });

  it('accepts both path and file_path input keys', () => {
    const tus = [
      toolUse('write_file', { path: 'a.ts' }),
      toolUse('edit_file', { file_path: 'b.ts' }),
      toolUse('write_file', { path: 'c.ts' }),
    ];
    expect(shouldRunPlannerPass(tus, base)).toBe(true);
  });

  it('returns false when enabled=false', () => {
    const tus = [
      toolUse('write_file', { path: 'a.ts' }),
      toolUse('write_file', { path: 'b.ts' }),
      toolUse('write_file', { path: 'c.ts' }),
    ];
    expect(shouldRunPlannerPass(tus, { ...base, enabled: false })).toBe(false);
  });

  it('returns false when planningPass=false (feature on but plan turn disabled)', () => {
    const tus = [
      toolUse('write_file', { path: 'a.ts' }),
      toolUse('write_file', { path: 'b.ts' }),
      toolUse('write_file', { path: 'c.ts' }),
    ];
    expect(shouldRunPlannerPass(tus, { ...base, planningPass: false })).toBe(false);
  });

  it('returns false when user prompt contains @no-plan', () => {
    const tus = [
      toolUse('write_file', { path: 'a.ts' }),
      toolUse('write_file', { path: 'b.ts' }),
      toolUse('write_file', { path: 'c.ts' }),
    ];
    expect(shouldRunPlannerPass(tus, { ...base, userPromptText: `${NO_PLAN_SENTINEL} just do it` })).toBe(false);
  });

  it('ignores writes with no path / file_path (malformed tool_use)', () => {
    const tus = [
      toolUse('write_file', { path: 'a.ts' }),
      toolUse('write_file', {}),
      toolUse('write_file', { content: 'no path here' }),
    ];
    expect(shouldRunPlannerPass(tus, base)).toBe(false); // only 1 valid path
  });
});

describe('extractPlanJson', () => {
  it('extracts a ```json fenced block', () => {
    const text = 'Here is the plan:\n```json\n{"edits":[]}\n```\nHope that helps.';
    expect(extractPlanJson(text)).toBe('{"edits":[]}');
  });

  it('extracts a bare ``` fenced block when json label is absent', () => {
    const text = '```\n{"edits":[]}\n```';
    expect(extractPlanJson(text)).toBe('{"edits":[]}');
  });

  it('extracts a raw top-level JSON object', () => {
    const text = '{"edits":[{"path":"a.ts","op":"edit","dependsOn":[]}]}';
    expect(extractPlanJson(text)).toBe(text);
  });

  it('handles JSON with internal braces (nested objects, dependsOn arrays)', () => {
    const text = '{"edits":[{"path":"a.ts","op":"edit","dependsOn":[],"meta":{"x":1}}]}';
    expect(extractPlanJson(text)).toBe(text);
  });

  it('tolerates strings containing braces', () => {
    const text = '{"edits":[{"path":"a.ts","op":"edit","rationale":"fix { bug","dependsOn":[]}]}';
    expect(extractPlanJson(text)).toBe(text);
  });

  it('prefers the fenced block even when raw JSON appears first', () => {
    const text = 'Example: {"wrong": true}\n```json\n{"edits":[]}\n```';
    expect(extractPlanJson(text)).toBe('{"edits":[]}');
  });

  it('throws when the response contains no JSON object at all', () => {
    expect(() => extractPlanJson('no json here, just prose')).toThrow(/no JSON object/i);
  });

  it('throws when braces are unbalanced', () => {
    expect(() => extractPlanJson('{"edits":[{"path":"a.ts"')).toThrow(/unbalanced/i);
  });
});

describe('requestEditPlan — end-to-end', () => {
  const messages: ChatMessage[] = [{ role: 'user', content: 'refactor auth' }];
  const pending = [
    toolUse('write_file', { path: 'a.ts' }),
    toolUse('write_file', { path: 'b.ts' }),
    toolUse('write_file', { path: 'c.ts' }),
  ];

  it('returns a parsed EditPlan on a valid first-try response', async () => {
    const json = JSON.stringify({
      edits: [
        { path: 'a.ts', op: 'edit', rationale: 'a', dependsOn: [] },
        { path: 'b.ts', op: 'edit', rationale: 'b', dependsOn: ['a.ts'] },
        { path: 'c.ts', op: 'edit', rationale: 'c', dependsOn: [] },
      ],
    });
    const client = mockClient(`Planning now:\n\`\`\`json\n${json}\n\`\`\``);
    const result = await requestEditPlan(client, messages, pending);
    expect(result.plan).not.toBeNull();
    expect(result.plan!.edits).toHaveLength(3);
    expect(result.retried).toBe(false);
  });

  it('retries once when the first response fails validation, succeeds on retry', async () => {
    const invalid = JSON.stringify({
      edits: [
        { path: 'a.ts', op: 'edit', rationale: 'a', dependsOn: ['b.ts'] },
        { path: 'b.ts', op: 'edit', rationale: 'b', dependsOn: ['a.ts'] },
      ],
    });
    const valid = JSON.stringify({
      edits: [
        { path: 'a.ts', op: 'edit', rationale: 'a', dependsOn: [] },
        { path: 'b.ts', op: 'edit', rationale: 'b', dependsOn: ['a.ts'] },
      ],
    });
    const client = mockClient([
      `\`\`\`json\n${invalid}\n\`\`\``, // first — cycle
      `\`\`\`json\n${valid}\n\`\`\``, // retry — valid
    ]);
    const result = await requestEditPlan(client, messages, pending);
    expect(result.retried).toBe(true);
    expect(result.plan).not.toBeNull();
    expect(result.plan!.edits).toHaveLength(2);
  });

  it('returns plan=null when both initial and retry fail validation', async () => {
    const cyclePlan = JSON.stringify({
      edits: [
        { path: 'a.ts', op: 'edit', rationale: 'a', dependsOn: ['b.ts'] },
        { path: 'b.ts', op: 'edit', rationale: 'b', dependsOn: ['a.ts'] },
      ],
    });
    const log = vi.fn();
    const client = mockClient([`\`\`\`json\n${cyclePlan}\n\`\`\``, `\`\`\`json\n${cyclePlan}\n\`\`\``]);
    const result = await requestEditPlan(client, messages, pending, { log });
    expect(result.plan).toBeNull();
    expect(result.retried).toBe(true);
    // Log captured both failures.
    expect(log).toHaveBeenCalled();
  });

  it('pins plannerModel via setTurnOverride and restores on exit', async () => {
    const setTurnOverride = vi.fn();
    const client = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        yield { type: 'text', text: '```json\n{"edits":[{"path":"a.ts","op":"edit","dependsOn":[]}]}\n```' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
      getTurnOverride: () => null,
      setTurnOverride,
    } as unknown as SideCarClient;

    await requestEditPlan(client, messages, pending, { plannerModel: 'claude-haiku-4-5' });
    expect(setTurnOverride).toHaveBeenCalledWith('claude-haiku-4-5');
    // Last call restores (null — the pre-override value).
    expect(setTurnOverride.mock.calls[setTurnOverride.mock.calls.length - 1][0]).toBeNull();
  });

  it('does not call setTurnOverride when plannerModel is empty', async () => {
    const setTurnOverride = vi.fn();
    const client = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        yield { type: 'text', text: '```json\n{"edits":[{"path":"a.ts","op":"edit","dependsOn":[]}]}\n```' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
      getTurnOverride: () => null,
      setTurnOverride,
    } as unknown as SideCarClient;

    await requestEditPlan(client, messages, pending, { plannerModel: '' });
    expect(setTurnOverride).not.toHaveBeenCalled();
  });

  it('restores the prior turnOverride even when the planner throws non-validation errors', async () => {
    const setTurnOverride = vi.fn();
    const client = {
      async *streamChat(): AsyncGenerator<StreamEvent> {
        throw new Error('network blew up');
      },
      getTurnOverride: () => 'prev-model',
      setTurnOverride,
    } as unknown as SideCarClient;

    await expect(requestEditPlan(client, messages, pending, { plannerModel: 'haiku' })).rejects.toThrow(
      'network blew up',
    );
    // Restore called with the captured prior value.
    expect(setTurnOverride.mock.calls[setTurnOverride.mock.calls.length - 1][0]).toBe('prev-model');
  });
});
