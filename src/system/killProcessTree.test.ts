import { describe, it, expect, vi } from 'vitest';
import { killProcessTree, signalProcessGroup } from './killProcessTree.js';

describe('signalProcessGroup (#260)', () => {
  it('signals the negative pid, which is the whole group the pid leads', () => {
    const kill = vi.fn();
    expect(signalProcessGroup(4242, 'SIGTERM', kill)).toBe(true);
    expect(kill).toHaveBeenCalledWith(-4242, 'SIGTERM');
  });

  it('returns false when the group is gone (ESRCH) or there is no pid', () => {
    const gone = vi.fn(() => {
      throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
    });
    expect(signalProcessGroup(4242, 'SIGKILL', gone)).toBe(false);
    expect(signalProcessGroup(undefined, 'SIGKILL', vi.fn())).toBe(false);
  });
});

describe('killProcessTree', () => {
  it('runs taskkill /T /F on Windows and does nothing elsewhere', () => {
    const exec = vi.fn();
    expect(killProcessTree(7, true, exec)).toBe(true);
    expect(exec).toHaveBeenCalledWith('taskkill', ['/pid', '7', '/T', '/F']);
    expect(killProcessTree(7, false, exec)).toBe(false);
    expect(exec).toHaveBeenCalledTimes(1);
  });
});
