import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CopilotBackend, resolveCopilotModel, _resetCopilotSubstitutionWarnings } from './copilotBackend.js';
import { logger } from '../system/logger.js';
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

  it("asks for Copilot's models only (#230)", async () => {
    vi.mocked(vscode.lm.selectChatModels).mockResolvedValue([]);
    await CopilotBackend.listAvailableModels();
    expect(vscode.lm.selectChatModels).toHaveBeenCalledWith({ vendor: 'copilot' });
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

  it('after a fallback, reports the context of the model the chat path uses (#230)', async () => {
    // Only Copilot's fallback answers: the configured id and family match nothing.
    vi.mocked(vscode.lm.selectChatModels).mockImplementation((async (sel?: { vendor?: string }) =>
      sel?.vendor === 'copilot'
        ? [{ id: 'gpt-6-luna', name: 'GPT-6 Luna', vendor: 'copilot', maxInputTokens: 272_000 }]
        : []) as never);
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // The old lookup stopped after id and family and returned null here.
    expect(await CopilotBackend.getModelContextLength('gpt-4o')).toBe(272_000);
    expect((await resolveCopilotModel('gpt-4o'))?.id).toBe('gpt-6-luna');
    _resetCopilotSubstitutionWarnings();
    vi.mocked(logger.warn).mockRestore();
  });
});

describe('resolveCopilotModel (#230)', () => {
  type Sel = Parameters<typeof vscode.lm.selectChatModels>[0];
  const model = (id: string, vendor = 'copilot') =>
    ({
      id,
      name: id.toUpperCase(),
      vendor,
      family: id,
      maxInputTokens: 128_000,
    }) as unknown as vscode.LanguageModelChat;
  /** A fake LM registry: Copilot's models plus another extension's, in that order of registration. */
  const registry = [model('other-ext-model', 'someone-else'), model('gpt-6-luna'), model('claude-sonnet-5-5')];
  const select = vi.fn(async (sel?: Sel) =>
    registry.filter(
      (m) =>
        (!sel?.id || m.id === sel.id) &&
        (!sel?.family || m.family === sel.family) &&
        (!sel?.vendor || m.vendor === sel.vendor),
    ),
  ) as unknown as typeof vscode.lm.selectChatModels;

  beforeEach(() => {
    _resetCopilotSubstitutionWarnings();
    vi.mocked(select).mockClear();
  });

  it('uses the configured id when Copilot offers it, with no warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect((await resolveCopilotModel('claude-sonnet-5-5', select))?.id).toBe('claude-sonnet-5-5');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("falls back to Copilot's own model, never another vendor's, and says so once", async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const chosen = await resolveCopilotModel('gpt-4o', select); // retired from Copilot
    expect(chosen?.vendor).toBe('copilot');
    expect(chosen?.id).toBe('gpt-6-luna');
    expect(vi.mocked(select).mock.calls.at(-1)?.[0]).toEqual({ vendor: 'copilot' });
    await resolveCopilotModel('gpt-4o', select);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('gpt-4o');
    warn.mockRestore();
  });

  it('shows the substitution once in a notification that opens the model picker', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const notify = vi.mocked(vscode.window.showWarningMessage);
    notify.mockClear();
    notify.mockResolvedValueOnce('Select Model' as never);
    vi.mocked(vscode.commands.executeCommand).mockClear();
    await resolveCopilotModel('gpt-4o', select);
    await resolveCopilotModel('gpt-4o', select);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String(notify.mock.calls[0][0])).toContain('GPT-6-LUNA');
    await vi.waitFor(() => expect(vscode.commands.executeCommand).toHaveBeenCalledWith('sidecar.selectModel'));
    vi.mocked(logger.warn).mockRestore();
  });

  it('a stored display name resolves to that model, with no warning (settings written before the fix)', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const notify = vi.mocked(vscode.window.showWarningMessage);
    notify.mockClear();
    // The fake names a model by its upper-cased id, as Copilot's "Claude Sonnet 4.6" names claude-sonnet-4.6.
    expect((await resolveCopilotModel('CLAUDE-SONNET-5-5', select))?.id).toBe('claude-sonnet-5-5');
    expect(warn).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("matches a display name only among Copilot's models", async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    // OTHER-EXT-MODEL is another vendor's display name: Copilot's first model is used instead.
    expect((await resolveCopilotModel('OTHER-EXT-MODEL', select))?.id).toBe('gpt-6-luna');
    vi.mocked(logger.warn).mockRestore();
  });

  it('shows no notification when the configured model is offered', async () => {
    const notify = vi.mocked(vscode.window.showWarningMessage);
    notify.mockClear();
    await resolveCopilotModel('claude-sonnet-5-5', select);
    expect(notify).not.toHaveBeenCalled();
  });

  it('returns null when Copilot offers no models at all', async () => {
    const none = vi.fn(async () => []) as unknown as typeof vscode.lm.selectChatModels;
    expect(await resolveCopilotModel('gpt-4o', none)).toBeNull();
  });
});
