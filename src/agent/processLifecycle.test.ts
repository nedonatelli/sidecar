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
// Ask the ChildProcess, not the PID. A killed victim's PID can be handed to
// a new process within milliseconds on a busy machine (a full test run), so
// "something answers on this PID" says nothing about the victim: the sweep
// test failed ~1 run in 50 that way, the victim dead and its PID reused.
const running = (p: ChildProcess): boolean => p.exitCode === null && p.signalCode === null;
const exitWithin = (p: ChildProcess, ms: number): Promise<boolean> =>
  new Promise((resolve) => {
    if (!running(p)) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    p.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
/** For the must-not-kill cases: give a wrongful kill time to land, then check. */
const survives = async (p: ChildProcess): Promise<boolean> => !(await exitWithin(p, 300));
/** Command lines for the sweep: the victim's real one, nothing for any other PID. */
const onlyVictim = (v: ChildProcess, cmdline: string) => (pid: number) => (pid === v.pid ? cmdline : '');

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
    await sweepWith([{ pid: v.pid, label: 'x', cmdline: '' }], onlyVictim(v, process.execPath));
    expect(await survives(v)).toBe(true);
  });

  it('does not kill when the live command line cannot be read (e.g. Windows)', async () => {
    const v = victim();
    await sweepWith([{ pid: v.pid, label: 'x', cmdline: process.execPath }], () => '');
    expect(await survives(v)).toBe(true);
  });

  it('does not kill a process whose command line does not match (PID reuse)', async () => {
    const v = victim();
    await sweepWith([{ pid: v.pid, label: 'x', cmdline: '/usr/bin/ollama serve' }], onlyVictim(v, process.execPath));
    expect(await survives(v)).toBe(true);
  });

  it('ignores malformed entries and never targets itself', async () => {
    await sweepWith([{ pid: process.pid, cmdline: process.execPath }, { pid: 'abc' }, null, { pid: -1, cmdline: 'x' }]);
    await sweepWith({ not: 'an array' });
    // Reaching this line at all means the sweep did not kill this process.
    expect(process.pid).toBeGreaterThan(0);
  });

  it('still sweeps a genuine orphan whose command line matches', async () => {
    const v = victim();
    await sweepWith([{ pid: v.pid, label: 'x', cmdline: process.execPath }], onlyVictim(v, process.execPath));
    expect(await exitWithin(v, 3000)).toBe(true);
  });
});
