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
//   - while on the fallback, the primary is retried only after a recheck
//     interval, and a failed recheck goes straight back to the fallback
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

  it('switches back to the primary once it recovers, after the recheck interval', async () => {
    const state = { primaryFails: true };
    installRouter(state);
    const client = new SideCarClient('m', PRIMARY_URL, 'ollama');
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => t);

    await expect(client.complete([{ role: 'user', content: 'a' }])).rejects.toThrow();
    expect(await client.complete([{ role: 'user', content: 'b' }])).toBe('FALLBACK'); // now on fallback

    state.primaryFails = false;
    t += 121_000; // past the recheck interval
    await client.complete([{ role: 'user', content: 'c' }]); // fallback success → recheck the primary next
    mockFetch.mockClear();
    const result = await client.complete([{ role: 'user', content: 'd' }]);

    expect(result).toBe('PRIMARY');
    expect(chatUrls().every((u) => u.includes(':11434'))).toBe(true);
    now.mockRestore();
  });

  // #111: one fallback success switched straight back to the still-dead
  // primary, so the user got an error every third request.
  it('stays on the fallback while the primary is still down', async () => {
    installRouter({ primaryFails: true });
    const client = new SideCarClient('m', PRIMARY_URL, 'ollama');

    await expect(client.complete([{ role: 'user', content: 'a' }])).rejects.toThrow();
    for (const msg of ['b', 'c', 'd', 'e', 'f']) {
      expect(await client.complete([{ role: 'user', content: msg }])).toBe('FALLBACK');
    }
  });

  it('returns to the fallback at once when a recheck of the primary fails', async () => {
    installRouter({ primaryFails: true });
    const client = new SideCarClient('m', PRIMARY_URL, 'ollama');
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => t);

    await expect(client.complete([{ role: 'user', content: 'a' }])).rejects.toThrow();
    expect(await client.complete([{ role: 'user', content: 'b' }])).toBe('FALLBACK');
    t += 121_000;
    expect(await client.complete([{ role: 'user', content: 'c' }])).toBe('FALLBACK'); // schedules the recheck
    // The recheck hits the dead primary and falls back in the same call.
    expect(await client.complete([{ role: 'user', content: 'd' }])).toBe('FALLBACK');
    now.mockRestore();
  });

  // #111: the streamChat fallback was sent the PRIMARY's model name.
  it('streams from the fallback with the fallback model', async () => {
    const bodies: Array<{ url: string; model?: string }> = [];
    mockFetch.mockImplementation(async (url: unknown, init?: { body?: string }) => {
      const u = String(url);
      if (u.includes('/api/tags')) return { ok: true, json: async () => ({ models: [] }) };
      const body = init?.body ? (JSON.parse(init.body) as { model?: string }) : {};
      bodies.push({ url: u, model: body.model });
      if (u.includes(':11434')) throw new Error('Network error');
      const line = JSON.stringify({ model: 'fb-model', message: { role: 'assistant', content: 'hi' }, done: true });
      return { ok: true, body: new Response(line + '\n').body };
    });
    const client = new SideCarClient('primary-model', PRIMARY_URL, 'ollama');
    const drain = async () => {
      for await (const _ of client.streamChat([{ role: 'user', content: 'x' }])) void _;
    };
    await expect(drain()).rejects.toThrow();
    await drain(); // second failure switches to the fallback and retries there
    const fallbackCall = bodies.find((b) => b.url.includes(':11500'));
    expect(fallbackCall?.model).toBe('fb-model');
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

describe('SideCarClient — streamChat failure handling (#111)', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    circuitBreaker.reset();
    h.overrides = {
      provider: 'ollama',
      fallbackBaseUrl: FALLBACK_URL,
      fallbackApiKey: 'ollama',
      fallbackModel: 'fb-model',
    };
  });

  /** An NDJSON body that sends `lines`, then fails mid-stream. */
  function failingAfter(lines: string[]) {
    const enc = new TextEncoder();
    // pull, not start: error() discards chunks still queued, so the lines
    // must be read before the stream fails.
    let sent = false;
    return new ReadableStream<Uint8Array>({
      pull(c) {
        if (!sent) {
          sent = true;
          for (const l of lines) c.enqueue(enc.encode(l + '\n'));
        } else {
          c.error(new Error('connection reset'));
        }
      },
    });
  }

  it('does not replay a request whose content had already streamed', async () => {
    const partial = JSON.stringify({ model: 'm', message: { role: 'assistant', content: 'Hello ' }, done: false });
    mockFetch.mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/tags')) return { ok: true, json: async () => ({ models: [] }) };
      if (u.includes(':11500')) {
        const line = JSON.stringify({ model: 'fb', message: { role: 'assistant', content: 'Hello ' }, done: true });
        return { ok: true, body: new Response(line + '\n').body };
      }
      return { ok: true, body: failingAfter([partial]) };
    });
    const client = new SideCarClient('m', PRIMARY_URL, 'ollama');
    const run = async () => {
      const texts: string[] = [];
      try {
        for await (const e of client.streamChat([{ role: 'user', content: 'x' }]))
          if (e.type === 'text') texts.push(e.text);
      } catch {
        /* expected */
      }
      return texts;
    };
    await run(); // first failure
    const texts = await run(); // second failure would switch to the fallback and replay
    expect(texts.join('')).toBe('Hello ');
    expect(chatUrls().some((u) => u.includes(':11500'))).toBe(false);
  });

  it('frees a half-open probe when the caller stops reading the stream', async () => {
    h.overrides = { provider: 'ollama', fallbackBaseUrl: '' };
    const now = vi.spyOn(Date, 'now');
    let t = 1_000_000;
    now.mockImplementation(() => t);
    let healthy = false;
    mockFetch.mockImplementation(async () => {
      if (!healthy) throw new Error('Network error');
      const lines = ['a', 'b'].map((c, i) =>
        JSON.stringify({ model: 'm', message: { role: 'assistant', content: c }, done: i === 1 }),
      );
      return { ok: true, body: new Response(lines.join('\n') + '\n').body, json: async () => JSON.parse(lines[1]) };
    });
    const client = new SideCarClient('m', PRIMARY_URL, 'ollama');
    for (let i = 0; i < 5; i++) await expect(client.complete([{ role: 'user', content: 'x' }])).rejects.toThrow();
    t += 16_000; // cooldown over → half-open
    healthy = true;
    for await (const _ of client.streamChat([{ role: 'user', content: 'x' }])) {
      void _;
      break; // the caller abandons the probe after its first event
    }
    // The next request is allowed through instead of failing on an open circuit.
    await expect(client.complete([{ role: 'user', content: 'x' }])).resolves.toBeDefined();
    now.mockRestore();
  });
});
