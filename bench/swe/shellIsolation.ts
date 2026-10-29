import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Keep a SWE task's shell out of the run machine's own files.
 *
 * Without this the agent's shell inherits the harness's environment, and on a
 * workstation that is somebody's working machine. Runs on one listed the user's
 * temp folder (Git Bash's /tmp is %TEMP%) and printed the names of unrelated
 * projects' scratch files, and `python -c "import sys; print(sys.path)"`
 * showed packages from the user-wide site-packages. None of it helps a task,
 * and every trace that carries it has to be scrubbed before it can be shared.
 *
 * What this changes, for the task's shell only:
 *   - TMP / TEMP / TMPDIR -> <scratch>/tmp, so pytest's tmp_path and
 *     tempfile.mkdtemp() land in a folder of this task's own;
 *   - HOME -> <scratch>/home, so `~` and `ls ~` show nothing of the user's;
 *   - PYTHONNOUSERSITE=1, so Python ignores the user-wide site-packages.
 *
 * Checked in Git Bash on Windows: `ls ~` is empty, site.ENABLE_USER_SITE is
 * False and tempfile.gettempdir() is the scratch folder. Git for Windows' own
 * `/tmp` is NOT moved: it is mounted on the user's temp folder, does not follow
 * TEMP, and `mount` cannot change it from inside a shell ("Operation not
 * permitted"). `ls /tmp` there still lists the real folder, which is why the
 * trajectory exporter drops /tmp paths and directory listings on its own.
 *
 * USERPROFILE is left alone: Windows programs (uv's cache, git's system
 * config) read it, and moving it breaks them. Absolute paths to the user's
 * folders are still reachable -- this is a default, not a sandbox.
 */
export const ISOLATED_KEYS = ['TMP', 'TEMP', 'TMPDIR', 'HOME', 'PYTHONNOUSERSITE'] as const;

/**
 * Set `key` in `env` under the spelling the environment already uses. Windows
 * keys are case-insensitive, and ShellSession merges this env over
 * process.env: a `TEMP` beside an inherited `Temp` would leave the child two.
 */
function setKey(env: Record<string, string>, key: string, value: string, platform: NodeJS.Platform): void {
  const existing = platform === 'win32' ? Object.keys(env).find((k) => k.toUpperCase() === key) : undefined;
  env[existing ?? key] = value;
}

/** The task shell's environment: `base` with the temp, home and Python user-site settings isolated. */
export function isolateShellEnv(
  base: Record<string, string | undefined>,
  scratchDir: string,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v;
  const tmp = path.join(scratchDir, 'tmp');
  const home = path.join(scratchDir, 'home');
  for (const key of ['TMP', 'TEMP', 'TMPDIR']) setKey(env, key, tmp, platform);
  setKey(env, 'HOME', home, platform);
  setKey(env, 'PYTHONNOUSERSITE', '1', platform);
  return env;
}

/** Create (empty) the scratch folders a task's shell will use, and return the root. */
export function prepareScratchDir(root: string, instanceId: string, arm: string): string {
  const dir = path.join(root, `${instanceId}.${arm}`.replace(/[^A-Za-z0-9._-]/g, '_'));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'home'), { recursive: true });
  return dir;
}

/**
 * Whether `python` or `python3` actually runs in this environment. A task with
 * no venv (the native-dep repos) depends on whatever the machine provides: on a
 * workstation whose Git Bash has no Python, every `python` the model types fails
 * with exit 127 and the run measures the machine, not the model. Running the
 * interpreter (not just finding it on PATH) also rules out the Windows Store
 * alias, a python.exe that only prints "Python was not found".
 */
export function pythonRuns(env: Record<string, string>, run: typeof execFileSync = execFileSync): boolean {
  for (const exe of ['python', 'python3']) {
    try {
      run(exe, ['-c', 'import sys; sys.exit(0)'], { env, stdio: 'ignore', timeout: 15_000 });
      return true;
    } catch {
      // not this one; try the next
    }
  }
  return false;
}
