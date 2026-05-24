import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CopilotBackend } from './copilotBackend.js';
import * as vscode from 'vscode';
import type { ChatMessage, ToolDefinition } from './types.js';

// Helper to build a fake async iterable stream
function fakeStream(parts: unknown[]): AsyncIterable<unknown> {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i >= parts.length) return { value: undefined, done: true };
          return { value: parts[i++], done: false };
        },
      };
    },
  };
}

function makeModel(
  overrides: Partial<{
    id: string;
    name: string;
    maxInputTokens: number;
    sendRequest: (...args: unknown[]) => unknown;
  }> = {},
) {
  return {
    id: 'copilot-gpt-4o',
    name: 'GPT-4o',
    maxInputTokens: 128_000,
    sendRequest: vi.fn().mockResolvedValue({ stream: fakeStream([]) }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(vscode.lm.selectChatModels).mockReset();
});

describe('CopilotBackend.streamChat', () => {
  it('yields text events from LanguageModelTextPart chunks', async () => {
    const model = makeModel({
      sendRequest: vi.fn().mockResolvedValue({
        stream: fakeStream([new vscode.LanguageModelTextPart('Hello'), new vscode.LanguageModelTextPart(', world!')]),
      }),
    });
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([model] as never);

    const backend = new CopilotBackend();
    const events = [];
    for await (const e of backend.streamChat('copilot-gpt-4o', 'sys', [{ role: 'user', content: 'Hi' }])) {
      events.push(e);
    }

    expect(events).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ', world!' },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
  });

  it('yields tool_use events from LanguageModelToolCallPart chunks', async () => {
    const model = makeModel({
      sendRequest: vi.fn().mockResolvedValue({
        stream: fakeStream([new vscode.LanguageModelToolCallPart('call-1', 'read_file', { path: 'src/foo.ts' })]),
      }),
    });
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([model] as never);

    const backend = new CopilotBackend();
    const events = [];
    for await (const e of backend.streamChat('copilot-gpt-4o', '', [{ role: 'user', content: 'go' }])) {
      events.push(e);
    }

    expect(events[0]).toEqual({
      type: 'tool_use',
      toolUse: { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: 'src/foo.ts' } },
    });
  });

  it('passes tools to sendRequest when provided', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ stream: fakeStream([]) });
    const model = makeModel({ sendRequest });
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([model] as never);

    const tools: ToolDefinition[] = [
      {
        name: 'read_file',
        description: 'Read a file',
        input_schema: { type: 'object', properties: { path: { type: 'string' } } },
      },
    ];

    const backend = new CopilotBackend();
    for await (const _ of backend.streamChat(
      'copilot-gpt-4o',
      '',
      [{ role: 'user', content: 'hi' }],
      undefined,
      tools,
    )) {
      /* drain */
    }

    const opts = (sendRequest.mock.calls[0] as unknown[])[1] as { tools?: unknown[] };
    expect(opts.tools).toHaveLength(1);
    expect((opts.tools![0] as { name: string }).name).toBe('read_file');
  });

  it('falls back to family selector when id selector returns empty', async () => {
    const model = makeModel({
      id: 'copilot-gpt-4o',
      sendRequest: vi.fn().mockResolvedValue({ stream: fakeStream([]) }),
    });
    vi.mocked(vscode.lm.selectChatModels)
      .mockResolvedValueOnce([]) // id selector → empty
      .mockResolvedValueOnce([model] as never); // family selector → match

    const backend = new CopilotBackend();
    for await (const _ of backend.streamChat('gpt-4o', '', [{ role: 'user', content: 'hi' }])) {
      /* drain */
    }

    expect(vscode.lm.selectChatModels).toHaveBeenCalledTimes(2);
  });

  it('throws when no models are available', async () => {
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([]);

    const backend = new CopilotBackend();
    await expect(async () => {
      for await (const _ of backend.streamChat('gpt-4o', '', [{ role: 'user', content: 'hi' }])) {
        /* drain */
      }
    }).rejects.toThrow('No GitHub Copilot language models available');
  });

  it('converts system prompt into a leading User message', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ stream: fakeStream([]) });
    const model = makeModel({ sendRequest });
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([model] as never);

    const backend = new CopilotBackend();
    for await (const _ of backend.streamChat('x', 'You are helpful.', [{ role: 'user', content: 'hi' }])) {
      /* drain */
    }

    const messages = (sendRequest.mock.calls[0] as unknown[])[0] as vscode.LanguageModelChatMessage[];
    expect(messages[0].content).toContain('[System Instructions]\nYou are helpful.');
  });

  it('converts tool_result ContentBlocks to LanguageModelToolResultPart', async () => {
    const sendRequest = vi.fn().mockResolvedValue({ stream: fakeStream([]) });
    const model = makeModel({ sendRequest });
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([model] as never);

    const messages: ChatMessage[] = [
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-42', content: 'file content here' }],
      },
    ];

    const backend = new CopilotBackend();
    for await (const _ of backend.streamChat('x', '', messages)) {
      /* drain */
    }

    const lmMsgs = (sendRequest.mock.calls[0] as unknown[])[0] as vscode.LanguageModelChatMessage[];
    const userMsg = lmMsgs[0]; // no system prompt, so first is the user
    expect(Array.isArray(userMsg.content)).toBe(true);
    const resultPart = (userMsg.content as unknown[])[0];
    expect(resultPart).toBeInstanceOf(vscode.LanguageModelToolResultPart);
  });
});

describe('CopilotBackend.complete', () => {
  it('collects text parts into a string', async () => {
    const model = makeModel({
      sendRequest: vi.fn().mockResolvedValue({
        stream: fakeStream([new vscode.LanguageModelTextPart('foo'), new vscode.LanguageModelTextPart('bar')]),
      }),
    });
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([model] as never);

    const backend = new CopilotBackend();
    const result = await backend.complete('x', '', [{ role: 'user', content: 'hi' }], 256);
    expect(result).toBe('foobar');
  });
});

describe('CopilotBackend.listAvailableModels', () => {
  it('returns mapped models from selectChatModels', async () => {
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
      { id: 'copilot-gpt-4o', name: 'GPT-4o', maxInputTokens: 128_000 } as never,
      { id: 'copilot-claude-sonnet', name: 'Claude Sonnet', maxInputTokens: 200_000 } as never,
    ]);

    const models = await CopilotBackend.listAvailableModels();
    expect(models).toEqual([
      { id: 'copilot-gpt-4o', name: 'GPT-4o' },
      { id: 'copilot-claude-sonnet', name: 'Claude Sonnet' },
    ]);
  });

  it('returns empty array when selectChatModels throws', async () => {
    vi.mocked(vscode.lm.selectChatModels).mockRejectedValue(new Error('not available'));
    const models = await CopilotBackend.listAvailableModels();
    expect(models).toEqual([]);
  });
});

describe('CopilotBackend.getModelContextLength', () => {
  it('returns maxInputTokens for the matched model', async () => {
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([
      { id: 'copilot-gpt-4o', name: 'GPT-4o', maxInputTokens: 128_000 } as never,
    ]);

    const len = await CopilotBackend.getModelContextLength('copilot-gpt-4o');
    expect(len).toBe(128_000);
  });

  it('returns null when no model found', async () => {
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([]);
    const len = await CopilotBackend.getModelContextLength('unknown');
    expect(len).toBeNull();
  });
});
