import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  survivorPids,
  parsePs,
  parseWin32Processes,
  sweepTaskSurvivors,
  type ProcRow,
  type SweepDeps,
} from './survivorSweep.js';

const CLONE = 'C:\\Users\\me\\AppData\\Local\\Temp\\swe-repo-sympy_sympy-abc123';
const VENV = 'C:\\Users\\me\\AppData\\Local\\sidecar-swe\\venvs\\sympy_sympy@1.1';

// The 2026-10-24 shape: the venv launcher names the venv; the base interpreter
// it starts names only itself, and is found as the launcher's child.
const ROWS: ProcRow[] = [
  { pid: 1, ppid: 0, cmd: 'System' },
  { pid: 100, ppid: 1, cmd: 'node vitest run tests/llm-eval/swe.eval.ts' }, // the harness
  { pid: 200, ppid: 9999, cmd: `"${VENV}\\Scripts\\python.exe" bin/test -C --verbose` }, // parent already exited
  { pid: 201, ppid: 200, cmd: '"C:\\uv\\python\\cpython-3.9-windows-x86_64-none\\python.exe" bin/test -C --verbose' },
  { pid: 202, ppid: 201, cmd: 'python -c "worker"' },
  { pid: 300, ppid: 1, cmd: `git -C ${CLONE.replace(/\\/g, '/')} status` }, // slash style differs
  { pid: 400, ppid: 1, cmd: '"C:\\other\\venvs\\django\\Scripts\\python.exe" runtests.py' }, // another task's
];

describe('survivorPids (#260)', () => {
  it('takes processes naming the clone or venv, and every descendant of them', () => {
    expect(survivorPids(ROWS, [CLONE, VENV], 100)).toEqual([200, 201, 202, 300]);
  });

  it('never the harness or its ancestors, even when their command line names a root', () => {
    const rows: ProcRow[] = [
      { pid: 10, ppid: 1, cmd: `bash run-sharded-cell.sh ${CLONE}` },
      { pid: 11, ppid: 10, cmd: `node vitest ${CLONE}` },
      { pid: 12, ppid: 11, cmd: `python ${CLONE}/x.py` },
    ];
    expect(survivorPids(rows, [CLONE], 11)).toEqual([12]);
  });

  it('refuses roots too short or not a path, so a bad call cannot match everything', () => {
    expect(survivorPids(ROWS, ['', 'python', 'C:\\'], 100)).toEqual([]);
  });

  it('matches case- and slash-insensitively', () => {
    expect(survivorPids(ROWS, [CLONE.toUpperCase().replace(/\\/g, '/')], 100)).toEqual([300]);
  });
});

describe('process listings', () => {
  it('parsePs reads pid, ppid and the full command', () => {
    expect(parsePs('  12   1 /usr/bin/python bin/test -C\n 13 12 sleep 5\nbad line\n')).toEqual([
      { pid: 12, ppid: 1, cmd: '/usr/bin/python bin/test -C' },
      { pid: 13, ppid: 12, cmd: 'sleep 5' },
    ]);
  });

  it('parseWin32Processes reads the CIM JSON, a single object, and a null command line', () => {
    expect(
      parseWin32Processes(
        '[{"ProcessId":4,"ParentProcessId":0,"CommandLine":null},{"ProcessId":5,"ParentProcessId":4,"CommandLine":"x"}]',
      ),
    ).toEqual([
      { pid: 4, ppid: 0, cmd: '' },
      { pid: 5, ppid: 4, cmd: 'x' },
    ]);
    expect(parseWin32Processes('{"ProcessId":7,"ParentProcessId":1,"CommandLine":"y"}')).toEqual([
      { pid: 7, ppid: 1, cmd: 'y' },
    ]);
    expect(parseWin32Processes('')).toEqual([]);
  });
});

