import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { workspace } from 'vscode';

// Covers the profile-application surface (config writes + SecretStorage copy +
// Kickstand model probe) and providerDisplayLabel. secrets.js / settings.js /
// the workspace config are mocked so we assert the writes without a live host.

const secrets = vi.hoisted(() => ({
  getSecretContext: vi.fn(),
  storeActiveApiKey: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('./secrets.js', () => secrets);

const settings = vi.hoisted(() => ({ invalidateConfigCache: vi.fn() }));
vi.mock('../settings.js', () => settings);

import { applyBackendProfile, setProfileApiKey, providerDisplayLabel, type BackendProfile } from './backends.js';

function makeProfile(over: Partial<BackendProfile> = {}): BackendProfile {
  return {
    id: 'anthropic',
    name: 'Anthropic',
    provider: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    defaultModel: 'claude-haiku-4-5',
    secretKey: 'sidecar.profileKey.anthropic',
    description: 'Claude',
    ...over,
  };
}

function fakeCtx(stored: Record<string, string> = {}) {
  return {
    secrets: {
      get: vi.fn(async (k: string) => stored[k]),
      store: vi.fn(async () => undefined),
    },
  };
}

let updateSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  updateSpy = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(workspace, 'getConfiguration').mockReturnValue({ get: vi.fn(), update: updateSpy } as never);
  secrets.storeActiveApiKey.mockResolvedValue(undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('providerDisplayLabel', () => {
  it('maps every provider to its display label', () => {
    const cases: Array<[Parameters<typeof providerDisplayLabel>[0], string]> = [
      ['ollama', 'Ollama'],
      ['anthropic', 'Anthropic'],
      ['openai', 'OpenAI'],
      ['kickstand', 'Kickstand'],
      ['openrouter', 'OpenRouter'],
      ['groq', 'Groq'],
      ['fireworks', 'Fireworks'],
      ['bedrock', 'AWS Bedrock'],
      ['gemini', 'Gemini'],
      ['copilot', 'GitHub Copilot'],
    ];
    for (const [provider, label] of cases) expect(providerDisplayLabel(provider)).toBe(label);
  });
});

describe('applyBackendProfile', () => {
  it('throws when SecretStorage is not initialized', async () => {
    secrets.getSecretContext.mockReturnValue(null);
    await expect(applyBackendProfile(makeProfile())).rejects.toThrow('SecretStorage not initialized');
  });

  it('writes provider/baseUrl/model and copies the stored key into the active slot', async () => {
    secrets.getSecretContext.mockReturnValue(fakeCtx({ 'sidecar.profileKey.anthropic': 'sk-abc' }));
    const result = await applyBackendProfile(makeProfile());

    expect(result.status).toBe('applied');
    expect(updateSpy).toHaveBeenCalledWith('provider', 'anthropic', true);
    expect(updateSpy).toHaveBeenCalledWith('baseUrl', 'https://api.anthropic.com', true);
    expect(updateSpy).toHaveBeenCalledWith('model', 'claude-haiku-4-5', true);
    expect(secrets.storeActiveApiKey).toHaveBeenCalledWith('sk-abc');
  });

  it('returns missing-key when the profile has a secretKey but nothing is stored', async () => {
    secrets.getSecretContext.mockReturnValue(fakeCtx()); // nothing stored
    const result = await applyBackendProfile(makeProfile());

    expect(result.status).toBe('missing-key');
    expect(settings.invalidateConfigCache).toHaveBeenCalled();
    expect(secrets.storeActiveApiKey).not.toHaveBeenCalled();
  });

  it('resets the active key to the "ollama" sentinel for a keyless local profile', async () => {
    secrets.getSecretContext.mockReturnValue(fakeCtx());
    const result = await applyBackendProfile(
      makeProfile({ id: 'ollama', provider: 'ollama', baseUrl: 'http://localhost:11434', secretKey: null }),
    );

    expect(result.status).toBe('applied');
    expect(secrets.storeActiveApiKey).toHaveBeenCalledWith('ollama');
  });

  it('probes Kickstand for its first loaded model when the profile has no default', async () => {
    secrets.getSecretContext.mockReturnValue(fakeCtx());
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: 'qwen3-coder:30b' }] }) });
    vi.stubGlobal('fetch', fetchMock);

    const result = await applyBackendProfile(
      makeProfile({
        id: 'kickstand',
        provider: 'kickstand',
        baseUrl: 'http://localhost:11435',
        defaultModel: '',
        secretKey: null,
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith('http://localhost:11435/v1/models', expect.any(Object));
    expect(updateSpy).toHaveBeenCalledWith('model', 'qwen3-coder:30b', true);
    expect(result.message).toContain('qwen3-coder:30b');
    vi.unstubAllGlobals();
  });

  it('tolerates a failed Kickstand probe (no model set, still applied)', async () => {
    secrets.getSecretContext.mockReturnValue(fakeCtx());
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connection refused')));
    const result = await applyBackendProfile(
      makeProfile({ provider: 'kickstand', baseUrl: 'http://localhost:11435', defaultModel: '', secretKey: null }),
    );
    expect(result.status).toBe('applied');
    // no model → the 'model' key is never written
    expect(updateSpy).not.toHaveBeenCalledWith('model', expect.anything(), true);
    vi.unstubAllGlobals();
  });
});

describe('setProfileApiKey', () => {
  it('stores the key under the profile secret and the active slot', async () => {
    const ctx = fakeCtx();
    secrets.getSecretContext.mockReturnValue(ctx);
    await setProfileApiKey(makeProfile(), 'sk-new');
    expect(ctx.secrets.store).toHaveBeenCalledWith('sidecar.profileKey.anthropic', 'sk-new');
    expect(secrets.storeActiveApiKey).toHaveBeenCalledWith('sk-new');
  });

  it('is a no-op when the profile has no secretKey', async () => {
    const ctx = fakeCtx();
    secrets.getSecretContext.mockReturnValue(ctx);
    await setProfileApiKey(makeProfile({ secretKey: null }), 'sk-new');
    expect(ctx.secrets.store).not.toHaveBeenCalled();
    expect(secrets.storeActiveApiKey).not.toHaveBeenCalled();
  });

  it('throws when SecretStorage is not initialized', async () => {
    secrets.getSecretContext.mockReturnValue(null);
    await expect(setProfileApiKey(makeProfile(), 'sk-new')).rejects.toThrow('SecretStorage not initialized');
  });
});
