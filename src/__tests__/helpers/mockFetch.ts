// ---------------------------------------------------------------------------
// `vi.stubGlobal('fetch', ...)` helper (v0.65 — shared test-helper module).
//
// Most backend + tool tests need the same three-line boilerplate to
// intercept global `fetch`:
//
//     const mockFetch = vi.fn();
//     beforeEach(() => vi.stubGlobal('fetch', mockFetch));
//     afterEach(() => vi.unstubAllGlobals());
//
// Plus a `mockFetch.mockReset()` in every `beforeEach` to clear
// call history + queued responses from the previous case. This helper
// folds all of it into one call.
//
// Usage:
//
//     const fetchMock = useMockFetch();
//     // inside a test:
//     fetchMock.respondOnceWithJson({ foo: 'bar' });
//     fetchMock.respondOnceWithStatus(500, 'server exploded');
//     // ...code under test calls fetch N times...
//     expect(fetchMock.calls).toHaveLength(N);
//     expect(fetchMock.lastUrl()).toBe('https://expected.example/');
//
// The helper registers its own `beforeEach` + `afterEach` so a caller
// only needs the top-level `useMockFetch()` line; no per-test plumbing.
// ---------------------------------------------------------------------------

import { vi, beforeEach, afterEach } from 'vitest';

export interface MockFetchHandle {
  /** Underlying `vi.fn()` — use for custom `mockImplementation` / `mockResolvedValue` overrides. */
  fn: ReturnType<typeof vi.fn>;
  /** Queue a JSON response for the next fetch call. */
  respondOnceWithJson(body: unknown, init?: ResponseInit): void;
  /** Queue a non-2xx status response for the next fetch call. */
  respondOnceWithStatus(status: number, bodyText?: string, init?: ResponseInit): void;
  /** Queue a text/plain response for the next fetch call. */
  respondOnceWithText(bodyText: string, init?: ResponseInit): void;
  /** Queue a pre-built Response for the next fetch call. */
  respondOnceWithResponse(response: Response): void;
  /** Queue a fetch-level rejection for the next fetch call (network error, abort, etc.). */
  rejectOnceWith(err: Error): void;
  /** Raw calls seen — each entry is the `[url, init]` tuple passed to fetch. */
  readonly calls: Array<[string | URL | Request, RequestInit | undefined]>;
  /** URL from the most recent fetch call, as a string. */
  lastUrl(): string;
  /** RequestInit from the most recent fetch call. */
  lastInit(): RequestInit | undefined;
}

/**
 * Set up a global-fetch stub for the surrounding describe block. Must
 * be called at describe-block scope (not inside `it`), because it
 * registers its own `beforeEach`/`afterEach` hooks. Returns a handle
 * for queuing responses + inspecting calls.
 */
export function useMockFetch(): MockFetchHandle {
  const fn = vi.fn();
  const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];

  beforeEach(() => {
    fn.mockReset();
    calls.length = 0;
    fn.mockImplementation((...args) => {
      calls.push([args[0] as string | URL | Request, args[1] as RequestInit | undefined]);
      // No scripted response — a test that forgot to queue one will
      // see `undefined` from the first `await fetch(...)`, which
      // throws a clear "Cannot read properties of undefined" that
      // points directly at a missing `respondOnceWith*` call.
      return undefined;
    });
    vi.stubGlobal('fetch', fn);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const handle: MockFetchHandle = {
    fn,
    calls,
    respondOnceWithJson(body, init) {
      fn.mockImplementationOnce(async (...args) => {
        calls.push([args[0] as string | URL | Request, args[1] as RequestInit | undefined]);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          ...init,
        });
      });
    },
    respondOnceWithStatus(status, bodyText = '', init) {
      fn.mockImplementationOnce(async (...args) => {
        calls.push([args[0] as string | URL | Request, args[1] as RequestInit | undefined]);
        return new Response(bodyText, { status, ...init });
      });
    },
    respondOnceWithText(bodyText, init) {
      fn.mockImplementationOnce(async (...args) => {
        calls.push([args[0] as string | URL | Request, args[1] as RequestInit | undefined]);
        return new Response(bodyText, {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
          ...init,
        });
      });
    },
    respondOnceWithResponse(response) {
      fn.mockImplementationOnce(async (...args) => {
        calls.push([args[0] as string | URL | Request, args[1] as RequestInit | undefined]);
        return response;
      });
    },
    rejectOnceWith(err) {
      fn.mockImplementationOnce(async (...args) => {
        calls.push([args[0] as string | URL | Request, args[1] as RequestInit | undefined]);
        throw err;
      });
    },
    lastUrl() {
      const last = calls[calls.length - 1];
      if (!last) throw new Error('useMockFetch: no fetch calls recorded yet');
      return typeof last[0] === 'string' ? last[0] : last[0] instanceof URL ? last[0].toString() : last[0].url;
    },
    lastInit() {
      const last = calls[calls.length - 1];
      if (!last) throw new Error('useMockFetch: no fetch calls recorded yet');
      return last[1];
    },
  };
  return handle;
}
