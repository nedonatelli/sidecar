import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// Mock the safetensors import module so tests never try to spawn a real
// `ollama create` or fetch gigabytes of weights. Individual tests configure
// what `importSafetensorsModel` yields.
const mockImport = vi.fn();
vi.mock('../../ollama/hfSafetensorsImport.js', () => ({
  importSafetensorsModel: (opts: unknown) => mockImport(opts),
}));

// Mock the HF token helper so the default is "no token set".
const mockGetHFToken = vi.fn(async () => undefined);
vi.mock('../../config/settings.js', async () => {
  const actual = await vi.importActual<typeof import('../../config/settings.js')>('../../config/settings.js');
  return {
    ...actual,
    getHuggingFaceToken: () => mockGetHFToken(),
  };
});

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
    // Staging dir for safetensors imports — real OS temp path so
    // fs.mkdirSync works without polluting the repo.
    context: {
      globalStorageUri: { fsPath: path.join(os.tmpdir(), `sidecar-test-${Date.now()}`) },
    },
    ...overrides,
  };
}

describe('loadModels', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true });
  });

  it('posts model list to webview', async () => {
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

  it('requests installed-only list (no suggestions) for the chat dropdown', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const state = mockState();
    await loadModels(state as never);

    expect(state.client.listLibraryModels).toHaveBeenCalledWith({ includeSuggestions: false });
  });

  it('warns in chat when the persisted model is not in the installed list', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    // Installed list has only `llama3:latest` — default config.model is
    // `qwen3-coder:30b`, which is not installed, so we expect a warning.
    const state = mockState();
    await loadModels(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'assistantMessage',
        content: expect.stringContaining('not installed'),
      }),
    );
  });

  it('warns with empty-list guidance when Ollama has no models at all', async () => {
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    const state = mockState({
      client: {
        isLocalOllama: vi.fn().mockReturnValue(true),
        listLibraryModels: vi.fn().mockResolvedValue([]),
        updateModel: vi.fn(),
        getProviderType: vi.fn().mockReturnValue('ollama'),
        pullModel: vi.fn(),
      },
    });
    await loadModels(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'assistantMessage',
        content: expect.stringContaining('No models are installed'),
      }),
    );
  });
});