describe('sweepTaskSurvivors', () => {
  const deps = (over: Partial<SweepDeps>): SweepDeps => ({
    platform: 'linux',
    selfPid: 100,
    run: () => ROWS.map((r) => `${r.pid} ${r.ppid} ${r.cmd}`).join('\n'),
    kill: () => {},
    ...over,
  });

  it('kills each survivor and reports found/killed; a kill of an already-gone child still counts as found', () => {
    const killed: number[] = [];
    const res = sweepTaskSurvivors(
      [CLONE, VENV],
      deps({
        kill: (pid) => {
          if (pid === 202) throw new Error('no such process');
          killed.push(pid);
        },
      }),
    );
    expect(res).toEqual({ found: 4, killed: 3 });
    expect(killed).toEqual([200, 201, 300]);
  });

  it('never throws: a listing that fails twice reports why, and finds nothing (#380)', () => {
    let calls = 0;
    expect(
      sweepTaskSurvivors(
        [CLONE],
        deps({
          run: () => {
            calls++;
            throw new Error(`powershell missing ${calls}\nstack line`);
          },
        }),
      ),
    ).toEqual({ found: 0, killed: 0, listError: 'powershell missing 1 (retry: powershell missing 2)' });
    expect(calls).toBe(2);
  });

  it('retries a failed listing once, and the retry is used', () => {
    let calls = 0;
    const res = sweepTaskSurvivors(
      [CLONE, VENV],
      deps({
        run: () => {
          if (++calls === 1) throw new Error('spawnSync powershell ETIMEDOUT');
          return ROWS.map((r) => `${r.pid} ${r.ppid} ${r.cmd}`).join('\n');
        },
      }),
    );
    expect(res).toEqual({ found: 4, killed: 4 });
    expect(calls).toBe(2);
  });

  it('a listing that is not JSON counts as a failed listing', () => {
    const res = sweepTaskSurvivors([CLONE], deps({ platform: 'win32', run: () => 'Get-CimInstance : Access denied' }));
    expect(res.found).toBe(0);
    expect(res.listError).toMatch(/JSON/);
  });

  it('lists through PowerShell CIM on Windows', () => {
    const calls: string[] = [];
    sweepTaskSurvivors(
      [CLONE],
      deps({
        platform: 'win32',
        run: (cmd, args) => {
          calls.push(`${cmd} ${args.join(' ')}`);
          return '[]';
        },
      }),
    );
    expect(calls[0]).toMatch(/^powershell .*Win32_Process.*ConvertTo-Json/);
  });
});

// The real thing: a process orphaned by its parent's exit, naming a task root,
// is found and killed by the default (real) listing and kill.
describe('sweepTaskSurvivors on this machine', () => {
  it('kills an orphan whose parent already exited', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'survivor-sweep-test-'));
    const marker = path.join(root, 'sleeper.js');
    fs.writeFileSync(marker, 'setTimeout(() => {}, 120000);');
    // The parent starts the sleeper detached and exits at once, so the sleeper's
    // parent link points at a dead process: the shape a tree kill misses.
    // The pid is printed on the child's 'spawn' event, as a plain string:
    // console.log(number) is coloured under FORCE_COLOR (set in the pre-commit
    // hook), and "\u001b[33m28728\u001b[39m" did not parse as a pid.
    const parent = spawn(
      process.execPath,
      [
        '-e',
        `const c=require('child_process').spawn(process.execPath,[${JSON.stringify(marker)}],{detached:true,stdio:'ignore'});` +
          `c.on('spawn',()=>{process.stdout.write(String(c.pid)+'\\n');c.unref();process.exit(0)});` +
          `c.on('error',(e)=>{console.error('spawn failed: '+e.message);process.exit(1)});`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    // 'close', not 'exit': 'exit' can fire before stdout drains.
    let helperOut = '';
    const sleeperPid = await new Promise<number>((resolve) => {
      parent.stdout!.on('data', (d) => (helperOut += d));
      parent.stderr!.on('data', (d) => (helperOut += d));
      parent.on('close', () => resolve(Number(/^\d+/m.exec(helperOut)?.[0] ?? NaN)));
    });
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      expect(sleeperPid, `helper output: ${JSON.stringify(helperOut)}`).toBeGreaterThan(0);
      for (let i = 0; i < 100 && !alive(sleeperPid); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(sleeperPid)).toBe(true);
      const res = sweepTaskSurvivors([root]);
      // Under full-suite load the listing has failed and read as "found 0" (#380):
      // say which it was.
      expect(res.listError, 'the process listing failed').toBeUndefined();
      expect(res.found).toBeGreaterThanOrEqual(1);
      for (let i = 0; i < 50 && alive(sleeperPid); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(sleeperPid)).toBe(false);
    } finally {
      if (alive(sleeperPid)) process.kill(sleeperPid);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
