import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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

// disposeReapsChildren.test.ts proves dispose() takes the shell's children with
// it. This proves the same for the TIMEOUT path, which was a bare proc.kill()
// -- the one place a hung command is actually killed, and on Windows the one
// place that manufactured orphans: a python in a GUI event loop, a wedged
// pytest, each surviving its shell, holding a clone directory as its cwd, and
// costing the next run four tasks to EPERM before the model was asked anything.
describe.skipIf(os.platform() !== 'win32')('timeout reaps children (Windows)', () => {
  it('kills the process a timed-out command started, not just the shell', async () => {
    const session = new ShellSession(os.tmpdir());
    // The child reports its pid through a FILE, not stdout: a foreground
    // command's output only reaches the caller when the command completes,
    // and this one never does -- that is the point.
    const pidFile = path.join(os.tmpdir(), `reap-${process.pid}-${Date.now()}.pid`);
    try {
      // A command that records its child's pid and then never returns: exactly
      // the shape of `python test_slider.py` sitting in plt.show(). Idle timeout
      // is short so the test is quick; the child would live 60s if left alone.
      const script = `require('fs').writeFileSync(${JSON.stringify(pidFile.replace(/\\/g, '/'))}, String(process.pid)); setTimeout(function(){}, 60000)`;
      const result = await session.execute(`node -e "${script.replace(/"/g, '\\"')}"`, { timeout: 1_500 });
      expect(result.timedOut).toBe(true);
      expect(fs.existsSync(pidFile), `child never wrote ${pidFile}`).toBe(true);
      const childPid = Number(fs.readFileSync(pidFile, 'utf-8').trim());
      expect(childPid).toBeGreaterThan(0);

      for (let i = 0; i < 30 && alive(childPid); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(childPid), `child ${childPid} survived the timeout kill — the tree was not reaped`).toBe(false);
    } finally {
      session.dispose();
      fs.rmSync(pidFile, { force: true });
    }
  }, 40_000);
});
