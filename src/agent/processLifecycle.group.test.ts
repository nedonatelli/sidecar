import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

// #260: on POSIX, a background command spawned detached leads its own process
// group; disposing it must signal the group, or what it forked survives.
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => 'linux',
}));
const groupSignals: Array<[number | undefined, string]> = [];
vi.mock('../system/killProcessTree.js', () => ({
  killProcessTree: () => false,
  signalProcessGroup: (pid: number | undefined, signal: string) => {
    groupSignals.push([pid, signal]);
    return true;
  },
}));

import { ManagedChildProcess } from './processLifecycle.js';

const fakeProc = () => Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, killed: false, kill: vi.fn() });
const registry = () => ({ register: vi.fn(), unregister: vi.fn() });

describe('ManagedChildProcess.dispose on POSIX (#260)', () => {
  it('a process-group leader is signalled as a group, not alone', async () => {
    groupSignals.length = 0;
    const proc = fakeProc();
    const managed = new ManagedChildProcess(proc as never, 'bg-cmd:x', registry() as never, { ownsProcessGroup: true });
    const done = managed.dispose();
    proc.emit('exit', 0);
    await done;
    expect(groupSignals[0]).toEqual([4242, 'SIGTERM']);
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it('a process that does not lead a group is signalled alone, as before', async () => {
    groupSignals.length = 0;
    const proc = fakeProc();
    const managed = new ManagedChildProcess(proc as never, 'hook: x', registry() as never);
    const done = managed.dispose();
    proc.emit('exit', 0);
    await done;
    expect(groupSignals).toEqual([]);
    expect(proc.kill).toHaveBeenCalled();
  });
});
