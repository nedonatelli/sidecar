import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock vscode surfaces the command handlers touch. We care about
// window.showQuickPick, window.showInputBox, window.showInformationMessage,
// window.showErrorMessage, and window.withProgress.
const { showQuickPickMock, showInputBoxMock, showInfoMock, showErrorMock, withProgressMock, registerCommandMock } =
  vi.hoisted(() => ({
    showQuickPickMock: vi.fn(),
    showInputBoxMock: vi.fn(),
    showInfoMock: vi.fn(),
    showErrorMock: vi.fn(),
    withProgressMock: vi.fn(async (_opts: unknown, body: () => Promise<void>) => body()),
    registerCommandMock: vi.fn(),
  }));

vi.mock('vscode', () => ({
  window: {
    showQuickPick: showQuickPickMock,
    showInputBox: showInputBoxMock,
    showInformationMessage: showInfoMock,
    showErrorMessage: showErrorMock,
    withProgress: withProgressMock,
  },
  commands: {
    registerCommand: registerCommandMock,
  },
  ProgressLocation: {
    Notification: 15,
  },
}));

import { registerBackendCommands, formatBytes } from './backendCommands.js';
import type { SideCarClient } from '../ollama/client.js';
import type { BackendCapabilities } from '../ollama/backend.js';

/**
 * Minimal fake SideCarClient whose only responsibility is to return
 * a configurable BackendCapabilities record. The command handlers
 * only call `getBackendCapabilities()` on the client — nothing else.
 */
function makeFakeClient(caps: BackendCapabilities | undefined): SideCarClient {
  return { getBackendCapabilities: () => caps } as unknown as SideCarClient;
}

/**
 * Register the commands, capture the handlers by name. Returns a
 * record keyed by command name so tests can invoke a specific
 * handler without stringly-typed lookups.
 */
function captureHandlers(client: SideCarClient): Record<string, () => Promise<void>> {
  registerCommandMock.mockReset();
  registerBackendCommands({ subscriptions: { push: vi.fn() } } as never, () => client);
  const handlers: Record<string, () => Promise<void>> = {};
  for (const call of registerCommandMock.mock.calls) {
    const [name, fn] = call as [string, () => Promise<void>];
    handlers[name] = fn;
  }
  return handlers;
}

beforeEach(() => {
  showQuickPickMock.mockReset();
  showInputBoxMock.mockReset();
  showInfoMock.mockReset();
  showErrorMock.mockReset();
  withProgressMock.mockClear();
});

describe('registerBackendCommands', () => {
  it('registers both load and unload commands', () => {
    const client = makeFakeClient(undefined);
    const handlers = captureHandlers(client);
    expect(Object.keys(handlers)).toEqual(
      expect.arrayContaining(['sidecar.kickstand.loadModel', 'sidecar.kickstand.unloadModel']),
    );
  });
});

