import { workspace, Uri } from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Split a shell-style command string into [bin, ...args] without invoking a
 * shell. Handles double/single-quoted segments and escaped spaces.
 * Used so we can pass the result directly to execFile(), which avoids shell
 * metacharacter injection entirely.
 */
export function parseArgv(cmd: string): [string, string[]] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];
    if (ch === '\\' && quote !== "'") {
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
      output: 'No lint command detected. Configure via sidecar.lintCommand or add a lint script to package.json.',
      success: false,
    };
  }

  try {
    const [bin, args] = parseArgv(lintCmd);
    const { stdout, stderr } = await execFileAsync(bin, args, {
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
