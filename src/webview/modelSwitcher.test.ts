import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { window, workspace, ConfigurationTarget } from 'vscode';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock('../config/settings.js', () => ({
  getConfig: vi
    .fn()
    .mockReturnValue({ baseUrl: 'http://localhost:11434', apiKey: '', provider: 'ollama', verboseMode: false }),
  detectProvider: vi.fn().mockReturnValue('ollama'),
  ingestOpenRouterCatalog: vi.fn().mockReturnValue(0),
}));

vi.mock('./handlers/modelHandlers.js', () => ({
  handleInstallModel: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../ollama/ollamaBackend.js', () => ({
  modelSupportsTools: vi.fn().mockReturnValue(true),
  probeModelToolSupport: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../ollama/openrouterBackend.js', () => ({
  OpenRouterBackend: class {
    async listOpenRouterModels() {
      return [];
    }
  },
}));

import { setModel, refreshOpenRouterCostsIfActive } from './modelSwitcher.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(overrides: Record<string, unknown> = {}) {
  return {
    updateConnection: vi.fn(),
    updateModel: vi.fn(),
    isLocalOllama: vi.fn().mockReturnValue(false),
    listInstalledModels: vi.fn().mockResolvedValue([{ name: 'llama3:latest' }]),
    ...overrides,
  };
}

function makeState(clientOverrides: Record<string, unknown> = {}) {
  return { client: makeClient(clientOverrides) } as unknown as import('./chatState.js').ChatState;
}

function mockWorkspaceConfig() {
  const mockUpdate = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
    get: vi.fn(),
    inspect: vi.fn(),
    has: vi.fn(),
    update: mockUpdate,
  } as unknown as ReturnType<typeof workspace.getConfiguration>);
  return mockUpdate;
}

// ---------------------------------------------------------------------------
// Tests — setModel
// ---------------------------------------------------------------------------

