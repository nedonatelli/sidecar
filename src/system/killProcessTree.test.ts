import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import {
  killProcessTree,
  signalProcessGroup,
  msysPsPath,
  killMsysProcessGroup,
  msysStartBounds,
} from './killProcessTree.js';

// `ps -W -l` from Git for Windows, trimmed: a session bash (75006) leads group
// 75006 with the sh it forked and the node that sh started; an unrelated shell
// (74900) and a Windows-only process (no group) are in the same listing.
const PS_LISTING = [
  '      PID    PPID    PGID     WINPID   TTY         UID    STIME COMMAND',
  '  4201120       0       0       6816  ?              0 08:21:51 C:\\Program Files\\Git\\bin\\bash.exe',
  '    74900       1   74900      20992  ?         197609 08:21:51 /usr/bin/bash',
  '    75006       1   75006      38864  ?         197609 08:30:02 /usr/bin/bash',
  'I   75007   75006   75006      41564  ?         197609 08:30:02 /usr/bin/sh',
  '    75008   75007   75006      46164  ?         197609 08:30:02 /c/Program Files/nodejs/node',
].join('\n');

describe('killMsysProcessGroup (#245)', () => {
  it('taskkills every member of the group, by Windows PID, and nothing else', () => {
    const exec = vi.fn();
    expect(killMsysProcessGroup(75006, 'ps.exe', () => PS_LISTING, exec)).toBe(3);
    expect(exec.mock.calls).toEqual([
      ['taskkill', ['/pid', '38864', '/T', '/F']],
      ['taskkill', ['/pid', '41564', '/T', '/F']],
      ['taskkill', ['/pid', '46164', '/T', '/F']],
    ]);
  });

  it('keeps going when a member is already gone', () => {
    const exec = vi.fn(() => {
      throw new Error('not found');
    });
    expect(killMsysProcessGroup(75006, 'ps.exe', () => PS_LISTING, exec)).toBe(3);
    expect(exec).toHaveBeenCalledTimes(3);
  });

  it('finds nothing for a group that is not listed', () => {
    const exec = vi.fn();
    expect(killMsysProcessGroup(1234, 'ps.exe', () => PS_LISTING, exec)).toBe(0);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('msysPsPath (#245)', () => {
  const git = path.join('C:', 'Program Files', 'Git');
  it("finds usr\\bin\\ps.exe for Git for Windows' bin\\bash.exe launcher", () => {
    const want = path.join(git, 'usr', 'bin', 'ps.exe');
    expect(msysPsPath(path.join(git, 'bin', 'bash.exe'), (p) => path.normalize(p) === want)).toBe(want);
  });

  it('finds ps.exe next to a bash.exe in usr\\bin', () => {
    const want = path.join(git, 'usr', 'bin', 'ps.exe');
    expect(msysPsPath(path.join(git, 'usr', 'bin', 'bash.exe'), (p) => p === want)).toBe(want);
  });

  it('is undefined for cmd.exe, or when there is no ps.exe', () => {
    expect(msysPsPath('C:\\Windows\\System32\\cmd.exe', () => true)).toBeUndefined();
    expect(msysPsPath(path.join(git, 'bin', 'bash.exe'), () => false)).toBeUndefined();
  });
});

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

// #422: a group whose leader exited can have its id handed out again. Only the
// members that started while our leader was alive are ours.
describe('killMsysProcessGroup after the leader exited (#422)', () => {
  const at = (h: number, m: number, sec = 0) => new Date(2026, 10, 22, h, m, sec).getTime();
  const now = at(10, 0);
  const REUSED = [
    PS_LISTING,
    // A later program got group id 75006 after our bash exited at 08:45.
    '    75006       1   75006      51000  ?         197609 09:15:00 /usr/bin/bash',
    '    75102   75006   75006      51200  ?         197609 09:15:01 /usr/bin/ssh',
  ].join('\n');

  it('kills only members that started before the leader exited', () => {
    const exec = vi.fn();
    expect(killMsysProcessGroup(75006, 'ps.exe', () => REUSED, exec, { leaderExitedAt: at(8, 45), now })).toBe(3);
    expect(exec.mock.calls.map((c) => c[1][1])).toEqual(['38864', '41564', '46164']);
  });

  it('kills every member while the leader is alive, as before', () => {
    const exec = vi.fn();
    expect(killMsysProcessGroup(75006, 'ps.exe', () => REUSED, exec, { now })).toBe(5);
  });

  it('leaves a member whose start time cannot be read', () => {
    const exec = vi.fn();
    const listing = '    75006       1   75006      38864  ?         197609 ?? /usr/bin/bash';
    expect(killMsysProcessGroup(75006, 'ps.exe', () => listing, exec, { leaderExitedAt: at(8, 45), now })).toBe(0);
  });
});

describe('msysStartBounds', () => {
  const now = new Date(2026, 10, 22, 10, 0, 0).getTime();

  it('reads a clock time as today, to the second', () => {
    const [lo, hi] = msysStartBounds(['08:30:02'], now)!;
    expect(new Date(lo)).toEqual(new Date(2026, 10, 22, 8, 30, 2));
    expect(hi - lo).toBe(999);
  });

  it('reads a clock time later than now as yesterday', () => {
    expect(new Date(msysStartBounds(['17:03:43'], now)![0])).toEqual(new Date(2026, 10, 21, 17, 3, 43));
  });

  it('reads `Mon DD` as that whole day, last year if it is in the future', () => {
    const [lo, hi] = msysStartBounds(['Nov', '11'], now)!;
    expect(new Date(lo)).toEqual(new Date(2026, 10, 11));
    expect(hi - lo).toBe(24 * 3600_000 - 1);
    expect(new Date(msysStartBounds(['Dec', '30'], now)![0])).toEqual(new Date(2025, 11, 30));
  });

  it('returns undefined for anything else', () => {
    expect(msysStartBounds(['??'], now)).toBeUndefined();
    expect(msysStartBounds([], now)).toBeUndefined();
  });
});
