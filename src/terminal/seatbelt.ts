import * as os from 'os';
import * as fs from 'fs';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

export function isSeatbeltSupported(): boolean {
  return os.platform() === 'darwin' && fs.existsSync(SANDBOX_EXEC);
}

// Escape a path for embedding in an SBPL double-quoted string literal.
// SBPL uses C-style escaping inside strings: backslash and double-quote
// must be escaped; all other characters are literal.
function sbplEscape(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build a macOS Seatbelt profile (SBPL) that:
 *   - Denies everything by default
 *   - Allows all file reads (agent needs libs, project files, system tools)
 *   - Allows writes inside the workspace directory
 *   - Allows writes to /tmp and common build-tool caches (~/.npm, ~/.cargo, etc.)
 *   - Allows all network (npm install, git fetch, API calls)
 *   - Allows process exec/fork and mach IPC (required for most CLI tools on macOS)
 *
 * Implicitly denied: writes to ~/.ssh, ~/.aws, ~/.gnupg, /etc, /usr/local,
 * and every other path not listed above — which is the goal.
 *
 * @param workspacePath  Absolute path to the workspace root.
 * @param homeDir        Home directory (injectable for testing; defaults to os.homedir()).
 */
export function buildSandboxProfile(workspacePath: string, homeDir = os.homedir()): string {
  const ws = sbplEscape(workspacePath);
  const home = sbplEscape(homeDir);

  return `(version 1)
(deny default)

; Process operations — exec, fork, signals
(allow process-exec*)
(allow process-fork)
(allow signal)

; macOS Mach IPC and POSIX IPC (needed by essentially every CLI tool)
(allow mach*)
(allow ipc*)

; Sysctl reads (uname, hw.ncpu, etc.)
(allow sysctl-read)

; ioctl on file descriptors (/dev/tty, etc.)
(allow file-ioctl)

; Read anywhere — agents need to read libraries, project files, system tools.
; Writes are locked down below.
(allow file-read*)

; Network — allow all outbound (npm install, git fetch, API calls).
; Restrict inbound to localhost so the agent can't open a server
; reachable from outside the machine.
(allow network-outbound)
(allow network-inbound (local))
(allow network-bind (local))

; /dev pseudo-files
(allow file-write*
  (literal "/dev/null")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (subpath "/dev/fd")
  (subpath "/dev/pts"))

; Workspace — all writes inside the project directory
(allow file-write*
  (subpath "${ws}"))

; System temporary directories
(allow file-write*
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath "/var/folders"))

; Per-user build-tool caches — keep npm install, cargo build, etc. working
(allow file-write*
  (subpath "${home}/.npm")
  (subpath "${home}/.yarn")
  (subpath "${home}/.pnpm-store")
  (subpath "${home}/.cache")
  (subpath "${home}/.local")
  (subpath "${home}/.cargo")
  (subpath "${home}/.rustup")
  (subpath "${home}/.go")
  (subpath "${home}/go")
  (subpath "${home}/.gradle")
  (subpath "${home}/.m2")
  (subpath "${home}/.ivy2")
  (subpath "${home}/Library/Caches")
  (subpath "${home}/Library/Logs")
  (subpath "${home}/Library/Application Support/pip"))
`;
}

/**
 * Return spawn arguments that wrap the given shell invocation in sandbox-exec.
 *
 * @example
 *   const { cmd, args } = wrapWithSeatbelt('/bin/bash', ['--norc'], '/proj');
 *   // cmd  === '/usr/bin/sandbox-exec'
 *   // args === ['-p', '<profile>', '/bin/bash', '--norc']
 */
export function wrapWithSeatbelt(
  shellPath: string,
  shellArgs: string[],
  workspacePath: string,
): { cmd: string; args: string[] } {
  const profile = buildSandboxProfile(workspacePath);
  return { cmd: SANDBOX_EXEC, args: ['-p', profile, shellPath, ...shellArgs] };
}
