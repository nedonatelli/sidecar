import { describe, it, expect } from 'vitest';
import * as os from 'os';
import { ShellSession } from './terminal/shellSession.js';
import { deactivate } from './extension.js';

/** True when the pid is still running. `kill(pid, 0)` only probes. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Start a 60 s node child in the session's shell and return its Windows pid. */
async function startChild(session: ShellSession): Promise<number> {
  // The child prints its own pid: Git Bash's `$!` is an MSYS pid, not a Windows
  // one (see disposeReapsChildren.test.ts).
  const started = await session.execute(
    `node -e "console.log('PID=' + process.pid); setTimeout(function(){}, 60000)" & sleep 1`,
    { timeout: 20_000 },
  );
  const m = /PID=(\d+)/.exec(started.stdout);
  expect(m, `expected a pid in: ${started.stdout}`).not.toBeNull();
  return Number(m![1]);
}

// deactivate() used to dispose only the default runtime's shell. A background
// agent or a shadow run owns a separate session and disposes it in a `finally`
// that runs once the aborted run unwinds, which is after deactivate returns and
// possibly never (#245). This builds such a session directly, the way
// `new ToolRuntime()` does, and checks deactivate takes its tree down.
describe.skipIf(os.platform() !== 'win32')('deactivate kills every agent shell (Windows)', () => {
  it('reaps a session the default runtime does not own', async () => {
    const session = new ShellSession(os.tmpdir());
    const childPid = await startChild(session);
    expect(alive(childPid), 'child should be running before deactivate').toBe(true);

    deactivate();

    for (let i = 0; i < 20 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 100));
    expect(alive(childPid), `child ${childPid} survived deactivate`).toBe(false);
    expect(session.isAlive, 'the session should be disposed').toBe(false);
  }, 40_000);
});