describe('sidecar.kickstand.loadModel', () => {
  it('shows a not-supported notice when the active backend has no lifecycle capability', async () => {
    const client = makeFakeClient({}); // capabilities object, but no lifecycle
    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.loadModel']();

    expect(showInfoMock).toHaveBeenCalledTimes(1);
    const msg = showInfoMock.mock.calls[0][0] as string;
    expect(msg).toMatch(/does not support model lifecycle/i);
    // withProgress never fires — we short-circuit before any
    // network-like work.
    expect(withProgressMock).not.toHaveBeenCalled();
  });

  it('shows a QuickPick of UNLOADED models when listLoadable is available', async () => {
    const loadModel = vi.fn().mockResolvedValue('Loaded qwen3:30b');
    const client = makeFakeClient({
      lifecycle: {
        loadModel,
        unloadModel: vi.fn(),
        listLoadable: async () => [
          { id: 'qwen3:30b', loaded: false, sizeBytes: 20_000_000_000 },
          { id: 'llama3:8b', loaded: true, sizeBytes: 4_000_000_000 },
          { id: 'mistral:7b', loaded: false, sizeBytes: 7_000_000_000 },
        ],
      },
    });
    showQuickPickMock.mockResolvedValue({ label: 'qwen3:30b' });

    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.loadModel']();

    // The QuickPick receives only the unloaded models.
    const quickPickItems = showQuickPickMock.mock.calls[0][0] as Array<{ label: string }>;
    expect(quickPickItems.map((i) => i.label)).toEqual(['qwen3:30b', 'mistral:7b']);
    expect(quickPickItems.map((i) => i.label)).not.toContain('llama3:8b');

    expect(loadModel).toHaveBeenCalledWith('qwen3:30b');
    expect(showInfoMock).toHaveBeenCalledWith('Loaded qwen3:30b');
  });

  it('falls back to free-text input when listLoadable is unavailable', async () => {
    const loadModel = vi.fn().mockResolvedValue('Loaded foo');
    const client = makeFakeClient({
      lifecycle: {
        loadModel,
        unloadModel: vi.fn(),
        // No listLoadable
      },
    });
    showInputBoxMock.mockResolvedValue('foo');

    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.loadModel']();

    expect(showQuickPickMock).not.toHaveBeenCalled();
    expect(showInputBoxMock).toHaveBeenCalledTimes(1);
    expect(loadModel).toHaveBeenCalledWith('foo');
  });

  it('falls back to free-text input when listLoadable throws', async () => {
    const loadModel = vi.fn().mockResolvedValue('Loaded bar');
    const client = makeFakeClient({
      lifecycle: {
        loadModel,
        unloadModel: vi.fn(),
        listLoadable: async () => {
          throw new Error('registry unreachable');
        },
      },
    });
    showInputBoxMock.mockResolvedValue('bar');

    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.loadModel']();

    // Fell through to input box despite listLoadable being defined.
    expect(showInputBoxMock).toHaveBeenCalledTimes(1);
    expect(loadModel).toHaveBeenCalledWith('bar');
  });

  it('falls back to free-text input when the registry has zero matching candidates', async () => {
    // All models already loaded — nothing to offer for LOAD. Rather
    // than silently succeeding with an empty QuickPick (bad UX),
    // fall through to input-box so the user can still type an ID.
    const loadModel = vi.fn().mockResolvedValue('Loaded new');
    const client = makeFakeClient({
      lifecycle: {
        loadModel,
        unloadModel: vi.fn(),
        listLoadable: async () => [{ id: 'already-loaded', loaded: true }],
      },
    });
    showInputBoxMock.mockResolvedValue('new');

    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.loadModel']();

    expect(showQuickPickMock).not.toHaveBeenCalled();
    expect(showInputBoxMock).toHaveBeenCalledTimes(1);
  });

  it('shows the error message when loadModel throws', async () => {
    const loadModel = vi.fn().mockRejectedValue(new Error('Kickstand load failed (500): out of memory'));
    const client = makeFakeClient({
      lifecycle: {
        loadModel,
        unloadModel: vi.fn(),
        listLoadable: async () => [{ id: 'qwen3:30b', loaded: false }],
      },
    });
    showQuickPickMock.mockResolvedValue({ label: 'qwen3:30b' });

    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.loadModel']();

    expect(showErrorMock).toHaveBeenCalledTimes(1);
    expect(showErrorMock.mock.calls[0][0]).toMatch(/Failed to load qwen3:30b.*out of memory/);
  });

  it('does nothing when the user cancels the picker', async () => {
    const loadModel = vi.fn();
    const client = makeFakeClient({
      lifecycle: {
        loadModel,
        unloadModel: vi.fn(),
        listLoadable: async () => [{ id: 'qwen3:30b', loaded: false }],
      },
    });
    showQuickPickMock.mockResolvedValue(undefined); // user hit Escape

    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.loadModel']();

    expect(loadModel).not.toHaveBeenCalled();
    expect(showInfoMock).not.toHaveBeenCalled();
  });
});

