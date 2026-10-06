import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProcessRegistry } from './processLifecycle.js';

// sweepOrphans KILLS what the PID manifest names. A manifest SideCar did not
// write -- or an entry that cannot be checked for PID reuse -- must kill nothing.

const victims: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const v of victims.splice(0)) v.kill();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function victim(): ChildProcess {
  const p = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  victims.push(p);
  return p;
}
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function sweepWith(pids: unknown, cmdlineOf?: (pid: number) => string): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-pids-'));
  dirs.push(dir);
  const manifest = path.join(dir, 'pids.json');
  fs.writeFileSync(manifest, JSON.stringify({ sessionId: 'x', pids }));
  const registry = new (ProcessRegistry as unknown as new () => ProcessRegistry)();
  registry.setManifestPath(manifest);
  if (cmdlineOf) {
    (registry as unknown as { getProcessCmdline: (pid: number) => Promise<string> }).getProcessCmdline = async (pid) =>
      cmdlineOf(pid);
  }
  await registry.sweepOrphans();
}

describe('ProcessRegistry.sweepOrphans', () => {
  it('does not kill a live process whose entry has no command line', async () => {
    const v = victim();
    await sweepWith([{ pid: v.pid, label: 'x', cmdline: '' }], () => process.execPath);
    expect(alive(v.pid!)).toBe(true);
  });

  it('does not kill when the live command line cannot be read (e.g. Windows)', async () => {
    const v = victim();
    await sweepWith([{ pid: v.pid, label: 'x', cmdline: process.execPath }], () => '');
    expect(alive(v.pid!)).toBe(true);
  });

  it('does not kill a process whose command line does not match (PID reuse)', async () => {
    const v = victim();
    await sweepWith([{ pid: v.pid, label: 'x', cmdline: '/usr/bin/ollama serve' }], () => process.execPath);
    expect(alive(v.pid!)).toBe(true);
  });

  it('ignores malformed entries and never targets itself', async () => {
    await sweepWith([{ pid: process.pid, cmdline: process.execPath }, { pid: 'abc' }, null, { pid: -1, cmdline: 'x' }]);
    await sweepWith({ not: 'an array' });
    expect(alive(process.pid)).toBe(true);
  });

  it('still sweeps a genuine orphan whose command line matches', async () => {
    const v = victim();
    await sweepWith([{ pid: v.pid, label: 'x', cmdline: process.execPath }], () => process.execPath);
    await new Promise((r) => setTimeout(r, 200));
    expect(alive(v.pid!)).toBe(false);
  });
});
