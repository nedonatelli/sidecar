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

// Stub fs.promises.statfs so the safetensors-import disk-space preflight in
// `runSafetensorsImportFlow` always sees plenty of free space. Without
// this, a CI runner with less than 2× the test-repo-size free in os.tmpdir()
// (e.g. ~40 GB for the 20 GB fixture below) aborts early and
// `importSafetensorsModel` never gets called, producing the misleading
// "expected toHaveBeenCalledWith but received 0 calls" failure. Other fs
// functions pass through unchanged so real mkdirSync / writeFileSync
// continue to work in tests that use the temp staging dir.
const AMPLE_SPACE = {
  type: 0,
  bsize: 4096,
  blocks: BigInt(1_000_000_000),
  bfree: BigInt(500_000_000),
  bavail: BigInt(500_000_000), // ~2 TB free — always passes the 2× preflight
  files: BigInt(0),
  ffree: BigInt(0),
};
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    statfsSync: () => AMPLE_SPACE,
    promises: {
      ...(actual.promises as object),
      statfs: async () => AMPLE_SPACE,
    },
  };
});

// Always pass the memory preflight so tests never abort due to system RAM.
vi.mock('../../system/memoryMonitor.js', () => ({
  checkMemoryPreflight: vi.fn().mockResolvedValue(true),
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

// Kickstand backend mocks — used by handleInstallModel (kickstand path),
// handleKickstandLoadModel, handleKickstandUnloadModel.
const mockKickstandListRegistry = vi.fn();
const mockKickstandLoadModel = vi.fn();
const mockKickstandUnloadModel = vi.fn();
const mockKickstandPull = vi.fn();
const mockDeleteOllamaModel = vi.fn();
const mockProbeModelToolSupport = vi.fn().mockResolvedValue(true);

vi.mock('../../ollama/kickstandBackend.js', () => ({
  kickstandListRegistry: (...args: unknown[]) => mockKickstandListRegistry(...args),
  kickstandLoadModel: (...args: unknown[]) => mockKickstandLoadModel(...args),
  kickstandUnloadModel: (...args: unknown[]) => mockKickstandUnloadModel(...args),
  kickstandPullModel: (...args: unknown[]) => mockKickstandPull(...args),
  normalizeHfRepo: (s: string) => s.replace(/^https?:\/\/huggingface\.co\//i, '').replace(/\/+$/, ''),
}));

vi.mock('../../ollama/ollamaBackend.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../ollama/ollamaBackend.js')>();
  return {
    ...actual,
    probeModelToolSupport: (...args: unknown[]) => mockProbeModelToolSupport(...args),
    probeAllModelToolSupport: vi.fn().mockResolvedValue(undefined),
    deleteOllamaModel: (...args: unknown[]) => mockDeleteOllamaModel(...args),
    modelSupportsTools: vi.fn().mockReturnValue(true),
    getCachedOllamaNumCtx: vi.fn().mockReturnValue(undefined),
  };
});

import {
  loadModels,
  handleInstallModel,
  handleKickstandLoadModel,
  handleKickstandUnloadModel,
  handleDeleteModel,
} from './modelHandlers.js';
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
    mockProbeModelToolSupport.mockResolvedValue(true);
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
      expect.objectContaining({ content: expect.stringContaining('ollama pull gemma4:e4b') }),
    );
  });

  it('proceeds with pull when user clicks Pull Anyway on known-problematic GGUF', async () => {
    async function* mockPull() {
      yield { status: 'pulling manifest' };
      yield { status: 'success' };
    }

    const state = mockState();
    state.client.pullModel = vi.fn().mockReturnValue(mockPull());
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

  it('skips HF inspection for non-Ollama backends and sets the model directly', async () => {
    const state = mockState();
    state.client.isLocalOllama = vi.fn().mockReturnValue(false);
    state.client.listLibraryModels = vi.fn().mockResolvedValue([]);

    mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });

    await handleInstallModel(state as never, 'google/gemma-4-26B-A4B');

    // Should NOT have tried HF inspection or ollama pull
    expect(state.client.pullModel).not.toHaveBeenCalled();
    // Should have set the model directly
    expect(state.client.updateModel).toHaveBeenCalledWith('google/gemma-4-26B-A4B');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'setCurrentModel', currentModel: 'google/gemma-4-26B-A4B' }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleKickstandLoadModel
// ---------------------------------------------------------------------------

describe('handleKickstandLoadModel', () => {
  function mockKickstandState(loadModelImpl?: () => Promise<string | undefined>) {
    const loadModelFn = loadModelImpl
      ? vi.fn().mockImplementation(loadModelImpl)
      : vi.fn().mockResolvedValue('loaded summary');
    return mockState({
      client: {
        isLocalOllama: vi.fn().mockReturnValue(false),
        getProviderType: vi.fn().mockReturnValue('kickstand'),
        listLibraryModels: vi.fn().mockResolvedValue([]),
        updateModel: vi.fn(),
        pullModel: vi.fn(),
        getBackendCapabilities: vi.fn().mockReturnValue({
          lifecycle: { loadModel: loadModelFn },
        }),
      },
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    // status: 200 needed so isProviderReachable('kickstand') passes
    // (it checks response.status < 500, not response.ok)
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
  });

  it('posts summary and updates model on success', async () => {
    const state = mockKickstandState(() => Promise.resolve('loaded summary'));

    await handleKickstandLoadModel(state as never, 'my-model');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('Loading') }),
    );
    expect(state.client.updateModel).toHaveBeenCalledWith('my-model');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'setCurrentModel', currentModel: 'my-model' }),
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('loaded summary') }),
    );
    // loadModels is always called at the end
    expect(state.client.listLibraryModels).toHaveBeenCalled();
  });

  it('uses fallback message when loadModel resolves to undefined', async () => {
    const state = mockKickstandState(() => Promise.resolve(undefined));

    await handleKickstandLoadModel(state as never, 'my-model');

    expect(state.client.updateModel).toHaveBeenCalledWith('my-model');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'assistantMessage',
        content: expect.stringContaining('my-model loaded'),
      }),
    );
  });

  it('posts error when loadModel rejects and still calls loadModels', async () => {
    const state = mockKickstandState(() => Promise.reject(new Error('VRAM full')));

    await handleKickstandLoadModel(state as never, 'my-model');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('VRAM full') }),
    );
    // loadModels is always called even on error
    expect(state.client.listLibraryModels).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleKickstandUnloadModel
// ---------------------------------------------------------------------------

describe('handleKickstandUnloadModel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    // status: 200 needed so isProviderReachable('kickstand') passes
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    mockKickstandUnloadModel.mockReset();
  });

  function kickstandUnloadState() {
    return mockState({
      client: {
        isLocalOllama: vi.fn().mockReturnValue(false),
        getProviderType: vi.fn().mockReturnValue('kickstand'),
        listLibraryModels: vi.fn().mockResolvedValue([]),
        updateModel: vi.fn(),
        pullModel: vi.fn(),
        getBackendCapabilities: vi.fn().mockReturnValue(null),
      },
    });
  }

  it('posts unloading and unloaded messages on success, then calls loadModels', async () => {
    mockKickstandUnloadModel.mockResolvedValue(undefined);
    const state = kickstandUnloadState();

    await handleKickstandUnloadModel(state as never, 'my-model');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('Unloading') }),
    );
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('unloaded') }),
    );
    expect(state.client.listLibraryModels).toHaveBeenCalled();
  });

  it('posts error when kickstandUnloadModel rejects and still calls loadModels', async () => {
    mockKickstandUnloadModel.mockRejectedValue(new Error('GPU error'));
    const state = kickstandUnloadState();

    await handleKickstandUnloadModel(state as never, 'my-model');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('GPU error') }),
    );
    expect(state.client.listLibraryModels).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleDeleteModel
// ---------------------------------------------------------------------------