describe('sidecar.kickstand.unloadModel', () => {
  it('shows a QuickPick of LOADED models when listLoadable is available', async () => {
    const unloadModel = vi.fn().mockResolvedValue('Unloaded llama3:8b');
    const client = makeFakeClient({
      lifecycle: {
        loadModel: vi.fn(),
        unloadModel,
        listLoadable: async () => [
          { id: 'qwen3:30b', loaded: false },
          { id: 'llama3:8b', loaded: true },
        ],
      },
    });
    showQuickPickMock.mockResolvedValue({ label: 'llama3:8b' });

    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.unloadModel']();

    const quickPickItems = showQuickPickMock.mock.calls[0][0] as Array<{ label: string }>;
    expect(quickPickItems.map((i) => i.label)).toEqual(['llama3:8b']);
    expect(unloadModel).toHaveBeenCalledWith('llama3:8b');
  });

  it('shows the not-supported notice when capabilities are absent entirely', async () => {
    const client = makeFakeClient(undefined);
    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.unloadModel']();
    expect(showInfoMock).toHaveBeenCalledWith(expect.stringMatching(/does not support model lifecycle/i));
  });
});

describe('formatBytes', () => {
  it('formats bytes at each scale', () => {
    expect(formatBytes(500)).toBe('500B');
    expect(formatBytes(2048)).toBe('2.0KB');
    expect(formatBytes(1_500_000)).toBe('1.4MB');
    expect(formatBytes(20_000_000_000)).toBe('18.6GB');
  });
});

// ---------------------------------------------------------------------------
// LoRA adapter + model browser command tests (v0.67.0, chunk 8 closure)
// ---------------------------------------------------------------------------

describe('sidecar.kickstand.loadAdapter', () => {
  it('shows the not-supported notice when the backend has no loraAdapters capability', async () => {
    const client = makeFakeClient({
      lifecycle: {
        loadModel: vi.fn(),
        unloadModel: vi.fn(),
        listLoadable: async () => [],
      },
    });
    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.loadAdapter']();
    expect(showInfoMock).toHaveBeenCalledWith(expect.stringMatching(/does not support LoRA/i));
  });

  it('shows the not-supported notice when capabilities are absent entirely', async () => {
    const client = makeFakeClient(undefined);
    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.loadAdapter']();
    expect(showInfoMock).toHaveBeenCalled();
  });

  it('prompts for model + path + scale and calls loadAdapter with the resolved values', async () => {
    const loadAdapter = vi.fn().mockResolvedValue('Loaded LoRA ad-1 on llama3:8b');
    const client = makeFakeClient({
      lifecycle: {
        loadModel: vi.fn(),
        unloadModel: vi.fn(),
        listLoadable: async () => [{ id: 'llama3:8b', loaded: true }],
      },
      loraAdapters: {
        listAdapters: vi.fn(),
        loadAdapter,
        unloadAdapter: vi.fn(),
      },
    });
    showQuickPickMock.mockResolvedValueOnce({ label: 'llama3:8b' });
    showInputBoxMock
      .mockResolvedValueOnce('/a/lora.gguf') // path
      .mockResolvedValueOnce('0.75'); // scale

    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.loadAdapter']();

    expect(loadAdapter).toHaveBeenCalledWith('llama3:8b', '/a/lora.gguf', 0.75);
    expect(showInfoMock).toHaveBeenCalledWith('Loaded LoRA ad-1 on llama3:8b');
  });

  it('aborts silently when the user dismisses the model picker', async () => {
    const loadAdapter = vi.fn();
    const client = makeFakeClient({
      lifecycle: {
        loadModel: vi.fn(),
        unloadModel: vi.fn(),
        listLoadable: async () => [{ id: 'llama3:8b', loaded: true }],
      },
      loraAdapters: { listAdapters: vi.fn(), loadAdapter, unloadAdapter: vi.fn() },
    });
    showQuickPickMock.mockResolvedValueOnce(undefined); // user hit Escape
    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.loadAdapter']();
    expect(loadAdapter).not.toHaveBeenCalled();
  });

  it('surfaces a showError when loadAdapter rejects', async () => {
    const loadAdapter = vi.fn().mockRejectedValue(new Error('kaboom'));
    const client = makeFakeClient({
      lifecycle: {
        loadModel: vi.fn(),
        unloadModel: vi.fn(),
        listLoadable: async () => [{ id: 'llama3:8b', loaded: true }],
      },
      loraAdapters: { listAdapters: vi.fn(), loadAdapter, unloadAdapter: vi.fn() },
    });
    showQuickPickMock.mockResolvedValueOnce({ label: 'llama3:8b' });
    showInputBoxMock.mockResolvedValueOnce('/a.gguf').mockResolvedValueOnce('1.0');

    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.loadAdapter']();
    expect(showErrorMock).toHaveBeenCalledWith(expect.stringMatching(/Failed to load adapter.*kaboom/));
  });
});

