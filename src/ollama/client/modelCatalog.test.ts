import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- Mock the backend dependencies (kept lightweight; no real network/AWS) ---
vi.mock('../copilotBackend.js', () => ({
  CopilotBackend: { listAvailableModels: vi.fn() },
}));
vi.mock('../kickstandBackend.js', () => ({
  kickstandHeaders: vi.fn(async () => ({ Authorization: 'Bearer test' })),
}));
vi.mock('../bedrockBackend.js', () => ({
  BedrockBackend: class BedrockBackend {
    async listAnthropicModels(): Promise<string[]> {
      return [];
    }
  },
}));

import {
  listInstalledModelsInner,
  buildLibraryModels,
  pullModelStream,
  discoverAllAvailableModels,
  LIBRARY_MODELS,
  ANTHROPIC_FALLBACK_MODELS,
  BEDROCK_FALLBACK_MODELS,
  type ModelListContext,
} from './modelCatalog.js';
import { CopilotBackend } from '../copilotBackend.js';
import { BedrockBackend } from '../bedrockBackend.js';
import type { ApiBackend } from '../backend.js';

const mockedCopilot = CopilotBackend as unknown as { listAvailableModels: ReturnType<typeof vi.fn> };
// The real BedrockBackend constructor needs args; the vi.mock replaces it with a
// no-arg class at runtime, so cast to a bare constructor for `new`.
const MockBedrock = BedrockBackend as unknown as new () => BedrockBackend;

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data } as unknown as Response;
}

/** A stub backend with no listModels (Ollama/anthropic/kickstand paths). */
const bareBackend = {} as unknown as ApiBackend;

function ctx(overrides: Partial<ModelListContext>): ModelListContext {
  return { provider: 'ollama', baseUrl: 'http://host', apiKey: 'k', backend: bareBackend, ...overrides };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('listInstalledModelsInner — copilot', () => {
  it('lists Copilot models, using name || id', async () => {
    mockedCopilot.listAvailableModels.mockResolvedValueOnce([{ name: 'GPT-4o', id: 'gpt-4o' }, { id: 'gpt-3' }]);
    const result = await listInstalledModelsInner(ctx({ provider: 'copilot' }));
    expect(result).toEqual([
      { name: 'GPT-4o', model: 'gpt-4o', size: 0 },
      { name: 'gpt-3', model: 'gpt-3', size: 0 },
    ]);
  });
});

describe('listInstalledModelsInner — anthropic', () => {
  it('maps fetched models when the API returns some', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [{ id: 'claude-x' }, { id: 'claude-y' }] }));
    const result = await listInstalledModelsInner(ctx({ provider: 'anthropic' }));
    expect(result.map((m) => m.model)).toEqual(['claude-x', 'claude-y']);
  });

  it('falls back to the static catalog when the API returns an empty list', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    const result = await listInstalledModelsInner(ctx({ provider: 'anthropic' }));
    expect(result.map((m) => m.model)).toEqual(ANTHROPIC_FALLBACK_MODELS);
  });

  it('falls back when the response is not ok', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 500));
    const result = await listInstalledModelsInner(ctx({ provider: 'anthropic' }));
    expect(result).toHaveLength(ANTHROPIC_FALLBACK_MODELS.length);
  });

  it('falls back when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network'));
    const result = await listInstalledModelsInner(ctx({ provider: 'anthropic' }));
    expect(result).toHaveLength(ANTHROPIC_FALLBACK_MODELS.length);
  });
});

describe('listInstalledModelsInner — kickstand', () => {
  it('lists only ready (or status-less) models with context length', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse([
        { model_id: 'ready-a', status: 'ready', size_bytes: 100, context_length: 8192 },
        { model_id: 'downloading', status: 'downloading' },
        { model_id: 'no-status', size_bytes: null, context_length: null },
      ]),
    );
    const result = await listInstalledModelsInner(ctx({ provider: 'kickstand' }));
    expect(result).toEqual([
      { name: 'ready-a', model: 'ready-a', size: 100, contextLength: 8192 },
      { name: 'no-status', model: 'no-status', size: 0, contextLength: null },
    ]);
  });

  it('returns [] when the response is not ok', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([], false, 503));
    expect(await listInstalledModelsInner(ctx({ provider: 'kickstand' }))).toEqual([]);
  });

  it('returns [] when fetch throws', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect(await listInstalledModelsInner(ctx({ provider: 'kickstand' }))).toEqual([]);
  });
});

describe('listInstalledModelsInner — bedrock', () => {
  it('uses a live Bedrock query when available', async () => {
    const backend = new MockBedrock();
    vi.spyOn(backend, 'listAnthropicModels').mockResolvedValueOnce(['us.anthropic.claude-a', 'us.anthropic.claude-b']);
    const result = await listInstalledModelsInner(
      ctx({ provider: 'bedrock', backend: backend as unknown as ApiBackend }),
    );
    expect(result.map((m) => m.model)).toEqual(['us.anthropic.claude-a', 'us.anthropic.claude-b']);
  });

  it('falls back to the static list when the live query returns nothing', async () => {
    const backend = new MockBedrock(); // listAnthropicModels → [] by default
    const result = await listInstalledModelsInner(
      ctx({ provider: 'bedrock', backend: backend as unknown as ApiBackend }),
    );
    expect(result.map((m) => m.model)).toEqual(BEDROCK_FALLBACK_MODELS);
  });

  it('falls back when the backend is not a BedrockBackend instance', async () => {
    const result = await listInstalledModelsInner(ctx({ provider: 'bedrock', backend: bareBackend }));
    expect(result.map((m) => m.model)).toEqual(BEDROCK_FALLBACK_MODELS);
  });
});

