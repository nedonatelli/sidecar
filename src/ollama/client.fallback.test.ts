import { describe, it, expect, vi, beforeEach } from 'vitest';
import { circuitBreaker } from './circuitBreaker.js';
import { SideCarClient } from './client.js';

// ---------------------------------------------------------------------------
// Integration tests for the retry / circuit-breaker / fallback interplay in
// SideCarClient. These exercise the *composition* of the three resilience
// layers end-to-end (previously only their pieces were unit-tested):
//   - FALLBACK_THRESHOLD = 2 → a single failure never switches providers
//   - 2 consecutive failures → switch to the configured fallback backend
//   - both primary and fallback failing → the error propagates (not silent)
//   - a success while on the fallback → switch back to primary
//
// getConfig is mocked so we can inject a fallback backend URL; the circuit
// breaker singleton is reset between tests so state doesn't leak.
// ---------------------------------------------------------------------------

const PRIMARY_URL = 'http://localhost:11434';
const FALLBACK_URL = 'http://localhost:11500';

const h = vi.hoisted(() => ({ overrides: {} as Record<string, unknown> }));

vi.mock('../config/settings.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  const realGetConfig = actual.getConfig as () => Record<string, unknown>;
  return { ...actual, getConfig: () => ({ ...realGetConfig(), ...h.overrides }) };
});

// Collapse the HTTP retry layer to a single shot. The retry/backoff lives
// BELOW the fallback + circuit-breaker logic under test here, and its real
// setTimeout backoff (1s, 2s) would otherwise blow the test timeout.
vi.mock('./retry.js', async (importActual) => {
  const actual = (await importActual()) as Record<string, unknown>;
  return { ...actual, fetchWithRetry: (url: string, init: RequestInit) => fetch(url, init) };
});

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function okChat(content: string) {
  return {
    ok: true,
    json: async () => ({ model: 'm', message: { role: 'assistant', content }, done: true }),
  };
}

/**
 * Routes mock responses by URL. The primary backend's success/failure is
 * controlled by the mutable `primaryFails` flag; the fallback always succeeds
 * and the local health probe (/api/tags) always reports reachable.
 */
function installRouter(state: { primaryFails: boolean }) {
  mockFetch.mockImplementation(async (url: unknown) => {
    const u = String(url);
    if (u.includes('/api/tags')) return { ok: true, json: async () => ({ models: [] }) }; // health probe
    if (u.includes(':11500')) return okChat('FALLBACK');
    // primary
    if (state.primaryFails) throw new Error('Network error');
    return okChat('PRIMARY');
  });
}

function chatUrls(): string[] {
  return mockFetch.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/chat'));
}

describe('SideCarClient — retry/fallback interplay', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    circuitBreaker.reset();
    h.overrides = {
      // Pin the provider so both primary and the :11500 fallback resolve to the
      // Ollama backend (auto-detection keys on port 11434 only).
      provider: 'ollama',
      fallbackBaseUrl: FALLBACK_URL,
      fallbackApiKey: 'ollama',
      fallbackModel: 'fb-model',
    };
  });

  it('does not switch to fallback on the first failure (threshold = 2)', async () => {
    const state = { primaryFails: true };
    installRouter(state);
    const client = new SideCarClient('m', PRIMARY_URL, 'ollama');

    await expect(client.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow('Network error');

    // No request should have reached the fallback backend yet.
    expect(chatUrls().some((u) => u.includes(':11500'))).toBe(false);
  });

  it('switches to the fallback backend after 2 consecutive failures and serves its result', async () => {
    const state = { primaryFails: true };
    installRouter(state);
    const client = new SideCarClient('m', PRIMARY_URL, 'ollama');

    // First failure throws (threshold not yet reached).
    await expect(client.complete([{ role: 'user', content: 'a' }])).rejects.toThrow();

    // Second failure trips the threshold → switch → fallback serves the result.
    const result = await client.complete([{ role: 'user', content: 'b' }]);
    expect(result).toBe('FALLBACK');
    expect(chatUrls().some((u) => u.includes(':11500'))).toBe(true);
  });

  it('propagates the error when both primary and fallback fail', async () => {
    // Primary fails, and the fallback also fails on its /api/chat call.
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/tags')) return { ok: true, json: async () => ({ models: [] }) };
      throw new Error(u.includes(':11500') ? 'Fallback down' : 'Primary down');
    });
    const client = new SideCarClient('m', PRIMARY_URL, 'ollama');

    await expect(client.complete([{ role: 'user', content: 'a' }])).rejects.toThrow();
    // Second call switches to fallback, which also fails — must surface, not swallow.
    await expect(client.complete([{ role: 'user', content: 'b' }])).rejects.toThrow('Fallback down');
  });

  it('switches back to the primary backend once it recovers', async () => {
    const state = { primaryFails: true };
    installRouter(state);
    const client = new SideCarClient('m', PRIMARY_URL, 'ollama');

    await expect(client.complete([{ role: 'user', content: 'a' }])).rejects.toThrow();
    expect(await client.complete([{ role: 'user', content: 'b' }])).toBe('FALLBACK'); // now on fallback

    // Primary recovers. The next successful request flips usingFallback off via
    // recordSuccess() → switchToPrimary(), so a subsequent call hits the primary.
    state.primaryFails = false;
    await client.complete([{ role: 'user', content: 'c' }]); // success on fallback → triggers switch-back
    mockFetch.mockClear();
    const result = await client.complete([{ role: 'user', content: 'd' }]);

    expect(result).toBe('PRIMARY');
    expect(chatUrls().every((u) => u.includes(':11434'))).toBe(true);
  });

  it('does not switch on a permanent (auth) error — surfaces a config error instead', async () => {
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/tags')) return { ok: true, json: async () => ({ models: [] }) };
      throw new Error('401 unauthorized');
    });
    const client = new SideCarClient('m', PRIMARY_URL, 'ollama');

    await expect(client.complete([{ role: 'user', content: 'a' }])).rejects.toThrow();
    await expect(client.complete([{ role: 'user', content: 'b' }])).rejects.toThrow();
    // Permanent errors must never switch to the fallback (it won't fix auth).
    expect(chatUrls().some((u) => u.includes(':11500'))).toBe(false);
  });
});
