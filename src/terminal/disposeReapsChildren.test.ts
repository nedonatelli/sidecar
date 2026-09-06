import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { ShellSession } from './shellSession.js';

/** True when the pid is still running. `kill(pid, 0)` only probes. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// The claim killProcessTree makes is that disposing a shell also takes out what
// the shell started. Its unit tests only prove the right flags get built; this
// proves the behaviour against a real shell and a real child, because the two
// previous attempts at this leak both looked correct and both did nothing.
describe.skipIf(os.platform() !== 'win32')('dispose reaps children (Windows)', () => {
  it('kills a process the shell spawned, not just the shell', async () => {
    const session = new ShellSession(os.tmpdir());
    // A child that would outlive its parent: 60s of nothing, backgrounded so the
    // shell returns immediately.
    //
    // The child reports its OWN pid rather than the shell's `$!`. Under Git Bash
    // `$!` is an MSYS pid from a private namespace, not a Windows pid, so
    // process.kill() would probe something that never existed -- which is
    // exactly how this test failed the first time and nearly cleared a bug it
    // had not tested.
    const started = await session.execute(
      `node -e "console.log('PID=' + process.pid); setTimeout(function(){}, 60000)" & sleep 1`,
      { timeout: 20_000 },
    );
    const m = /PID=(\d+)/.exec(started.stdout);
    expect(m, `expected a pid in: ${started.stdout}`).not.toBeNull();
    const childPid = Number(m![1]);

    // Sanity: it really is running, or the assertion below proves nothing.
    expect(alive(childPid), 'child should be running before dispose').toBe(true);

    session.dispose();

    // dispose() is synchronous on Windows precisely so callers can act right
    // after it; a small poll only guards against scheduler jitter.
    for (let i = 0; i < 20 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 100));

    expect(alive(childPid), `child ${childPid} survived dispose — the tree was not reaped`).toBe(false);
  }, 40_000);
});
