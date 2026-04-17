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
