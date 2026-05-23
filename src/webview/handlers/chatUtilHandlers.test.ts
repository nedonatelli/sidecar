import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, workspace } from 'vscode';
import {
  handleShowSystemPrompt,
  handleDeleteMessage,
  handleExportChat,
  handleUserMessageWithImages,
} from './chatUtilHandlers.js';

// ---------------------------------------------------------------------------
// handleShowSystemPrompt
// ---------------------------------------------------------------------------

describe('handleShowSystemPrompt', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('posts a verboseLog containing the extension version', async () => {
    const state = {
      context: { extension: { packageJSON: { version: '1.2.3' } } },
      postMessage: vi.fn(),
      loadSidecarMd: async () => null,
    };
    await handleShowSystemPrompt(state as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'verboseLog', verboseLabel: 'System Prompt' }),
    );
    const content = (state.postMessage.mock.calls[0][0] as { content: string }).content;
    expect(content).toContain('SideCar v1.2.3');
  });

  it('includes SIDECAR.md content when loadSidecarMd returns a string', async () => {
    const state = {
      context: { extension: { packageJSON: { version: '2.0.0' } } },
      postMessage: vi.fn(),
      loadSidecarMd: async () => '## Rules\nAlways use TypeScript.',
      sidecarMdSource: 'SIDECAR.md',
    };
    await handleShowSystemPrompt(state as never);
    const content = (state.postMessage.mock.calls[0][0] as { content: string }).content;
    expect(content).toContain('Project instructions (from SIDECAR.md)');
    expect(content).toContain('Always use TypeScript.');
  });

  it('includes the user system prompt when configured', async () => {
    const settingsMod = await import('../../config/settings.js');
    vi.spyOn(settingsMod, 'getConfig').mockReturnValue({ systemPrompt: 'Always prefer functional style' } as never);

    const state = {
      context: { extension: { packageJSON: {} } },
      postMessage: vi.fn(),
      loadSidecarMd: async () => null,
    };
    await handleShowSystemPrompt(state as never);
    const content = (state.postMessage.mock.calls[0][0] as { content: string }).content;
    expect(content).toContain('Always prefer functional style');
  });

  it('falls back gracefully when context.extension is absent', async () => {
    const state = {
      context: {},
      postMessage: vi.fn(),
      loadSidecarMd: async () => null,
    };
    await expect(handleShowSystemPrompt(state as never)).resolves.toBeUndefined();
    expect(state.postMessage).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleDeleteMessage
// ---------------------------------------------------------------------------

describe('handleDeleteMessage', () => {
  it('removes the message at a valid index and saves history', () => {
    const state = {
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
        { role: 'user', content: 'third' },
      ],
      saveHistory: vi.fn(),
      postMessage: vi.fn(),
    };
    handleDeleteMessage(state as never, 1);
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1].content).toBe('third');
    expect(state.saveHistory).toHaveBeenCalledOnce();
  });

  it('is a no-op for a negative index', () => {
    const state = { messages: [{ role: 'user', content: 'stay' }], saveHistory: vi.fn(), postMessage: vi.fn() };
    handleDeleteMessage(state as never, -1);
    expect(state.messages).toHaveLength(1);
    expect(state.saveHistory).not.toHaveBeenCalled();
  });

  it('is a no-op for an out-of-bounds index', () => {
    const state = { messages: [{ role: 'user', content: 'stay' }], saveHistory: vi.fn(), postMessage: vi.fn() };
    handleDeleteMessage(state as never, 5);
    expect(state.messages).toHaveLength(1);
    expect(state.saveHistory).not.toHaveBeenCalled();
  });

  it('posts an error and leaves the message intact when the agent is running', () => {
    const state = {
      messages: [{ role: 'user', content: 'hello' }],
      saveHistory: vi.fn(),
      postMessage: vi.fn(),
      abortController: new AbortController(),
    };
    handleDeleteMessage(state as never, 0);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('agent is running') }),
    );
    expect(state.messages).toHaveLength(1);
    expect(state.saveHistory).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleExportChat
// ---------------------------------------------------------------------------

