// ---------------------------------------------------------------------------
// Kickstand-token fs mock factory (v0.65 — shared test-helper module).
//
// Two test files (`providerReachability.test.ts`, `kickstandBackend.test.ts`)
// stub the Kickstand token file the same way so assertions on the bearer
// header land deterministically regardless of whether the host has
// `~/.config/kickstand/token` set up. Previously copy-pasted; this helper
// is the single source of truth.
//
// Usage (vi.mock's factory runs lazily, so the dynamic import resolves
// after this module has loaded — no hoisting gymnastics required):
//
//     vi.mock('fs', async () => {
//       const { buildKickstandTokenFsMock } = await import(
//         '../../__tests__/helpers/kickstandToken.js'
//       );
//       const actual = await vi.importActual<typeof import('fs')>('fs');
//       return buildKickstandTokenFsMock(actual);
//     });
// ---------------------------------------------------------------------------

export const DEFAULT_KICKSTAND_TOKEN = 'test-kickstand-token';

export interface KickstandTokenFsMockOptions {
  /** Token value the stubbed `readFileSync` returns. Defaults to `DEFAULT_KICKSTAND_TOKEN`. */
  token?: string;
  /** Substring the file path must contain to trigger the stub. Defaults to `'kickstand/token'`. */
  pathMatcher?: string;
}

type FsModule = typeof import('fs');

/**
 * Build an `fs` mock object that returns the fixed token for any path
 * containing `kickstand/token` and delegates every other read through
 * to the real module. Pass the result of `vi.importActual('fs')` as
 * `actual` so non-token fs calls keep working normally.
 */
export function buildKickstandTokenFsMock(actual: FsModule, options: KickstandTokenFsMockOptions = {}): FsModule {
  const token = options.token ?? DEFAULT_KICKSTAND_TOKEN;
  const matcher = options.pathMatcher ?? 'kickstand/token';
  return {
    ...actual,
    existsSync: ((p: string) => (p.includes(matcher) ? true : actual.existsSync(p))) as typeof actual.existsSync,
    readFileSync: ((p: string, enc?: BufferEncoding) =>
      p.includes(matcher)
        ? token
        : (actual.readFileSync as (p: string, enc?: BufferEncoding) => unknown)(p, enc)) as typeof actual.readFileSync,
  };
}