describe('setModel', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let postMessage: (msg: any) => void;

  beforeEach(() => {
    vi.clearAllMocks();
    postMessage = vi.fn();
  });

  it('is a no-op when model is empty string', async () => {
    const state = makeState();
    await setModel(state, postMessage, '');
    expect(state.client.updateConnection).not.toHaveBeenCalled();
  });

  it('skips Ollama model check for non-local backends', async () => {
    mockWorkspaceConfig();
    const state = makeState({ isLocalOllama: vi.fn().mockReturnValue(false) });
    await setModel(state, postMessage, 'gpt-4o');
    expect(state.client.listInstalledModels).not.toHaveBeenCalled();
    expect(state.client.updateModel).toHaveBeenCalledWith('gpt-4o');
  });

  it('updates the model and posts setCurrentModel when model is installed', async () => {
    mockWorkspaceConfig();
    const state = makeState({
      isLocalOllama: vi.fn().mockReturnValue(true),
      listInstalledModels: vi.fn().mockResolvedValue([{ name: 'llama3:latest' }]),
    });
    await setModel(state, postMessage, 'llama3');
    expect(state.client.updateModel).toHaveBeenCalledWith('llama3');
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'setCurrentModel', currentModel: 'llama3' }),
    );
  });

  it('saves the model — to Global when nothing pins it elsewhere', async () => {
    // Was `update('model', m, true)` (always Global). That silently broke the
    // dropdown in any project pinning sidecar.model in .vscode/settings.json:
    // workspace scope won on read, so the agent kept the old model.
    const mockUpdate = mockWorkspaceConfig();
    const state = makeState({ isLocalOllama: vi.fn().mockReturnValue(false) });
    await setModel(state, postMessage, 'mistral');
    expect(mockUpdate).toHaveBeenCalledWith('model', 'mistral', ConfigurationTarget.Global);
  });

  it('shows warning and returns early when model is not installed', async () => {
    vi.mocked(window.showWarningMessage).mockResolvedValue(undefined as unknown as string & { title: string });
    const state = makeState({
      isLocalOllama: vi.fn().mockReturnValue(true),
      listInstalledModels: vi.fn().mockResolvedValue([{ name: 'other:latest' }]),
    });
    await setModel(state, postMessage, 'llama3');
    expect(state.client.updateModel).not.toHaveBeenCalled();
    expect(window.showWarningMessage).toHaveBeenCalledOnce();
  });

  it('triggers install when user picks "Install Model"', async () => {
    vi.mocked(window.showWarningMessage).mockResolvedValue('Install Model' as unknown as string & { title: string });
    const { handleInstallModel } = await import('./handlers/modelHandlers.js');
    const state = makeState({
      isLocalOllama: vi.fn().mockReturnValue(true),
      listInstalledModels: vi.fn().mockResolvedValue([]),
    });
    await setModel(state, postMessage, 'llama3');
    expect(handleInstallModel).toHaveBeenCalledWith(state, 'llama3');
  });

  it('falls through when Ollama is unreachable', async () => {
    mockWorkspaceConfig();
    const state = makeState({
      isLocalOllama: vi.fn().mockReturnValue(true),
      listInstalledModels: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    await setModel(state, postMessage, 'llama3');
    expect(state.client.updateModel).toHaveBeenCalledWith('llama3');
  });

  it('calls probeModelToolSupport for local Ollama models', async () => {
    mockWorkspaceConfig();
    const { probeModelToolSupport } = await import('../ollama/ollamaBackend.js');
    const state = makeState({ isLocalOllama: vi.fn().mockReturnValue(true) });
    await setModel(state, postMessage, 'llama3');
    expect(probeModelToolSupport).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tests — refreshOpenRouterCostsIfActive
// ---------------------------------------------------------------------------

describe('refreshOpenRouterCostsIfActive', () => {
  it('is a no-op when the active provider is not openrouter', async () => {
    const { detectProvider, ingestOpenRouterCatalog } = await import('../config/settings.js');
    vi.mocked(detectProvider).mockReturnValue('ollama');
    vi.mocked(ingestOpenRouterCatalog).mockClear();
    await refreshOpenRouterCostsIfActive('http://localhost:11434', '');
    expect(ingestOpenRouterCatalog).not.toHaveBeenCalled();
  });

  it('fetches and ingests the OpenRouter catalog when provider is openrouter', async () => {
    const { detectProvider, ingestOpenRouterCatalog } = await import('../config/settings.js');
    vi.mocked(detectProvider).mockReturnValue('openrouter');
    vi.mocked(ingestOpenRouterCatalog).mockReturnValue(5);
    await refreshOpenRouterCostsIfActive('https://openrouter.ai/api/v1', 'key');
    expect(ingestOpenRouterCatalog).toHaveBeenCalled();
  });
});

describe('setModel persists to the scope where sidecar.model is defined', () => {
  afterEach(() => vi.restoreAllMocks());

  function stubConfig(inspectResult: Record<string, unknown>) {
    const update = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      get: <T>(_k: string, d?: T) => d,
      inspect: () => inspectResult,
      update,
    } as never);
    return update;
  }

  const state = () =>
    ({
      client: {
        updateConnection: vi.fn(),
        updateModel: vi.fn(),
        isLocalOllama: () => false,
        listInstalledModels: vi.fn(),
      },
    }) as never;

  it('writes to WORKSPACE scope when the project pins the model (live v0.119 bug)', async () => {
    // The dogfood workspace pinned sidecar.model in .vscode/settings.json.
    // setModel wrote Global, workspace scope won on read, and the next turn's
    // updateModel(config.model) snapped the client back — switching to gemma4
    // silently kept running llama3.2.
    const update = stubConfig({ workspaceValue: 'llama3.2:latest', globalValue: undefined });
    await setModel(state(), () => {}, 'gemma4:e4b');
    expect(update).toHaveBeenCalledWith('model', 'gemma4:e4b', ConfigurationTarget.Workspace);
  });

  it('writes to GLOBAL scope when the model is only a user setting', async () => {
    const update = stubConfig({ workspaceValue: undefined, globalValue: 'llama3.2:latest' });
    await setModel(state(), () => {}, 'gemma4:e4b');
    expect(update).toHaveBeenCalledWith('model', 'gemma4:e4b', ConfigurationTarget.Global);
  });

  it('writes to WORKSPACE FOLDER scope when that is where it is pinned', async () => {
    const update = stubConfig({ workspaceFolderValue: 'llama3.2:latest', workspaceValue: undefined });
    await setModel(state(), () => {}, 'gemma4:e4b');
    expect(update).toHaveBeenCalledWith('model', 'gemma4:e4b', ConfigurationTarget.WorkspaceFolder);
  });
});
