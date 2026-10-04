// grep's argv and environment, in one place. Kept free of `vscode` so the SWE
// harness's tree warm-up (bench/swe/warmTree.ts) can run the SAME invocation the
// agent's grep tool does -- a warm-up that reads different files than the
// agent's first search leaves that search paying the first-read cost.

/**
 * - `-e pattern --`: a pattern or path starting with `-` (django's `-pk`) is
 *   searched for, not read as an option.
 * - `--exclude-dir=.git`, `-I`: never repository internals or binary files.
 *   `Binary file ./.git/objects/pack/pack-<hash>.pack matches` reached the model
 *   in real runs -- nothing it can act on -- and the pack name differs between
 *   clones, which broke 3 of 50 determinism pairs in a baseline.
 */
export function grepArgs(pattern: string, where: string): string[] {
  return ['-rn', '-E', '-I', '--exclude-dir=.git', '--include=*', '-e', pattern, '--', where];
}

/**
 * Git for Windows' grep glob-expands its argv like a shell would, even under
 * execFile: `.*` became `. .. .git ...`, so a regex PATTERN turned into extra
 * paths and grep searched the workspace's PARENT. `MSYS=noglob` turns that off;
 * it is inert on Linux and macOS.
 */
export const GREP_ENV = { ...process.env, MSYS: [process.env.MSYS, 'noglob'].filter(Boolean).join(' ') };
