import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ensureProviderRunning, connectWithRetry, handleRestartOllama } from './connectionHandlers.js';

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return {
    ...actual,
    execSync: vi.fn(),
    spawn: vi.fn(() => ({ unref: vi.fn() })),
  };
});

vi.mock('./modelLoader.js', () => ({
  loadModels: vi.fn().mockResolvedValue(undefined),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(overrides: { providerType?: string; isLocalOllama?: boolean } = {}) {
  return {
    getProviderType: vi.fn().mockReturnValue(overrides.providerType ?? 'anthropic'),
    isLocalOllama: vi.fn().mockReturnValue(overrides.isLocalOllama ?? false),
  };
}

function makeState(clientOverrides: { providerType?: string; isLocalOllama?: boolean } = {}) {
  return {
    postMessage: vi.fn(),
    abortController: null as AbortController | null,
    client: makeClient(clientOverrides),
  };
}

// ---------------------------------------------------------------------------
// ensureProviderRunning
// ---------------------------------------------------------------------------

describe('ensureProviderRunning', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns true immediately when isProviderReachable is true', async () => {
    const providerReachability = await import('../../config/providerReachability.js');
    vi.spyOn(providerReachability, 'isProviderReachable').mockResolvedValue(true);

    const state = makeState();
    const result = await ensureProviderRunning(state as never);
    expect(result).toBe(true);
    expect(providerReachability.isProviderReachable).toHaveBeenCalledOnce();
  });

  it('returns false immediately for non-local, non-kickstand provider when unreachable', async () => {
    const providerReachability = await import('../../config/providerReachability.js');
    vi.spyOn(providerReachability, 'isProviderReachable').mockResolvedValue(false);

    const state = makeState({ providerType: 'anthropic', isLocalOllama: false });
    const result = await ensureProviderRunning(state as never);
    expect(result).toBe(false);
  });

  it('calls ensureKickstandRunning when provider is kickstand and unreachable', async () => {
    const providerReachability = await import('../../config/providerReachability.js');
    vi.spyOn(providerReachability, 'isProviderReachable').mockResolvedValue(false);
    const kickstandSpy = vi.spyOn(providerReachability, 'ensureKickstandRunning').mockResolvedValue(true);

    const state = makeState({ providerType: 'kickstand', isLocalOllama: false });
    const result = await ensureProviderRunning(state as never);
    expect(kickstandSpy).toHaveBeenCalledOnce();
    expect(result).toBe(true);
  });

  it('spawns ollama serve and polls until reachable for local Ollama', async () => {
    vi.useFakeTimers();
    const providerReachability = await import('../../config/providerReachability.js');
    // First call (initial check) false, subsequent polls true
    vi.spyOn(providerReachability, 'isProviderReachable').mockResolvedValueOnce(false).mockResolvedValue(true);

    const { spawn } = await import('child_process');
    const state = makeState({ providerType: 'ollama', isLocalOllama: true });
    const promise = ensureProviderRunning(state as never);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(spawn).toHaveBeenCalledWith('ollama', ['serve'], expect.objectContaining({ detached: true }));
    expect(result).toBe(true);
    vi.useRealTimers();
  });

  it('returns false for local Ollama when all 30 polls are exhausted', async () => {
    vi.useFakeTimers();
    const providerReachability = await import('../../config/providerReachability.js');
    vi.spyOn(providerReachability, 'isProviderReachable').mockResolvedValue(false);

    const state = makeState({ providerType: 'ollama', isLocalOllama: true });
    const promise = ensureProviderRunning(state as never);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(false);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// connectWithRetry
// ---------------------------------------------------------------------------

describe('connectWithRetry', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns true on the first attempt when provider is reachable', async () => {
    const providerReachability = await import('../../config/providerReachability.js');
    vi.spyOn(providerReachability, 'isProviderReachable').mockResolvedValue(true);

    const state = makeState();
    const result = await connectWithRetry(state as never);
    expect(result).toBe(true);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'typingStatus', content: 'Connecting to model...' }),
    );
  });

  it('posts retry status messages and returns true when provider comes up on second attempt', async () => {
    vi.useFakeTimers();
    const providerReachability = await import('../../config/providerReachability.js');
    // initial ensureProviderRunning check → false, retry poll → true
    vi.spyOn(providerReachability, 'isProviderReachable')
      .mockResolvedValueOnce(false) // ensureProviderRunning initial
      .mockResolvedValueOnce(false) // non-local branch → returns false from ensureProviderRunning
      .mockResolvedValueOnce(true); // retry poll

    const state = makeState({ providerType: 'anthropic', isLocalOllama: false });
    const promise = connectWithRetry(state as never);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(true);
    const commands = state.postMessage.mock.calls.map((c) => (c[0] as { command: string }).command);
    expect(commands).toContain('typingStatus');
    vi.useRealTimers();
  });

  it('returns false if the abort signal fires during retry wait', async () => {
    vi.useFakeTimers();
    const providerReachability = await import('../../config/providerReachability.js');
    vi.spyOn(providerReachability, 'isProviderReachable').mockResolvedValue(false);

    const controller = new AbortController();
    const state = { ...makeState(), abortController: controller };
    controller.abort();

    const promise = connectWithRetry(state as never);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(false);
    vi.useRealTimers();
  });

  it('returns false when all three retry attempts are exhausted', async () => {
    vi.useFakeTimers();
    const providerReachability = await import('../../config/providerReachability.js');
    vi.spyOn(providerReachability, 'isProviderReachable').mockResolvedValue(false);

    const state = makeState({ providerType: 'anthropic', isLocalOllama: false });
    const promise = connectWithRetry(state as never);
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe(false);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// handleRestartOllama
// ---------------------------------------------------------------------------

describe('handleRestartOllama', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('returns early without posting when provider is not local Ollama', async () => {
    const state = makeState({ isLocalOllama: false });
    await handleRestartOllama(state as never);
    expect(state.postMessage).not.toHaveBeenCalled();
  });

  it('posts success messages when Ollama comes back online', async () => {
    const providerReachability = await import('../../config/providerReachability.js');
    vi.spyOn(providerReachability, 'isProviderReachable').mockResolvedValue(true);

    const state = makeState({ providerType: 'ollama', isLocalOllama: true });
    await handleRestartOllama(state as never);

    const commands = state.postMessage.mock.calls.map((c) => (c[0] as { command: string }).command);
    expect(commands).toContain('typingStatus');
    expect(commands).toContain('assistantMessage');
    expect(commands).toContain('done');

    const assistantCall = state.postMessage.mock.calls.find(
      (c) => (c[0] as { command: string }).command === 'assistantMessage',
    );
    expect((assistantCall![0] as { content: string }).content).toContain('restarted successfully');
  });

  it('posts connection error when Ollama does not come back online', async () => {
    vi.useFakeTimers();
    const providerReachability = await import('../../config/providerReachability.js');
    vi.spyOn(providerReachability, 'isProviderReachable').mockResolvedValue(false);

    const state = makeState({ providerType: 'ollama', isLocalOllama: true });
    const promise = handleRestartOllama(state as never);
    await vi.runAllTimersAsync();
    await promise;

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', errorType: 'connection' }),
    );
    vi.useRealTimers();
  });
});
