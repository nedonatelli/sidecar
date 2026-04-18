// ---------------------------------------------------------------------------
// `util.promisify(child_process.exec)` shim factory
// (v0.65 — shared test-helper module).
//
// `eventHooks.test.ts` and `lintFix.test.ts` both run code that
// awaits `execAsync(cmd, opts)` — Node's idiomatic
// `promisify(child_process.exec)` wrapper — and want to observe or
// script the callback. Both previously re-declared identical
// `vi.mock('util')` factories to implement the promisify → callback
// bridge; this helper centralizes the bridge logic.
//
// `vi.mock` is hoisted above imports, so the helper can't be loaded
// synchronously at the top of a test file. Callers combine:
//
//   1. `vi.hoisted(() => ({ exec: vi.fn() }))` to create the shared
//      exec vi.fn above the vi.mock calls.
//   2. `vi.mock('child_process', () => ({ exec }))` to install the
//      vi.fn as the exec export.
//   3. `vi.mock('util', async () => { ... createPromisifyShim(exec) })`
//      to install a promisify wrapper that routes through the same
//      exec vi.fn.
//
// See `eventHooks.test.ts` for the canonical callsite.
// ---------------------------------------------------------------------------

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;
type CallbackStyleExec = (cmd: string, opts: unknown, cb: ExecCallback) => void;

export type PromisifyShim = (
  fn: unknown,
) => (cmd: string, opts?: unknown) => Promise<{ stdout: string; stderr: string }>;

/**
 * Build the `util.promisify` wrapper that forwards every awaited
 * `execAsync(cmd, opts)` through the caller's exec vi.fn. The returned
 * shim ignores its `fn` argument (Node's real promisify reads from the
 * function, but for the mocked path we always route through the
 * passed-in `exec`) so the test's `vi.fn.mockImplementation((cmd, opts, cb)
 * => cb(...))` drives the behavior.
 *
 * Unmocked callback → resolves with `{ stdout: '', stderr: '' }` so a
 * test that forgets to script an exec response sees "command did
 * nothing" instead of hanging forever on a promise that's never
 * resolved.
 */
export function createPromisifyShim(exec: CallbackStyleExec): PromisifyShim {
  return (_fn: unknown) => {
    return async (cmd: string, opts?: unknown): Promise<{ stdout: string; stderr: string }> => {
      return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        let settled = false;
        const callback: ExecCallback = (err, stdout, stderr) => {
          settled = true;
          if (err) reject(err);
          else resolve({ stdout: stdout ?? '', stderr: stderr ?? '' });
        };
        exec(cmd, opts, callback);
        // A bare `vi.fn()` with no scripted implementation returns
        // undefined synchronously without calling the callback —
        // short-circuit so the promise doesn't hang on unmocked calls.
        if (!settled) resolve({ stdout: '', stderr: '' });
      });
    };
  };
}
