import { describe, it, expect } from 'vitest';
import { sidecarFetch, OutboundAllowlistError } from './sidecarFetch.js';
import { RateLimitStore } from './rateLimitState.js';
import { useMockFetch } from '../__tests__/helpers/mockFetch.js';

describe('sidecarFetch', () => {
  // `useMockFetch` registers its own beforeEach/afterEach to stub
  // globalThis.fetch and reset call history per test (v0.65 — shared
  // test-helper module). `fetchMock.fn` is the underlying vi.fn so
  // existing `mockResolvedValueOnce` / `mockRejectedValueOnce` calls
  // work unchanged.
  const fetchMock = useMockFetch();
  const mockFetch = fetchMock.fn;

  it('returns the response when no options are supplied', async () => {
    mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await sidecarFetch('http://test/endpoint');
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('passes retry options through to fetchWithRetry', async () => {
    mockFetch
      .mockResolvedValueOnce(new Response('err', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    const res = await sidecarFetch('http://test/endpoint', {}, { retry: { maxAttempts: 2, baseDelayMs: 1 } });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  describe('rate-limit integration', () => {
    it('updates the store from response headers when a parser is provided', async () => {
      const store = new RateLimitStore();
      mockFetch.mockResolvedValueOnce(
        new Response('ok', {
          status: 200,
          headers: { 'x-ratelimit-limit-tokens': '100000', 'x-ratelimit-remaining-tokens': '95000' },
        }),
      );
      await sidecarFetch(
        'http://test/endpoint',
        {},
        {
          rateLimits: store,
          estimatedTokens: 500,
          parseRateLimitHeaders: (h) => ({
            tokensLimit: Number(h.get('x-ratelimit-limit-tokens')),
            tokensRemaining: Number(h.get('x-ratelimit-remaining-tokens')),
          }),
        },
      );
      const snap = store.getSnapshot();
      expect(snap?.tokensLimit).toBe(100000);
      expect(snap?.tokensRemaining).toBe(95000);
    });

    it('does not update the store when no parser is provided', async () => {
      const store = new RateLimitStore();
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await sidecarFetch('http://test/endpoint', {}, { rateLimits: store, estimatedTokens: 100 });
      expect(store.getSnapshot()).toBeNull();
    });

    it('waits when the store reports exhausted budget and unblocks after reset', async () => {
      const store = new RateLimitStore();
      store.update({ tokensLimit: 1000, tokensRemaining: 10, tokensResetSec: 0 });
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      const res = await sidecarFetch(
        'http://test/endpoint',
        {},
        { rateLimits: store, estimatedTokens: 500, maxRateLimitWaitMs: 5_000 },
      );
      expect(res.status).toBe(200);
    });
  });

  describe('outbound allowlist', () => {
    it('allows requests when the allowlist is empty', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      await expect(sidecarFetch('https://unknown.example.com/', {}, { allowlist: [] })).resolves.toBeInstanceOf(
        Response,
      );
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('blocks hosts not in a non-empty allowlist', async () => {
      await expect(
        sidecarFetch('https://attacker.internal/', {}, { allowlist: ['api.openai.com'], label: 'openai' }),
      ).rejects.toBeInstanceOf(OutboundAllowlistError);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('permits exact-hostname matches', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      const res = await sidecarFetch('https://api.openai.com/v1/models', {}, { allowlist: ['api.openai.com'] });
      expect(res.status).toBe(200);
    });

    it('permits subdomain globs with *. prefix', async () => {
      mockFetch.mockResolvedValueOnce(new Response('ok', { status: 200 }));
      const res = await sidecarFetch(
        'https://api-v2.openrouter.ai/v1/chat/completions',
        {},
        { allowlist: ['*.openrouter.ai'] },
      );
      expect(res.status).toBe(200);
    });

    it('throws OutboundAllowlistError with the offending host', async () => {
      let caught: Error | undefined;
      try {
        await sidecarFetch('https://evil.test/', {}, { allowlist: ['api.openai.com'], label: 'openai' });
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).toBeInstanceOf(OutboundAllowlistError);
      expect((caught as OutboundAllowlistError).host).toBe('evil.test');
      expect((caught as OutboundAllowlistError).label).toBe('openai');
      expect(caught?.message).toContain('evil.test');
    });

    it('rejects malformed URLs when an allowlist is active', async () => {
      await expect(sidecarFetch('not-a-url', {}, { allowlist: ['api.openai.com'] })).rejects.toBeInstanceOf(
        OutboundAllowlistError,
      );
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('composition order', () => {
    it('checks allowlist before waiting on rate-limit budget', async () => {
      const store = new RateLimitStore();
      store.update({ tokensLimit: 1000, tokensRemaining: 0, tokensResetSec: 300 }); // huge wait

      const start = Date.now();
      await expect(
        sidecarFetch(
          'https://blocked.test/',
          {},
          {
            allowlist: ['api.openai.com'],
            rateLimits: store,
            estimatedTokens: 500,
            maxRateLimitWaitMs: 5_000,
          },
        ),
      ).rejects.toBeInstanceOf(OutboundAllowlistError);
      // Allowlist-first means we throw instantly, not after the
      // rate-limit wait would have bailed (or slept).
      expect(Date.now() - start).toBeLessThan(200);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
