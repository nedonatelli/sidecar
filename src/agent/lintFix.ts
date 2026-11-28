import { workspace, Uri } from 'vscode';
import { execFile, type ExecFileOptions } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Windows system variables a child process needs to start: Python, Node and
 * cmd.exe fail or misbehave without them. For the whitelisted environment
 * given to custom tools, which otherwise carries only POSIX names. Paths and
 * settings, never credentials. (#427)
 */
export const WINDOWS_STARTUP_ENV_KEYS = [
  'SystemRoot',
  'windir',
  'COMSPEC',
  'PATHEXT',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
] as const;

/** Package-manager launchers that are `.cmd` scripts on Windows. */
const WINDOWS_CMD_SHIMS = /^(npm|npx|yarn|pnpm|bun|bunx)$/i;

/** Quote one argument for a cmd.exe command line. */
function quoteForCmd(arg: string): string {
  return /^[\w.\-/:\\=@,+]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/**
 * execFile, except that on Windows a bare npm/npx/yarn/pnpm/bun runs through
 * cmd.exe (#117). Those are `.cmd` scripts there, which execFile cannot start
 * without a shell, so the auto-detected `npm run lint` / `npx eslint` failed on
 * every Windows machine. Everything else -- and every other platform -- keeps
 * execFile's no-shell behaviour. Commands reaching this come from SideCar's own
 * detection or the user's configuration.
 */
export function execPortable(
  bin: string,
  args: string[],
  options: ExecFileOptions,
  platform: NodeJS.Platform = process.platform,
): Promise<{ stdout: string; stderr: string }> {
  if (platform === 'win32' && WINDOWS_CMD_SHIMS.test(bin)) {
    const line = [bin, ...args].map(quoteForCmd).join(' ');
    return execFileAsync('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
      ...options,
      windowsVerbatimArguments: true,
    }) as Promise<{ stdout: string; stderr: string }>;
  }
  return execFileAsync(bin, args, options) as Promise<{ stdout: string; stderr: string }>;
}

/**
 * Split a shell-style command string into [bin, ...args] without invoking a
 * shell. Handles double/single-quoted segments and escaped spaces.
 * Used so we can pass the result directly to execFile(), which avoids shell
 * metacharacter injection entirely.
 */
export function parseArgv(cmd: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  // A backslash escapes only a space, quote or backslash -- and on Windows
  // never: it is the path separator there, and `C:\proj\src` came out as
  // `C:projsrc` (#117).
  const escapes = (next: string | undefined): boolean =>
    platform !== 'win32' && next !== undefined && /[\s"'\\]/.test(next);

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\' && quote !== "'" && escapes(cmd[i + 1])) {
      // Escaped character — consume next character literally.
      i++;
      if (i < cmd.length) current += cmd[i];
    } else if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);

  const [bin = '', ...args] = tokens;
  return [bin, args];
}

/**
 * Detect the project's lint command from package.json or common configs.
 */
export async function detectLintCommand(): Promise<string | null> {
  const rootUri = workspace.workspaceFolders?.[0]?.uri;
  if (!rootUri) return null;

  // Check package.json scripts
  try {
    const pkgBytes = await workspace.fs.readFile(Uri.joinPath(rootUri, 'package.json'));
    const pkg = JSON.parse(Buffer.from(pkgBytes).toString('utf-8'));
    if (pkg.scripts?.lint) return 'npm run lint';
    if (pkg.scripts?.['lint:fix']) return 'npm run lint:fix';
  } catch {
    // no package.json
  }

  // Check for common lint configs
  const checks: [string, string][] = [
    ['.eslintrc.json', 'npx eslint --fix .'],
    ['.eslintrc.js', 'npx eslint --fix .'],
    ['eslint.config.js', 'npx eslint --fix .'],
    ['eslint.config.mjs', 'npx eslint --fix .'],
    ['.flake8', 'flake8'],
    ['pyproject.toml', 'ruff check --fix .'],
    ['.golangci.yml', 'golangci-lint run --fix'],
  ];

  for (const [configFile, lintCmd] of checks) {
    try {
      await workspace.fs.stat(Uri.joinPath(rootUri, configFile));
      return lintCmd;
    } catch {
      // not found
    }
  }

  return null;
}

/**
 * Run the lint command and return the output.
 */
export async function runLint(command?: string): Promise<{ output: string; success: boolean }> {
  const cwd = workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!cwd) return { output: 'No workspace folder open.', success: false };

  const lintCmd = command || (await detectLintCommand());
  if (!lintCmd) {
    return {
      output:
        'No lint command detected. Add a `lint` script to package.json (or an ESLint/Biome config) so SideCar can find one.',
      success: false,
    };
  }

  try {
    const [bin, args] = parseArgv(lintCmd);
    const { stdout, stderr } = await execPortable(bin, args, {
      cwd,
      timeout: 60_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const output = (stdout + (stderr ? '\n' + stderr : '')).trim();
    return { output: output || 'Lint passed with no output.', success: true };
  } catch (err) {
    const error = err as { stdout?: string; stderr?: string; message?: string };
    const output = (error.stderr || error.stdout || error.message || 'Lint command failed').trim();
    return { output, success: false };
  }
}