describe('sidecar.kickstand.unloadAdapter', () => {
  it('shows the not-supported notice when backend has no loraAdapters', async () => {
    const client = makeFakeClient(undefined);
    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.unloadAdapter']();
    expect(showInfoMock).toHaveBeenCalled();
  });

  it('shows an info when the model has zero adapters loaded', async () => {
    const client = makeFakeClient({
      lifecycle: {
        loadModel: vi.fn(),
        unloadModel: vi.fn(),
        listLoadable: async () => [{ id: 'llama3:8b', loaded: true }],
      },
      loraAdapters: {
        listAdapters: async () => [],
        loadAdapter: vi.fn(),
        unloadAdapter: vi.fn(),
      },
    });
    showQuickPickMock.mockResolvedValueOnce({ label: 'llama3:8b' });

    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.unloadAdapter']();
    expect(showInfoMock).toHaveBeenCalledWith(expect.stringMatching(/No LoRA adapters loaded/i));
  });

  it('shows a QuickPick of adapters when some are loaded and calls unloadAdapter on pick', async () => {
    const unloadAdapter = vi.fn().mockResolvedValue('Unloaded LoRA ad-1 from llama3:8b');
    const client = makeFakeClient({
      lifecycle: {
        loadModel: vi.fn(),
        unloadModel: vi.fn(),
        listLoadable: async () => [{ id: 'llama3:8b', loaded: true }],
      },
      loraAdapters: {
        listAdapters: async () => [{ id: 'ad-1', path: '/a.gguf', scale: 1.0 }],
        loadAdapter: vi.fn(),
        unloadAdapter,
      },
    });
    showQuickPickMock
      .mockResolvedValueOnce({ label: 'llama3:8b' }) // model picker
      .mockResolvedValueOnce({ label: 'ad-1' }); // adapter picker

    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.unloadAdapter']();
    expect(unloadAdapter).toHaveBeenCalledWith('llama3:8b', 'ad-1');
    expect(showInfoMock).toHaveBeenCalledWith('Unloaded LoRA ad-1 from llama3:8b');
  });

  it('surfaces a showError when listAdapters rejects', async () => {
    const client = makeFakeClient({
      lifecycle: {
        loadModel: vi.fn(),
        unloadModel: vi.fn(),
        listLoadable: async () => [{ id: 'llama3:8b', loaded: true }],
      },
      loraAdapters: {
        listAdapters: async () => {
          throw new Error('connection refused');
        },
        loadAdapter: vi.fn(),
        unloadAdapter: vi.fn(),
      },
    });
    showQuickPickMock.mockResolvedValueOnce({ label: 'llama3:8b' });

    const handlers = captureHandlers(client);
    await handlers['sidecar.kickstand.unloadAdapter']();
    expect(showErrorMock).toHaveBeenCalledWith(expect.stringMatching(/Failed to list adapters.*connection refused/));
  });
});