describe('listInstalledModelsInner — OpenAI-compatible (backend.listModels)', () => {
  it('delegates to the backend and maps id + owned_by', async () => {
    const backend = { listModels: vi.fn(async () => [{ id: 'gpt', owned_by: 'openai' }]) } as unknown as ApiBackend;
    const result = await listInstalledModelsInner(ctx({ provider: 'openai', backend }));
    expect(result[0]).toMatchObject({ name: 'gpt', model: 'gpt', details: { family: 'openai' } });
  });
});

describe('listInstalledModelsInner — Ollama (/api/tags)', () => {
  it('returns the models from /api/tags', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ models: [{ name: 'llama', model: 'llama' }] }));
    const result = await listInstalledModelsInner(ctx({ provider: 'ollama' }));
    expect(result).toEqual([{ name: 'llama', model: 'llama' }]);
    expect(fetchMock).toHaveBeenCalledWith('http://host/api/tags');
  });

  it('returns [] when /api/tags omits the models array', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}));
    expect(await listInstalledModelsInner(ctx({ provider: 'ollama' }))).toEqual([]);
  });

  it('throws when /api/tags is not ok', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 404));
    await expect(listInstalledModelsInner(ctx({ provider: 'ollama' }))).rejects.toThrow('Failed to list models: 404');
  });
});

describe('buildLibraryModels', () => {
  const installed = [{ name: 'llama3:latest', model: 'llama3', contextLength: 4096 }];

  it('marks installed models and preserves context length', () => {
    const result = buildLibraryModels(installed, 'ollama', false);
    expect(result).toEqual([{ name: 'llama3:latest', installed: true, contextLength: 4096 }]);
  });

  it('appends uninstalled library suggestions for Ollama when requested', () => {
    const result = buildLibraryModels(installed, 'ollama', true);
    const suggested = result.filter((m) => !m.installed).map((m) => m.name);
    expect(suggested).toEqual(LIBRARY_MODELS.filter((n) => n !== 'llama3'));
    expect(suggested).not.toContain('llama3'); // already installed → not suggested
  });

  it('does not append suggestions for non-Ollama providers', () => {
    const result = buildLibraryModels(installed, 'openai', true);
    expect(result.every((m) => m.installed)).toBe(true);
  });

  it('does not append suggestions when includeSuggestions is false', () => {
    expect(buildLibraryModels([], 'ollama', false)).toEqual([]);
  });
});

describe('pullModelStream', () => {
  function ndjsonBody(lines: string[]) {
    const enc = new TextEncoder();
    let i = 0;
    return {
      ok: true,
      body: {
        getReader: () => ({
          read: async () =>
            i < lines.length ? { done: false, value: enc.encode(lines[i++] + '\n') } : { done: true, value: undefined },
          cancel: async () => {},
          releaseLock: () => {},
        }),
      },
    } as unknown as Response;
  }

  it('yields parsed progress objects and skips malformed lines', async () => {
    fetchMock.mockResolvedValueOnce(
      ndjsonBody(['{"model":"m","status":"pulling"}', 'not json', '{"model":"m","status":"success"}']),
    );
    const events = [];
    for await (const ev of pullModelStream('http://host/api/pull', 'm')) events.push(ev);
    expect(events).toEqual([
      { model: 'm', status: 'pulling' },
      { model: 'm', status: 'success' },
    ]);
  });

  it('throws when the pull response is not ok', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'err' } as unknown as Response);
    const gen = pullModelStream('http://host/api/pull', 'm');
    await expect(gen.next()).rejects.toThrow('Failed to pull model: 500');
  });

  it('throws when the response has no body', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, body: null } as unknown as Response);
    const gen = pullModelStream('http://host/api/pull', 'm');
    await expect(gen.next()).rejects.toThrow('empty response body');
  });
});

describe('discoverAllAvailableModels', () => {
  it('merges Ollama + Kickstand results and deduplicates by name', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/tags')) return jsonResponse({ models: [{ name: 'shared', model: 'shared' }] });
      if (url.includes('/v1/models')) return jsonResponse({ data: [{ id: 'shared' }, { id: 'kick-only' }] });
      return jsonResponse({});
    });
    const result = await discoverAllAvailableModels('http://ollama', 'http://kick');
    expect(result.map((m) => m.name).sort()).toEqual(['kick-only', 'shared']); // 'shared' not duplicated
  });

  it('skips a backend that is unreachable and returns the other', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/api/tags')) throw new Error('ollama down');
      return jsonResponse({ data: [{ id: 'kick-a' }] });
    });
    const result = await discoverAllAvailableModels('http://ollama', 'http://kick');
    expect(result.map((m) => m.name)).toEqual(['kick-a']);
  });

  it('returns [] when both backends are unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    expect(await discoverAllAvailableModels('http://ollama', 'http://kick')).toEqual([]);
  });
});
