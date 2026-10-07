import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';

// #114: on Windows, disposing a hook process killed the process alone; what it
// had started kept running (and kept files locked).
vi.mock('os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('os')>()),
  platform: () => 'win32',
}));
const treeKill = vi.fn((_pid: number | undefined, _isWindows: boolean) => true);
vi.mock('../system/killProcessTree.js', () => ({
  killProcessTree: (pid: number | undefined, isWindows: boolean) => treeKill(pid, isWindows),
}));

import { ManagedChildProcess } from './processLifecycle.js';

describe('ManagedChildProcess.dispose on Windows', () => {
  it('kills the whole process tree, and resolves', async () => {
    const proc = Object.assign(new EventEmitter(), { pid: 4242, exitCode: null, killed: false, kill: vi.fn() });
    const registry = { register: vi.fn(), unregister: vi.fn() };
    const managed = new ManagedChildProcess(proc as never, 'hook: test', registry as never);
    const done = managed.dispose();
    proc.emit('exit', 1);
    await done;
    expect(treeKill).toHaveBeenCalledWith(4242, true);
    expect(proc.kill).not.toHaveBeenCalled();
  });
});