describe('handleDeleteModel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    // status: 200 needed for isProviderReachable, ok: true for Ollama reachability
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    mockDeleteOllamaModel.mockReset();
  });

  it('returns immediately without dialog when backend is not local Ollama', async () => {
    const state = mockState({
      client: {
        isLocalOllama: vi.fn().mockReturnValue(false),
        listLibraryModels: vi.fn().mockResolvedValue([]),
        updateModel: vi.fn(),
        getProviderType: vi.fn().mockReturnValue('openai'),
        pullModel: vi.fn(),
        getBackendCapabilities: vi.fn().mockReturnValue(null),
      },
    });
    // window.showWarningMessage is a vi.fn() in the vscode mock — reset it
    // so stale calls from prior tests don't contaminate this assertion.
    (window.showWarningMessage as ReturnType<typeof vi.fn>).mockReset();
    const callCountBefore = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.length;

    await handleDeleteModel(state as never, 'some-model');

    const callCountAfter = (window.showWarningMessage as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(callCountAfter).toBe(callCountBefore); // no new calls
    expect(mockDeleteOllamaModel).not.toHaveBeenCalled();
  });

  it('does not delete when user dismisses the confirmation dialog (returns undefined)', async () => {
    const state = mockState();
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);

    await handleDeleteModel(state as never, 'llama3:latest');

    expect(mockDeleteOllamaModel).not.toHaveBeenCalled();
  });

  it('does not delete when user clicks Cancel (returns non-Delete string)', async () => {
    const state = mockState();
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Cancel' as never);

    await handleDeleteModel(state as never, 'llama3:latest');

    expect(mockDeleteOllamaModel).not.toHaveBeenCalled();
  });

  it('calls deleteOllamaModel and then loadModels when user confirms Delete', async () => {
    const state = mockState({
      client: {
        isLocalOllama: vi.fn().mockReturnValue(true),
        listLibraryModels: vi.fn().mockResolvedValue([]),
        updateModel: vi.fn(),
        getProviderType: vi.fn().mockReturnValue('ollama'),
        pullModel: vi.fn(),
      },
    });
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Delete' as never);
    mockDeleteOllamaModel.mockResolvedValue(undefined);

    await handleDeleteModel(state as never, 'llama3:latest');

    expect(mockDeleteOllamaModel).toHaveBeenCalledWith(expect.any(String), 'llama3:latest');
    expect(state.client.listLibraryModels).toHaveBeenCalled();
  });

  it('posts error message when deleteOllamaModel throws', async () => {
    const state = mockState({
      client: {
        isLocalOllama: vi.fn().mockReturnValue(true),
        listLibraryModels: vi.fn().mockResolvedValue([]),
        updateModel: vi.fn(),
        getProviderType: vi.fn().mockReturnValue('ollama'),
        pullModel: vi.fn(),
      },
    });
    vi.spyOn(window, 'showWarningMessage').mockResolvedValue('Delete' as never);
    mockDeleteOllamaModel.mockRejectedValue(new Error('model not found'));

    await handleDeleteModel(state as never, 'llama3:latest');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('model not found') }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleInstallModel — Kickstand path (runKickstandInstall)
// ---------------------------------------------------------------------------

describe('handleInstallModel — Kickstand path', () => {
  function kickstandInstallState(overrides: Record<string, unknown> = {}) {
    return mockState({
      client: {
        isLocalOllama: vi.fn().mockReturnValue(false),
        getProviderType: vi.fn().mockReturnValue('kickstand'),
        listLibraryModels: vi.fn().mockResolvedValue([]),
        updateModel: vi.fn(),
        pullModel: vi.fn(),
        getBackendCapabilities: vi.fn().mockReturnValue(null),
      },
      installAbortController: null,
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
    mockFetch.mockReset();
    // status: 200 needed so isProviderReachable('kickstand') passes
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    mockKickstandListRegistry.mockReset();
    mockKickstandLoadModel.mockReset();
    mockKickstandUnloadModel.mockReset();
    mockKickstandPull.mockReset();
  });

  it('posts "already loaded" and returns without pulling when model is ready+loaded in registry', async () => {
    mockKickstandListRegistry.mockResolvedValue([
      {
        model_id: 'qwen3:8b',
        hf_repo: 'Qwen/Qwen3-8B-GGUF',
        status: 'ready',
        loaded: true,
        local_path: '/models/qwen3-8b.gguf',
      },
    ]);
    const state = kickstandInstallState();

    await handleInstallModel(state as never, 'qwen3:8b');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('already loaded') }),
    );
    expect(mockKickstandPull).not.toHaveBeenCalled();
    expect(mockKickstandLoadModel).not.toHaveBeenCalled();
    expect(state.client.updateModel).toHaveBeenCalledWith('qwen3:8b');
  });

  it('loads existing downloaded model when ready but not loaded', async () => {
    mockKickstandListRegistry.mockResolvedValue([
      {
        model_id: 'qwen3:8b',
        hf_repo: 'Qwen/Qwen3-8B-GGUF',
        status: 'ready',
        loaded: false,
        local_path: '/models/qwen3-8b.gguf',
      },
    ]);
    mockKickstandLoadModel.mockResolvedValue(undefined);
    const state = kickstandInstallState();

    await handleInstallModel(state as never, 'qwen3:8b');

    expect(mockKickstandLoadModel).toHaveBeenCalled();
    expect(state.client.updateModel).toHaveBeenCalledWith('qwen3:8b');
    expect(state.client.listLibraryModels).toHaveBeenCalled();
    expect(mockKickstandPull).not.toHaveBeenCalled();
  });

  it('posts error when loading existing downloaded model fails', async () => {
    mockKickstandListRegistry.mockResolvedValue([
      {
        model_id: 'qwen3:8b',
        hf_repo: 'Qwen/Qwen3-8B-GGUF',
        status: 'ready',
        loaded: false,
        local_path: '/models/qwen3-8b.gguf',
      },
    ]);
    mockKickstandLoadModel.mockRejectedValue(new Error('insufficient VRAM'));
    const state = kickstandInstallState();

    await handleInstallModel(state as never, 'qwen3:8b');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('insufficient VRAM') }),
    );
  });

  it('streams pull events (downloading + progress + done) and then loads model', async () => {
    // Registry returns empty — no existing model
    mockKickstandListRegistry.mockResolvedValue([]);
    mockKickstandLoadModel.mockResolvedValue(undefined);

    async function* fakePull() {
      yield { status: 'downloading', format: 'gguf', repo: 'Qwen/Qwen3-8B-GGUF' };
      yield { status: 'progress', bytes_done: 512 * 1024 * 1024, bytes_total: 1024 * 1024 * 1024, percent: 50 };
      yield { status: 'done' };
    }
    mockKickstandPull.mockReturnValue(fakePull());

    const state = kickstandInstallState();

    await handleInstallModel(state as never, 'Qwen/Qwen3-8B-GGUF');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'installProgress', modelName: 'Qwen/Qwen3-8B-GGUF' }),
    );
    expect(mockKickstandLoadModel).toHaveBeenCalled();
    expect(state.client.updateModel).toHaveBeenCalled();
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'installComplete' }));
  });

  it('posts error and returns when pull emits an error event', async () => {
    mockKickstandListRegistry.mockResolvedValue([]);

    async function* fakePull() {
      yield { status: 'error', message: 'quota exceeded' };
    }
    mockKickstandPull.mockReturnValue(fakePull());

    const state = kickstandInstallState();

    await handleInstallModel(state as never, 'Qwen/Qwen3-8B-GGUF');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('quota exceeded') }),
    );
    expect(mockKickstandLoadModel).not.toHaveBeenCalled();
  });

  it('posts installComplete without error when signal is aborted during stream', async () => {
    mockKickstandListRegistry.mockResolvedValue([]);

    mockKickstandPull.mockImplementation(async function* () {
      yield { status: 'progress', bytes_done: 100, bytes_total: 100, percent: 100 };
      // Throw an AbortError to exercise the abort catch path.
      const err = new Error('Aborted');
      err.name = 'AbortError';
      throw err;
    });

    const state = kickstandInstallState();

    await handleInstallModel(state as never, 'Qwen/Qwen3-8B-GGUF');

    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'installComplete' }));
    // No error should have been posted
    const calls = (state.postMessage as ReturnType<typeof vi.fn>).mock.calls;
    const errorCalls = calls.filter((c: unknown[]) => (c[0] as { command: string }).command === 'error');
    expect(errorCalls).toHaveLength(0);
  });

  it('posts warning but still sets model when kickstandLoadModel fails after pull', async () => {
    mockKickstandListRegistry.mockResolvedValue([]);
    mockKickstandLoadModel.mockRejectedValue(new Error('load failed'));

    async function* fakePull() {
      yield { status: 'done' };
    }
    mockKickstandPull.mockReturnValue(fakePull());

    const state = kickstandInstallState();

    await handleInstallModel(state as never, 'Qwen/Qwen3-8B-GGUF');

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        command: 'assistantMessage',
        content: expect.stringContaining('Warning'),
      }),
    );
    // loadModels is still called
    expect(state.client.listLibraryModels).toHaveBeenCalled();
  });

  it('falls through to pull when registry is unreachable', async () => {
    mockKickstandListRegistry.mockRejectedValue(new Error('ECONNREFUSED'));
    mockKickstandLoadModel.mockResolvedValue(undefined);

    async function* fakePull() {
      yield { status: 'done' };
    }
    mockKickstandPull.mockReturnValue(fakePull());

    const state = kickstandInstallState();

    await handleInstallModel(state as never, 'Qwen/Qwen3-8B-GGUF');

    // Should have attempted a pull despite the registry error
    expect(mockKickstandPull).toHaveBeenCalled();
  });

  it('resolves modelId from registry when done event includes local_path', async () => {
    // First call (registry check) — no existing model
    mockKickstandListRegistry
      .mockResolvedValueOnce([])
      // Second call (after done event with local_path) — registry now has the model
      .mockResolvedValueOnce([
        {
          model_id: 'resolved-model-id',
          hf_repo: 'Qwen/Qwen3-8B-GGUF',
          status: 'ready',
          loaded: false,
          local_path: '/models/resolved.gguf',
        },
      ]);
    mockKickstandLoadModel.mockResolvedValue(undefined);

    async function* fakePull() {
      yield { status: 'done', local_path: '/models/resolved.gguf' };
    }
    mockKickstandPull.mockReturnValue(fakePull());

    const state = kickstandInstallState();

    await handleInstallModel(state as never, 'Qwen/Qwen3-8B-GGUF');

    // The model_id from registry lookup should be used
    expect(state.client.updateModel).toHaveBeenCalledWith('resolved-model-id');
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'installComplete', modelName: 'resolved-model-id' }),
    );
  });
});
