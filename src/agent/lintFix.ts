import { workspace, Uri } from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

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
    const { stdout, stderr } = await execAsync(lintCmd, {
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
