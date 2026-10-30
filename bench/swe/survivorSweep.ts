// After-task sweep for processes that outlived the task's shell (#260).
//
// Disposing the per-task shell kills its process tree (ShellSession.dispose,
// `taskkill /T /F` on Windows, a process-group signal on POSIX), and on Windows
// that still leaves survivors. On 2026-10-24, 24 orphaned sympy full-suite runs
// (`python bin/test -C --verbose`) were found at ~80% of a core each, started
// by tasks that hit the per-task limit and kept running through the next two
// days of canaries. They came in pairs: the venv's Scripts\python.exe launcher
// and the base interpreter it starts, whose command line names only the
// interpreter. `/T` walks parent links at kill time, so a chain whose middle
// link has already exited is out of its reach.
//
// So, after the dispose: list every process, take those whose command line
// names the task's clone or venv, add all their descendants (that is how the
// base interpreter is found), and kill them by PID. The count is logged per
// task — the acceptance item #265's group kill could not provide.

import { execFileSync } from 'node:child_process';

export interface ProcRow {
  pid: number;
  ppid: number;
  cmd: string;
}

const norm = (s: string): string => s.replace(/\\/g, '/').toLowerCase();

/**
 * PIDs to kill: rows whose command line contains one of `roots`, plus all their
 * descendants. Never `selfPid` or any of its ancestors (the harness itself, and
 * whatever launched it), even if their command line names a root.
 */
export function survivorPids(rows: readonly ProcRow[], roots: readonly string[], selfPid: number): number[] {
  // A short root would match far too much: refuse anything that is not a real path.
  const needles = roots.map(norm).filter((r) => r.length >= 8 && r.includes('/'));
  if (needles.length === 0) return [];
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const protectedPids = new Set<number>();
  for (let p: number | undefined = selfPid; p && !protectedPids.has(p); p = byPid.get(p)?.ppid) protectedPids.add(p);

  const hit = new Set(rows.filter((r) => needles.some((n) => norm(r.cmd).includes(n))).map((r) => r.pid));
  // Descendants: repeat until no new child joins (rows arrive in no particular order).
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of rows) {
      if (!hit.has(r.pid) && hit.has(r.ppid)) {
        hit.add(r.pid);
        grew = true;
      }
    }
  }
  return [...hit].filter((pid) => !protectedPids.has(pid)).sort((a, b) => a - b);
}

/** Parse `ps -A -o pid=,ppid=,args=` output. */
export function parsePs(out: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
  }
  return rows;
}

/** Parse the JSON from `Get-CimInstance Win32_Process | Select ProcessId,ParentProcessId,CommandLine | ConvertTo-Json`. */
export function parseWin32Processes(json: string): ProcRow[] {
  if (!json.trim()) return [];
  const raw = JSON.parse(json) as unknown;
  const list = (Array.isArray(raw) ? raw : [raw]) as Array<Record<string, unknown>>;
  return list
    .filter((r) => typeof r.ProcessId === 'number')
    .map((r) => ({
      pid: r.ProcessId as number,
      ppid: typeof r.ParentProcessId === 'number' ? r.ParentProcessId : 0,
      cmd: typeof r.CommandLine === 'string' ? r.CommandLine : '',
    }));
}

export interface SweepDeps {
  platform: NodeJS.Platform;
  selfPid: number;
  run: (cmd: string, args: string[]) => string;
  kill: (pid: number) => void;
}

const defaultDeps = (): SweepDeps => ({
  platform: process.platform,
  selfPid: process.pid,
  run: (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', timeout: 20_000, maxBuffer: 32 * 1024 * 1024 }),
  kill: (pid) => {
    if (process.platform === 'win32')
      execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', timeout: 5000 });
    else process.kill(pid, 'SIGKILL');
  },
});

function listProcesses(deps: SweepDeps): ProcRow[] {
  if (deps.platform === 'win32') {
    return parseWin32Processes(
      deps.run('powershell', [
        '-NoProfile',
        '-Command',
        'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress',
      ]),
    );
  }
  return parsePs(deps.run('ps', ['-A', '-o', 'pid=,ppid=,args=']));
}

export interface SweepResult {
  found: number;
  killed: number;
  /** Why the process listing failed, twice. Set only then; found and killed are 0. */
  listError?: string;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).split('\n')[0].slice(0, 300);

/**
 * Kill every process still running from this task's clone or venv. Returns how
 * many were found and how many kills succeeded; never throws, since the task's
 * result must not depend on its cleanup.
 *
 * A failed listing is retried once. If the retry fails too, `listError` says
 * why: reporting it as "nothing found" hid the failure (#380), and a sweep that
 * cannot list leaves the survivors running into the next task.
 */
export function sweepTaskSurvivors(roots: readonly string[], deps: SweepDeps = defaultDeps()): SweepResult {
  let rows: ProcRow[];
  try {
    rows = listProcesses(deps);
  } catch (first) {
    try {
      rows = listProcesses(deps);
    } catch (second) {
      return { found: 0, killed: 0, listError: `${errorText(first)} (retry: ${errorText(second)})` };
    }
  }
  const pids = survivorPids(rows, roots, deps.selfPid);
  let killed = 0;
  for (const pid of pids) {
    try {
      deps.kill(pid);
      killed++;
    } catch {
      // Already gone (it was a child of one killed a moment ago), or not ours.
    }
  }
  return { found: pids.length, killed };
}
