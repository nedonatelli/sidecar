import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Kill a process AND everything it spawned. Windows only; returns false when it
 * did not handle the kill so the caller falls back to signals.
 *
 * Killing a process on Windows does not touch its children. The shell session is
 * long-lived and `run_command` runs everything inside it, so a python or node
 * the model started outlives the shell we killed -- with its working directory
 * still held open. Measured on a SWE-bench harness: 50 orphaned shells per run,
 * and clone directories that Windows then refused to delete because a live
 * process still had its cwd inside them. Orphaned venv pythons from those runs
 * were still resident days later.
 *
 * Nothing graceful is lost by using /F. Windows has no SIGTERM: Node's
 * `proc.kill('SIGTERM')` already calls TerminateProcess, so the existing path is
 * a forced kill that merely misses the children. `taskkill /T` is the same
 * bluntness applied to the whole tree.
 *
 * Synchronous on purpose. Callers tear down a shell and then immediately touch
 * the directory it was sitting in; returning before the tree is actually gone is
 * what left those directories undeletable.
 *
 * @param exec injection seam for tests — the default shells out to taskkill.
 */
export function killProcessTree(
  pid: number | undefined,
  isWindows: boolean,
  exec: (cmd: string, args: string[]) => void = (cmd, args) =>
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000 }),
): boolean {
  if (!isWindows || !pid) return false;
  try {
    exec('taskkill', ['/pid', String(pid), '/T', '/F']);
    return true;
  } catch {
    // Already dead, or taskkill unavailable. The signal path still runs.
    return false;
  }
}

/**
 * `ps.exe` of the MSYS runtime behind a Git Bash (or MSYS2) `bash.exe`, or
 * undefined when there is none. Git for Windows' `bin\bash.exe` is a launcher
 * for `usr\bin\bash.exe`, and `ps.exe` sits next to the real one.
 */
export function msysPsPath(shellPath: string, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  if (!/(^|[\\/])bash\.exe$/i.test(shellPath)) return undefined;
  const dir = path.dirname(shellPath);
  return [path.join(dir, 'ps.exe'), path.join(dir, '..', 'usr', 'bin', 'ps.exe')].find((p) => exists(p));
}

/**
 * Windows + Git Bash: kill every process in an MSYS process group, and each
 * one's native descendants. Returns how many group members it found.
 *
 * `taskkill /T` alone missed them (#245). A shell script -- `npx` is one --
 * runs in a forked bash, and an MSYS fork's Windows parent is a process that
 * has already exited, so the parent-PID walk taskkill does stops there. An
 * agent's `npx vitest --watch` kept bash, cmd, node, vitest's tinypool workers
 * and esbuild alive after the shell was killed, holding the workspace open.
 * MSYS keeps its own parent links across the fork: `ps -W -l` lists each of
 * its processes with its process group and Windows PID. A non-interactive
 * bash leads a group of its own, and everything it starts joins it, so the
 * group is the whole tree. taskkill /T from each member then takes the native
 * processes under it, whose Windows parent links are intact.
 *
 * @param list / exec injection seams for tests.
 */
export function killMsysProcessGroup(
  pgid: number,
  psPath: string,
  list: () => string = () => execFileSync(psPath, ['-W', '-l'], { encoding: 'utf8', timeout: 5000 }),
  exec: (cmd: string, args: string[]) => void = (cmd, args) =>
    execFileSync(cmd, args, { stdio: 'ignore', timeout: 5000 }),
  opts: { leaderExitedAt?: number; now?: number } = {},
): number {
  let found = 0;
  const now = opts.now ?? Date.now();
  for (const line of list().split('\n')) {
    // PID PPID PGID WINPID TTY UID STIME COMMAND; a status letter (I, S, O) may lead the line.
    const cols = line
      .trim()
      .replace(/^[A-Z]\s+/, '')
      .split(/\s+/);
    if (cols.length < 4 || Number(cols[2]) !== pgid || !/^\d+$/.test(cols[3])) continue;
    // The group's leader has exited, so its id is free for MSYS to hand out
    // again (#422). Our members all started while the leader was alive; a
    // process that started later belongs to a group that reused the id.
    if (opts.leaderExitedAt !== undefined) {
      const bounds = msysStartBounds(cols.slice(6), now);
      // Unreadable, or not certainly before the exit (STIME is to the second,
      // or to the day for a process over 24 hours old): leave it alone.
      if (!bounds || bounds[1] > opts.leaderExitedAt + 1000) continue;
    }
    found++;
    try {
      exec('taskkill', ['/pid', cols[3], '/T', '/F']);
    } catch {
      // Already gone with an earlier member's tree.
    }
  }
  return found;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * When a process in MSYS `ps -l` output started, as [earliest, latest] epoch
 * ms, from the STIME column onward. `ps` prints `HH:MM:SS` for a process
 * started in the last 24 hours and `Mon DD` (two columns) for an older one.
 * Undefined when the column cannot be read.
 */
export function msysStartBounds(stime: readonly string[], now: number): [number, number] | undefined {
  const clock = /^(\d{1,2}):(\d{2}):(\d{2})$/.exec(stime[0] ?? '');
  if (clock) {
    const d = new Date(now);
    d.setHours(Number(clock[1]), Number(clock[2]), Number(clock[3]), 0);
    // A time later than now is from yesterday.
    let start = d.getTime();
    if (start > now + 60_000) start -= 24 * 3600_000;
    return [start, start + 999];
  }
  const month = MONTHS.indexOf(stime[0] ?? '');
  const day = Number(stime[1]);
  if (month < 0 || !Number.isInteger(day) || day < 1 || day > 31) return undefined;
  const d = new Date(now);
  d.setMonth(month, day);
  d.setHours(0, 0, 0, 0);
  // A date later than now is from last year.
  if (d.getTime() > now) d.setFullYear(d.getFullYear() - 1);
  return [d.getTime(), d.getTime() + 24 * 3600_000 - 1];
}

/**
 * POSIX: send `signal` to the whole process group that `pid` leads, which is
 * what a child spawned with `detached: true` does. Returns false when there was
 * nothing to signal (no pid, or the group is gone), so the caller can fall back
 * to signalling the process alone.
 *
 * Killing only the shell left its descendants running: `runtests.py --parallel`
 * forks workers, and after the SWE driver disposed a task's shell six of them
 * were still alive 9 minutes later, re-parented to PID 1 (#260). Every process
 * a shell starts inherits its group, so signalling the group reaches them.
 *
 * @param kill injection seam for tests — the default is process.kill.
 */
export function signalProcessGroup(
  pid: number | undefined,
  signal: NodeJS.Signals,
  kill: (pid: number, signal: NodeJS.Signals) => void = (p, s) => process.kill(p, s),
): boolean {
  if (!pid) return false;
  try {
    kill(-pid, signal);
    return true;
  } catch {
    return false; // ESRCH: the group is already gone.
  }
}
