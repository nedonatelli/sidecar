import { execFileSync } from 'child_process';

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
