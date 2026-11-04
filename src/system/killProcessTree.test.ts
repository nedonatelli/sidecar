import { describe, it, expect, vi } from 'vitest';
import * as path from 'path';
import { killProcessTree, signalProcessGroup, msysPsPath, killMsysProcessGroup } from './killProcessTree.js';

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
