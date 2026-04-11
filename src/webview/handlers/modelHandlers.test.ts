import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { loadModels, handleInstallModel } from './modelHandlers.js';
import { window } from 'vscode';

function mockState(overrides: Record<string, unknown> = {}) {
  return {
    client: {
      isLocalOllama: vi.fn().mockReturnValue(true),
      listLibraryModels: vi.fn().mockResolvedValue([
        { name: 'llama3:latest', installed: true },
        { name: 'codellama:7b', installed: false },
      ]),
      updateModel: vi.fn(),
      getProviderType: vi.fn().mockReturnValue('ollama'),
      pullModel: vi.fn(),
    },
    postMessage: vi.fn(),
    installAbortController: null,
    ...overrides,
  };
}

describe('loadModels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    // Mock isProviderReachable to return true
    mockFetch.mockResolvedValue({ ok: true });
  });

  it('posts model list to webview', async () => {
    // Mock probeAllModelToolSupport fetch calls
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const state = mockState();
    await loadModels(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'setModels' }));
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'setCurrentModel' }));
  });

  it('posts error when client throws', async () => {
    const state = mockState({
      client: {
        isLocalOllama: vi.fn().mockReturnValue(true),
        listLibraryModels: vi.fn().mockRejectedValue(new Error('connection refused')),
        getProviderType: vi.fn().mockReturnValue('ollama'),
      },
    });
    // Make reachability check pass
    mockFetch.mockResolvedValue({ ok: true });

    await loadModels(state as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('Cannot connect') }),
    );
  });

  it('posts error when provider is not reachable', async () => {
    mockFetch.mockResolvedValue({ ok: false });

    const state = mockState();
    await loadModels(state as never);
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'error' }));
  });
});

describe('handleInstallModel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
  });

  it('streams pull progress and posts installComplete', async () => {
    async function* mockPull() {
      yield { status: 'pulling manifest' };
      yield { status: 'downloading', total: 1000, completed: 500 };
      yield { status: 'success' };
    }

    const state = mockState();
    state.client.pullModel = vi.fn().mockReturnValue(mockPull());
    state.client.isLocalOllama = vi.fn().mockReturnValue(false); // skip tool probe

    // Mock probeModelToolSupport
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    // Mock loadModels reload at the end (listLibraryModels)
    state.client.listLibraryModels = vi.fn().mockResolvedValue([]);

    await handleInstallModel(state as never, 'llama3:latest');

    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'installProgress' }));
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'installComplete', modelName: 'llama3:latest' }),
    );
    expect(state.client.updateModel).toHaveBeenCalledWith('llama3:latest');
  });

  it('handles pull failure', async () => {
    const state = mockState();
    state.client.pullModel = vi.fn().mockImplementation(async function* () {
      throw new Error('disk full');
    });

    await handleInstallModel(state as never, 'bad-model');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('disk full') }),
    );
  });

  it('handles abort gracefully', async () => {
    const state = mockState();
    const abortError = new Error('Aborted');
    abortError.name = 'AbortError';
    state.client.pullModel = vi.fn().mockImplementation(async function* () {
      throw abortError;
    });

    await handleInstallModel(state as never, 'cancelled-model');

    // Should post installComplete (not error) on abort
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'installComplete' }));
    expect(state.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'error' }));
  });

  it('detects HuggingFace URLs', async () => {
    const state = mockState();
    // Quick pick returns null (user cancels)
    vi.spyOn(window, 'showQuickPick').mockResolvedValue(undefined as never);

    // Mock HuggingFace API to return no GGUF files
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ siblings: [] }),
    });

    await handleInstallModel(state as never, 'https://huggingface.co/TheBloke/Llama-2-7B-GGUF');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('HuggingFace') }),
    );
  });
});
