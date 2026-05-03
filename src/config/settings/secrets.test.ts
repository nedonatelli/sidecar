import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace } from 'vscode';

vi.mock('../settings.js', () => ({
  invalidateConfigCache: vi.fn(),
}));

import {
  getCachedApiKey,
  getCachedFallbackApiKey,
  initSecrets,
  setApiKeySecret,
  setFallbackApiKeySecret,
  getHuggingFaceToken,
  setHuggingFaceToken,
  clearHuggingFaceToken,
  getSecretContext,
  storeActiveApiKey,
  _resetSecretsForTests,
} from './secrets.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSecretsStore(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => store.get(key)),
    store: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeContext(secretsStore = makeSecretsStore()): any {
  return { secrets: secretsStore };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  _resetSecretsForTests();
});

// ---------------------------------------------------------------------------
// getCachedApiKey / getCachedFallbackApiKey — before init
// ---------------------------------------------------------------------------

describe('getCachedApiKey / getCachedFallbackApiKey', () => {
  it('returns null before initSecrets', () => {
    expect(getCachedApiKey()).toBeNull();
    expect(getCachedFallbackApiKey()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getSecretContext — before init
// ---------------------------------------------------------------------------

describe('getSecretContext', () => {
  it('returns null before initSecrets', () => {
    expect(getSecretContext()).toBeNull();
  });

  it('returns context after initSecrets', async () => {
    const ctx = makeContext(makeSecretsStore({ 'sidecar.apiKey': 'my-key' }));
    await initSecrets(ctx);
    expect(getSecretContext()).toBe(ctx);
  });
});

// ---------------------------------------------------------------------------
// initSecrets
// ---------------------------------------------------------------------------

describe('initSecrets', () => {
  it('reads existing apiKey from SecretStorage and caches it', async () => {
    const ctx = makeContext(makeSecretsStore({ 'sidecar.apiKey': 'stored-key' }));
    await initSecrets(ctx);
    expect(getCachedApiKey()).toBe('stored-key');
  });

  it('migrates plaintext apiKey from settings when no secret exists', async () => {
    const ctx = makeContext();
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      get: vi.fn((key: string, def: unknown) => (key === 'apiKey' ? 'my-plaintext-key' : def)),
      inspect: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    } as never);

    await initSecrets(ctx);
    expect(ctx.secrets.store).toHaveBeenCalledWith('sidecar.apiKey', 'my-plaintext-key');
    expect(getCachedApiKey()).toBe('my-plaintext-key');
  });

  it('uses default "ollama" value when no secret and plaintext is "ollama"', async () => {
    const ctx = makeContext();
    await initSecrets(ctx);
    // Default mock getConfiguration returns defaultValue, which is 'ollama' for apiKey
    expect(getCachedApiKey()).toBe('ollama');
  });

  it('reads existing fallbackApiKey from SecretStorage and caches it', async () => {
    const ctx = makeContext(makeSecretsStore({ 'sidecar.fallbackApiKey': 'fb-key' }));
    await initSecrets(ctx);
    expect(getCachedFallbackApiKey()).toBe('fb-key');
  });

  it('migrates plaintext fallbackApiKey from settings when no secret exists', async () => {
    const ctx = makeContext();
    vi.spyOn(workspace, 'getConfiguration').mockReturnValue({
      get: vi.fn((key: string, def: unknown) => (key === 'fallbackApiKey' ? 'fb-plain' : def)),
      inspect: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
    } as never);

    await initSecrets(ctx);
    expect(ctx.secrets.store).toHaveBeenCalledWith('sidecar.fallbackApiKey', 'fb-plain');
    expect(getCachedFallbackApiKey()).toBe('fb-plain');
  });

  it('calls invalidateConfigCache after init', async () => {
    const { invalidateConfigCache } = await import('../settings.js');
    const ctx = makeContext(makeSecretsStore({ 'sidecar.apiKey': 'key' }));
    await initSecrets(ctx);
    expect(invalidateConfigCache).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// setApiKeySecret
// ---------------------------------------------------------------------------

describe('setApiKeySecret', () => {
  it('throws when not initialized', async () => {
    await expect(setApiKeySecret('new-key')).rejects.toThrow('not initialized');
  });

  it('stores key and updates cache', async () => {
    const ctx = makeContext(makeSecretsStore({ 'sidecar.apiKey': 'old-key' }));
    await initSecrets(ctx);
    await setApiKeySecret('new-key');
    expect(ctx.secrets.store).toHaveBeenLastCalledWith('sidecar.apiKey', 'new-key');
    expect(getCachedApiKey()).toBe('new-key');
  });
});

// ---------------------------------------------------------------------------
// setFallbackApiKeySecret
// ---------------------------------------------------------------------------

describe('setFallbackApiKeySecret', () => {
  it('throws when not initialized', async () => {
    await expect(setFallbackApiKeySecret('key')).rejects.toThrow('not initialized');
  });

  it('stores key and updates cache', async () => {
    const ctx = makeContext();
    await initSecrets(ctx);
    await setFallbackApiKeySecret('fb-new');
    expect(ctx.secrets.store).toHaveBeenCalledWith('sidecar.fallbackApiKey', 'fb-new');
    expect(getCachedFallbackApiKey()).toBe('fb-new');
  });
});

// ---------------------------------------------------------------------------
// HuggingFace token
// ---------------------------------------------------------------------------

describe('getHuggingFaceToken', () => {
  it('returns undefined before initSecrets', async () => {
    expect(await getHuggingFaceToken()).toBeUndefined();
  });

  it('returns stored token after initSecrets', async () => {
    const ctx = makeContext(makeSecretsStore({ 'sidecar.huggingfaceToken': 'hf-abc123' }));
    await initSecrets(ctx);
    expect(await getHuggingFaceToken()).toBe('hf-abc123');
  });

  it('returns undefined when token not set', async () => {
    const ctx = makeContext();
    await initSecrets(ctx);
    expect(await getHuggingFaceToken()).toBeUndefined();
  });
});

describe('setHuggingFaceToken', () => {
  it('throws when not initialized', async () => {
    await expect(setHuggingFaceToken('tok')).rejects.toThrow('not initialized');
  });

  it('stores the token', async () => {
    const ctx = makeContext();
    await initSecrets(ctx);
    await setHuggingFaceToken('hf-new');
    expect(ctx.secrets.store).toHaveBeenCalledWith('sidecar.huggingfaceToken', 'hf-new');
  });
});

describe('clearHuggingFaceToken', () => {
  it('is a no-op before initSecrets', async () => {
    await expect(clearHuggingFaceToken()).resolves.toBeUndefined();
  });

  it('deletes the token from storage', async () => {
    const ctx = makeContext(makeSecretsStore({ 'sidecar.huggingfaceToken': 'old' }));
    await initSecrets(ctx);
    await clearHuggingFaceToken();
    expect(ctx.secrets.delete).toHaveBeenCalledWith('sidecar.huggingfaceToken');
  });
});

// ---------------------------------------------------------------------------
// storeActiveApiKey
// ---------------------------------------------------------------------------

describe('storeActiveApiKey', () => {
  it('throws when not initialized', async () => {
    await expect(storeActiveApiKey('k')).rejects.toThrow('not initialized');
  });

  it('stores key, updates cache, and calls invalidateConfigCache', async () => {
    const { invalidateConfigCache } = await import('../settings.js');
    const ctx = makeContext(makeSecretsStore({ 'sidecar.apiKey': 'old' }));
    await initSecrets(ctx);
    vi.mocked(invalidateConfigCache).mockClear();
    await storeActiveApiKey('active-key');
    expect(ctx.secrets.store).toHaveBeenCalledWith('sidecar.apiKey', 'active-key');
    expect(getCachedApiKey()).toBe('active-key');
    expect(invalidateConfigCache).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// _resetSecretsForTests
// ---------------------------------------------------------------------------

describe('_resetSecretsForTests', () => {
  it('clears context and caches', async () => {
    const ctx = makeContext(makeSecretsStore({ 'sidecar.apiKey': 'key' }));
    await initSecrets(ctx);
    _resetSecretsForTests();
    expect(getCachedApiKey()).toBeNull();
    expect(getCachedFallbackApiKey()).toBeNull();
    expect(getSecretContext()).toBeNull();
  });
});