describe('handleExportChat', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('does nothing when the message list is empty', async () => {
    const saveSpy = vi.spyOn(window, 'showSaveDialog');
    await handleExportChat({ messages: [], postMessage: vi.fn() } as never);
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('aborts without writing when the save dialog is cancelled', async () => {
    vi.spyOn(window, 'showSaveDialog').mockResolvedValue(undefined as never);
    const writeSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);

    await handleExportChat({ messages: [{ role: 'user', content: 'hi' }], postMessage: vi.fn() } as never);
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes a markdown file and shows an info message on the happy path', async () => {
    const fakeUri = { fsPath: '/tmp/sidecar-chat.md', scheme: 'file', path: '/tmp/sidecar-chat.md' };
    vi.spyOn(window, 'showSaveDialog').mockResolvedValue(fakeUri as never);
    const writeSpy = vi.spyOn(workspace.fs, 'writeFile').mockResolvedValue(undefined as never);
    const infoSpy = vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);

    const state = {
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'hi there' },
      ],
      postMessage: vi.fn(),
    };
    await handleExportChat(state as never);

    expect(writeSpy).toHaveBeenCalledWith(fakeUri, expect.any(Buffer));
    expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('sidecar-chat.md'));
  });

  it('formats exported content with ## headings and --- separators', async () => {
    const fakeUri = { fsPath: '/tmp/out.md', scheme: 'file', path: '/tmp/out.md' };
    vi.spyOn(window, 'showSaveDialog').mockResolvedValue(fakeUri as never);
    let captured: Buffer | undefined;
    vi.spyOn(workspace.fs, 'writeFile').mockImplementation(async (_uri, data) => {
      captured = data as Buffer;
    });
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);

    const state = {
      messages: [
        { role: 'user', content: 'question' },
        { role: 'assistant', content: 'answer' },
      ],
      postMessage: vi.fn(),
    };
    await handleExportChat(state as never);

    const text = captured!.toString('utf-8');
    expect(text).toContain('## User');
    expect(text).toContain('## Assistant');
    expect(text).toContain('---');
    expect(text).toContain('question');
    expect(text).toContain('answer');
  });
});

// ---------------------------------------------------------------------------
// handleUserMessageWithImages
// ---------------------------------------------------------------------------

describe('handleUserMessageWithImages', () => {
  function makeState() {
    return { messages: [] as Array<{ role: string; content: unknown }>, saveHistory: vi.fn() };
  }

  it('pushes a user message with image blocks followed by a text block', () => {
    const state = makeState();
    handleUserMessageWithImages(state as never, 'look at this', [{ mediaType: 'image/png', data: 'aGVsbG8=' }]);
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].role).toBe('user');
    const blocks = state.messages[0].content as Array<{ type: string; text?: string }>;
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe('image');
    expect(blocks[1]).toEqual({ type: 'text', text: 'look at this' });
  });

  it('supports multiple images in a single submission', () => {
    const state = makeState();
    handleUserMessageWithImages(state as never, 'compare', [
      { mediaType: 'image/png', data: 'a' },
      { mediaType: 'image/jpeg', data: 'b' },
      { mediaType: 'image/png', data: 'c' },
    ]);
    const blocks = state.messages[0].content as Array<{ type: string }>;
    expect(blocks).toHaveLength(4); // 3 images + 1 text
    expect(blocks.slice(0, 3).every((b) => b.type === 'image')).toBe(true);
  });

  it('attaches an empty text block when text is empty (preserves Anthropic content shape)', () => {
    const state = makeState();
    handleUserMessageWithImages(state as never, '', [{ mediaType: 'image/png', data: 'x' }]);
    const blocks = state.messages[0].content as Array<{ type: string; text?: string }>;
    expect(blocks[1]).toEqual({ type: 'text', text: '' });
  });

  it('persists history immediately after pushing', () => {
    const state = makeState();
    handleUserMessageWithImages(state as never, 'a', [{ mediaType: 'image/png', data: 'x' }]);
    expect(state.saveHistory).toHaveBeenCalledOnce();
  });

  it('sets the correct base64 data and mediaType on the image block', () => {
    const state = makeState();
    handleUserMessageWithImages(state as never, '', [{ mediaType: 'image/jpeg', data: 'anVzdA==' }]);
    const block = (
      state.messages[0].content as Array<{ type: string; source?: { media_type: string; data: string } }>
    )[0];
    expect(block.source?.media_type).toBe('image/jpeg');
    expect(block.source?.data).toBe('anVzdA==');
  });
});