describe('handleInstallModel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    mockImport.mockReset();
    mockGetHFToken.mockReset();
    mockGetHFToken.mockResolvedValue(undefined);
  });

  /** Queue one response for the HF /api/models/... lookup. */
  function mockHFInfo(siblings: Array<{ rfilename: string; size?: number }>, gated: boolean | string = false) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ siblings, gated }),
    });
  }

  /** Queue one response for the HF raw config.json lookup. */
  function mockHFConfigJson(architecture: string) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => ({ architectures: [architecture] }),
    });
  }

  /** Queue one response for the HF tree endpoint (used for LFS sizes). */
  function mockHFTree(entries: Array<{ path: string; size: number }>) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => entries.map((e) => ({ type: 'file', path: e.path, lfs: { size: e.size } })),
    });
  }

  it('streams pull progress and posts installComplete', async () => {
    async function* mockPull() {
      yield { status: 'pulling manifest' };
      yield { status: 'downloading', total: 1000, completed: 500 };
      yield { status: 'success' };
    }

    const state = mockState();
    state.client.pullModel = vi.fn().mockReturnValue(mockPull());
    state.client.isLocalOllama = vi.fn().mockReturnValue(false); // skip tool probe

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
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

    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'installComplete' }));
    expect(state.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ command: 'error' }));
  });

  it('detects HuggingFace URLs and shows quick pick when GGUFs are present', async () => {
    const state = mockState();
    vi.spyOn(window, 'showQuickPick').mockResolvedValue(undefined as never);

    mockHFInfo([{ rfilename: 'model-Q4_K_M.gguf', size: 4_000_000_000 }]);

    await handleInstallModel(state as never, 'https://huggingface.co/TheBloke/Llama-2-7B-GGUF');

    expect(window.showQuickPick).toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('HuggingFace') }),
    );
  });

  it('reports repo-not-found without attempting to pull', async () => {
    const state = mockState();
    state.client.pullModel = vi.fn();

    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    });

    await handleInstallModel(state as never, 'https://huggingface.co/google/gemma-4-26B-A4B');

    expect(state.client.pullModel).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('was not found') }),
    );
  });

  it('reports network errors without attempting to pull', async () => {
    const state = mockState();
    state.client.pullModel = vi.fn();

    mockFetch.mockRejectedValueOnce(new Error('Connect Timeout'));

    await handleInstallModel(state as never, 'https://huggingface.co/someone/some-repo');

    expect(state.client.pullModel).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("Couldn't reach") }),
    );
  });

  it('reports unsupported architecture without attempting to pull', async () => {
    const state = mockState();
    state.client.pullModel = vi.fn();

    mockHFInfo([
      { rfilename: 'model.safetensors', size: 14_000_000_000 },
      { rfilename: 'config.json', size: 1_000 },
    ]);
    mockHFTree([
      { path: 'model.safetensors', size: 14_000_000_000 },
      { path: 'config.json', size: 1_000 },
    ]);
    mockHFConfigJson('MambaForCausalLM');

    await handleInstallModel(state as never, 'https://huggingface.co/state-spaces/mamba-2.8b');

    expect(state.client.pullModel).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('MambaForCausalLM') }),
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('bartowski/') }),
    );
  });

  it('reports no-weights when repo has neither GGUF nor safetensors', async () => {
    const state = mockState();
    state.client.pullModel = vi.fn();

    mockHFInfo([
      { rfilename: 'README.md', size: 2_000 },
      { rfilename: 'pytorch_model.bin', size: 14_000_000_000 },
    ]);

    await handleInstallModel(state as never, 'https://huggingface.co/legacy/pytorch-only');

    expect(state.client.pullModel).not.toHaveBeenCalled();
    expect(mockImport).not.toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('no weight files') }),
    );
  });

  it('invokes safetensors import when repo has a supported architecture', async () => {
    const state = mockState();
    state.client.pullModel = vi.fn();
    state.client.isLocalOllama = vi.fn().mockReturnValue(false); // skip tool probe
    state.client.listLibraryModels = vi.fn().mockResolvedValue([]);

    mockHFInfo([
      { rfilename: 'model-00001-of-00002.safetensors', size: 10_000_000_000 },
      { rfilename: 'model-00002-of-00002.safetensors', size: 10_000_000_000 },
      { rfilename: 'config.json', size: 1_000 },
      { rfilename: 'tokenizer.json', size: 500_000 },
    ]);
    mockHFTree([
      { path: 'model-00001-of-00002.safetensors', size: 10_000_000_000 },
      { path: 'model-00002-of-00002.safetensors', size: 10_000_000_000 },
      { path: 'config.json', size: 1_000 },
      { path: 'tokenizer.json', size: 500_000 },
    ]);
    mockHFConfigJson('LlamaForCausalLM');

    // User picks q4_K_M in the quantization picker.
    vi.spyOn(window, 'showQuickPick').mockResolvedValue({ label: 'q4_K_M', quant: 'q4_K_M' } as never);

    // Mock the import generator to yield a couple of events and finish.
    mockImport.mockImplementation(async function* () {
      yield {
        phase: 'download',
        file: 'model-00001-of-00002.safetensors',
        completedBytes: 10_000_000_000,
        totalBytes: 10_000_000_000,
        overallCompleted: 10_000_000_000,
        overallTotal: 20_000_501_000,
      };
      yield { phase: 'convert', line: 'converting tensors...' };
      yield { phase: 'done' };
    });

    await handleInstallModel(state as never, 'https://huggingface.co/meta-llama/Llama-3-8B');

    expect(mockImport).toHaveBeenCalledWith(
      expect.objectContaining({
        quantization: 'q4_K_M',
        ollamaName: 'hf.co/meta-llama/Llama-3-8B',
      }),
    );
    expect(state.client.pullModel).not.toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'installComplete', modelName: 'hf.co/meta-llama/Llama-3-8B' }),
    );
  });

  it('falls through to ollama pull when a bare org/repo input is not on HF', async () => {
    // User types `hhao/qwen2.5-coder` — a legit Ollama community model
    // that isn't on HuggingFace. We should try HF first, get a 404,
    // then fall through to `ollama pull hhao/qwen2.5-coder`.
    async function* mockPull() {
      yield { status: 'pulling manifest' };
      yield { status: 'success' };
    }

    const state = mockState();
    state.client.pullModel = vi.fn().mockReturnValue(mockPull());
    state.client.isLocalOllama = vi.fn().mockReturnValue(false);
    state.client.listLibraryModels = vi.fn().mockResolvedValue([]);

    // HF API says 404
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' });

    await handleInstallModel(state as never, 'hhao/qwen2.5-coder');

    expect(state.client.pullModel).toHaveBeenCalledWith('hhao/qwen2.5-coder', expect.anything());
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('trying Ollama registry') }),
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'installComplete', modelName: 'hhao/qwen2.5-coder' }),
    );
  });

  it('reports not-found as an error for explicit hf.co references', async () => {
    // Explicit `hf.co/...` → we trust the user meant HuggingFace, so
    // a 404 is a hard error rather than a fall-through.
    const state = mockState();
    state.client.pullModel = vi.fn();

    mockFetch.mockResolvedValueOnce({ ok: false, status: 404, statusText: 'Not Found' });

    await handleInstallModel(state as never, 'hf.co/nobody/nonexistent-model');

    expect(state.client.pullModel).not.toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('was not found') }),
    );
  });

  it('warns about known-problematic HF GGUF repos before pulling', async () => {
    const state = mockState();
    state.client.pullModel = vi.fn();

    mockHFInfo([{ rfilename: 'Qwen3.5-27B.Q4_K_M.gguf', size: 15_000_000_000 }]);

    vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Cancel' as never);

    await handleInstallModel(
      state as never,
      'https://huggingface.co/Jackrong/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-GGUF',
    );

    expect(window.showWarningMessage).toHaveBeenCalledWith(
      expect.stringContaining('may not load'),
      expect.anything(),
      'Pull Anyway',
      'Cancel',
    );
    expect(state.client.pullModel).not.toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('ollama pull qwen3.5') }),
    );
  });

  it('proceeds with pull when user clicks Pull Anyway on known-problematic GGUF', async () => {
    async function* mockPull() {
      yield { status: 'pulling manifest' };
      yield { status: 'success' };
    }

    const state = mockState();
    state.client.pullModel = vi.fn().mockReturnValue(mockPull());
    state.client.isLocalOllama = vi.fn().mockReturnValue(false);
    state.client.listLibraryModels = vi.fn().mockResolvedValue([]);

    mockHFInfo([{ rfilename: 'Qwen3.5-27B.Q4_K_M.gguf', size: 15_000_000_000 }]);

    vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Pull Anyway' as never);
    vi.spyOn(window, 'showQuickPick').mockResolvedValue({
      label: 'Qwen3.5-27B.Q4_K_M.gguf',
      description: '15.0 GB',
      detail: 'hf.co/Jackrong/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-GGUF:Qwen3.5-27B.Q4_K_M.gguf',
    } as never);

    await handleInstallModel(
      state as never,
      'https://huggingface.co/Jackrong/Qwen3.5-27B-Claude-4.6-Opus-Reasoning-Distilled-GGUF',
    );

    expect(state.client.pullModel).toHaveBeenCalled();
  });

  it('surfaces load failure after successful pull via warmup verification', async () => {
    async function* mockPull() {
      yield { status: 'pulling manifest' };
      yield { status: 'success' };
    }

    const state = mockState();
    state.client.pullModel = vi.fn().mockReturnValue(mockPull());
    state.client.isLocalOllama = vi.fn().mockReturnValue(true);

    // The pull succeeds, but the warmup verification returns 500
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'unable to load model: /path/to/blob' }),
    });

    await handleInstallModel(state as never, 'some-broken-model');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'assistantMessage',
        content: expect.stringContaining('unable to load model'),
      }),
    );
    expect(state.client.updateModel).not.toHaveBeenCalled();
  });

  it('cancels cleanly when user dismisses the quantization picker', async () => {
    const state = mockState();
    state.client.pullModel = vi.fn();

    mockHFInfo([
      { rfilename: 'model.safetensors', size: 14_000_000_000 },
      { rfilename: 'config.json', size: 1_000 },
    ]);
    mockHFTree([
      { path: 'model.safetensors', size: 14_000_000_000 },
      { path: 'config.json', size: 1_000 },
    ]);
    mockHFConfigJson('LlamaForCausalLM');

    vi.spyOn(window, 'showQuickPick').mockResolvedValue(undefined as never);

    await handleInstallModel(state as never, 'https://huggingface.co/meta-llama/Llama-3-8B');

    expect(mockImport).not.toHaveBeenCalled();
    expect(state.client.pullModel).not.toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('cancelled') }),
    );
  });
});