describe('sidecar.modelBrowser', () => {
  it('shows the not-supported notice when backend has no modelBrowser capability', async () => {
    const client = makeFakeClient({
      lifecycle: { loadModel: vi.fn(), unloadModel: vi.fn(), listLoadable: async () => [] },
    });
    const handlers = captureHandlers(client);
    await handlers['sidecar.modelBrowser']();
    expect(showInfoMock).toHaveBeenCalledWith(expect.stringMatching(/does not support model browsing/i));
  });

  it('shows an info when the repo contains no GGUF/MLX files', async () => {
    const browseRepo = vi.fn().mockResolvedValue([]);
    const client = makeFakeClient({
      lifecycle: { loadModel: vi.fn(), unloadModel: vi.fn(), listLoadable: async () => [] },
      modelBrowser: { browseRepo },
    });
    showInputBoxMock.mockResolvedValueOnce('org/repo');

    const handlers = captureHandlers(client);
    await handlers['sidecar.modelBrowser']();
    expect(browseRepo).toHaveBeenCalledWith('org/repo');
    expect(showInfoMock).toHaveBeenCalledWith(expect.stringMatching(/No GGUF\/MLX files found/));
  });

  it('renders file entries in the QuickPick with formatted size + quant + format', async () => {
    const browseRepo = vi
      .fn()
      .mockResolvedValue([{ filename: 'model-q4.gguf', sizeBytes: 4_700_000_000, quant: 'Q4_K_M', format: 'gguf' }]);
    const client = makeFakeClient({
      lifecycle: { loadModel: vi.fn(), unloadModel: vi.fn(), listLoadable: async () => [] },
      modelBrowser: { browseRepo },
    });
    showInputBoxMock.mockResolvedValueOnce('org/repo');
    // User dismisses the file picker — that stops the flow before the
    // pull stage (which pulls in settings.ts + kickstandBackend deeply).
    showQuickPickMock.mockResolvedValueOnce(undefined);

    const handlers = captureHandlers(client);
    await handlers['sidecar.modelBrowser']();

    const items = showQuickPickMock.mock.calls[0][0] as Array<{ label: string; description: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].label).toBe('model-q4.gguf');
    expect(items[0].description).toMatch(/Q4_K_M/);
    expect(items[0].description).toMatch(/gguf/);
  });

  it('aborts silently when the user dismisses the repo input box', async () => {
    const browseRepo = vi.fn();
    const client = makeFakeClient({
      lifecycle: { loadModel: vi.fn(), unloadModel: vi.fn(), listLoadable: async () => [] },
      modelBrowser: { browseRepo },
    });
    showInputBoxMock.mockResolvedValueOnce(undefined); // user hit Escape

    const handlers = captureHandlers(client);
    await handlers['sidecar.modelBrowser']();
    expect(browseRepo).not.toHaveBeenCalled();
  });

  it('surfaces a showError when browseRepo rejects', async () => {
    const client = makeFakeClient({
      lifecycle: { loadModel: vi.fn(), unloadModel: vi.fn(), listLoadable: async () => [] },
      modelBrowser: {
        browseRepo: async () => {
          throw new Error('hf rate limited');
        },
      },
    });
    showInputBoxMock.mockResolvedValueOnce('org/repo');

    const handlers = captureHandlers(client);
    await handlers['sidecar.modelBrowser']();
    expect(showErrorMock).toHaveBeenCalledWith(expect.stringMatching(/hf rate limited/));
  });
});

describe('registerBackendCommands — LoRA + model browser registration', () => {
  it('registers the three new commands alongside existing load/unload model commands', () => {
    const client = makeFakeClient(undefined);
    const handlers = captureHandlers(client);
    expect(Object.keys(handlers)).toEqual(
      expect.arrayContaining([
        'sidecar.kickstand.loadModel',
        'sidecar.kickstand.unloadModel',
        'sidecar.kickstand.loadAdapter',
        'sidecar.kickstand.unloadAdapter',
        'sidecar.modelBrowser',
      ]),
    );
  });
});
