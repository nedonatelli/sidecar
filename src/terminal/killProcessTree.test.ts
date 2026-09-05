import { describe, it, expect } from 'vitest';
import { killProcessTree } from './shellSession.js';

describe('killProcessTree', () => {
  it('kills the whole tree on Windows, not just the named process', () => {
    // /T is the entire point: run_command starts python and node INSIDE the
    // shell, and killing the shell alone leaves them running with the working
    // directory still open.
    const calls: { cmd: string; args: string[] }[] = [];
    const handled = killProcessTree(1234, true, (cmd, args) => calls.push({ cmd, args }));

    expect(handled).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cmd).toBe('taskkill');
    expect(calls[0].args).toEqual(['/pid', '1234', '/T', '/F']);
  });

  it('declines on non-Windows so the signal path stays in charge', () => {
    // POSIX kills are left exactly as they were: there is no measured orphan
    // problem there, and switching to detached process groups to get the same
    // effect would change signal handling for every shell the product runs.
    const calls: string[] = [];
    const handled = killProcessTree(1234, false, (cmd) => calls.push(cmd));

    expect(handled).toBe(false);
    expect(calls).toEqual([]);
  });

  it('declines when there is no pid', () => {
    const calls: string[] = [];
    expect(killProcessTree(undefined, true, (cmd) => calls.push(cmd))).toBe(false);
    expect(calls).toEqual([]);
  });

  it('declines when taskkill fails, so the caller still sends signals', () => {
    // An already-exited process makes taskkill exit non-zero. That must not be
    // reported as "handled", or dispose would skip its fallback entirely.
    const handled = killProcessTree(1234, true, () => {
      throw new Error('ERROR: The process "1234" not found.');
    });
    expect(handled).toBe(false);
  });
});
