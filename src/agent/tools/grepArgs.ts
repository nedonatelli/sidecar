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
  return [
    '-rn',
    '-E',
    '-I',
    '--exclude-dir=.git',
    '--include=*',
    // After --include: when the two disagree, grep lets the LAST match win.
    ...SECRET_FILE_GLOBS.map((g) => `--exclude=${caseInsensitiveGlob(g)}`),
    '-e',
    pattern,
    '--',
    where,
  ];
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
