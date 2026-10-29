import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

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
  return [...grepFlags(), '-e', pattern, '--', where];
}

function grepFlags(fixed = false): string[] {
  return [
    '-rn',
    // -F: the pattern as literal text (execGrep's `fixed`); otherwise extended regex.
    fixed ? '-F' : '-E',
    '-I',
    '--exclude-dir=.git',
    '--include=*',
    // After --include: when the two disagree, grep lets the LAST match win.
    ...SECRET_FILE_GLOBS.map((g) => `--exclude=${caseInsensitiveGlob(g)}`),
  ];
}

/**
 * The same search with the pattern read from stdin (`-f -`) instead of argv.
 *
 * On Windows a pattern in argv is not safe (#316). Node escapes an embedded `"`
 * as `\"` on the command line, and MSYS normally undoes that, but not under
 * `MSYS=noglob` (GREP_ENV, needed so `.*` isn't globbed). Every pattern holding
 * a quote then reached grep ending in a backslash and failed with "Trailing
 * backslash": `"seaborn-colorblind"` in 10 SWE canary logs, and the model gave
 * up on finding the code. A pattern on stdin is never parsed as a command
 * line, so neither quoting nor globbing applies, on any platform.
 */
export function grepStdinArgs(where: string, fixed = false): string[] {
  return [...grepFlags(fixed), '-f', '-', '--', where];
}

/** grep's stderr for a pattern that isn't a valid extended regex (GNU and BSD wording). */
export const REGEX_SYNTAX_ERROR_RE =
  /unmatched|unbalanced|trailing backslash|invalid (?:regular expression|preceding|range|character class|content of)|brackets \(\[ \]\) not balanced|parentheses not balanced/i;

const execFileAsync = promisify(execFile);

/**
 * The grep executable to run. Everywhere but Windows that is `grep` on PATH.
 *
 * Git for Windows installs grep.exe in `<Git>\usr\bin`, but its default PATH
 * setting adds only `<Git>\cmd` (git.exe). A machine set up that way has git
 * and Git Bash and no `grep` for execFile to find: on one workstation 114 of
 * 120 grep calls failed with ENOENT. Use the grep that ships with the git on
 * PATH, then the standard install folders; `grep` (which then fails with
 * ENOENT, reported by isGrepMissing) when there is none.
 */
export function resolveGrepBinary(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = fs.existsSync,
): string {
  if (platform !== 'win32') return 'grep';
  const win = path.win32;
  // Windows environment keys are case-insensitive; `Path` is the usual spelling.
  const get = (name: string) => Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1];
  const dirs = (get('PATH') ?? '').split(';').filter(Boolean);
  if (dirs.some((d) => exists(win.join(d, 'grep.exe')))) return 'grep';
  // git.exe lives in <Git>\cmd, <Git>\bin or <Git>\mingw64\bin.
  const roots = dirs
    .filter((d) => exists(win.join(d, 'git.exe')))
    .map((d) => (/[\\/]mingw64[\\/]bin[\\/]?$/i.test(d) ? win.join(d, '..', '..') : win.join(d, '..')));
  for (const base of [get('PROGRAMFILES'), get('PROGRAMW6432'), get('PROGRAMFILES(X86)')]) {
    if (base) roots.push(win.join(base, 'Git'));
  }
  const local = get('LOCALAPPDATA');
  if (local) roots.push(win.join(local, 'Programs', 'Git'));
  for (const root of roots) {
    const candidate = win.join(root, 'usr', 'bin', 'grep.exe');
    if (exists(candidate)) return candidate;
  }
  return 'grep';
}

let grepBinary: string | undefined;

/** resolveGrepBinary for this process, looked up once. */
export function grepCommand(): string {
  grepBinary ??= resolveGrepBinary();
  return grepBinary;
}

/** execFile's error when the grep executable itself was not found. */
export function isGrepMissing(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Run the agent's grep: the pattern on stdin (grepStdinArgs). Resolves like
 * `execFile` (`{ stdout, stderr }`) and rejects with its error (`code`, `stdout`,
 * `stderr`, `killed`), so callers handle exit 1 (no match) as before. An empty
 * pattern keeps argv: `-f` with empty input matches nothing, `-e ''` matches all.
 */
export function execGrep(
  pattern: string,
  where: string,
  opts: { cwd: string; timeout: number; maxBuffer: number; fixed?: boolean },
): Promise<{ stdout: string; stderr: string }> {
  const { fixed, ...execOpts } = opts;
  if (pattern === '') return execFileAsync(grepCommand(), grepArgs(pattern, where), { ...execOpts, env: GREP_ENV });
  const run = execFileAsync(grepCommand(), grepStdinArgs(where, fixed), { ...execOpts, env: GREP_ENV });
  run.child?.stdin?.end(pattern);
  return run;
}

/**
 * grep matches --exclude globs case-sensitively, while read_file's credential
 * rule ignores case: `Server.KEY` or `.ENV` was refused by read_file and
 * printed by grep. Each letter becomes a two-case bracket (`*.pem` ->
 * `*.[pP][eE][mM]`).
 */
export function caseInsensitiveGlob(glob: string): string {
  return glob.replace(/[a-z]/gi, (c) => `[${c.toLowerCase()}${c.toUpperCase()}]`);
}

/**
 * Credential files, as basename globs -- the grep counterpart of
 * SENSITIVE_PATTERNS in tools/shared.ts, which read_file refuses. Without
 * these, `grep(pattern="KEY")` over the workspace printed the matching lines
 * of `.env` with no approval, and they went to the model provider.
 */
export const SECRET_FILE_GLOBS: readonly string[] = [
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  'id_rsa*',
  'id_ed25519*',
  '*credentials.json',
  '*secret.json',
  '*secrets.json',
  '*secret.yml',
  '*secrets.yml',
  '*secret.yaml',
  '*secrets.yaml',
  '*secret.toml',
  '*secrets.toml',
  '*.secret',
  '*token.json',
  '*service?account.json',
];

/**
 * Git for Windows' grep glob-expands its argv like a shell would, even under
 * execFile: `.*` became `. .. .git ...`, so a regex PATTERN turned into extra
 * paths and grep searched the workspace's PARENT. `MSYS=noglob` turns that off;
 * it is inert on Linux and macOS.
 */
export const GREP_ENV = { ...process.env, MSYS: [process.env.MSYS, 'noglob'].filter(Boolean).join(' ') };
