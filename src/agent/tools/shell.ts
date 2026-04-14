import { workspace, Uri } from 'vscode';
import type { ToolDefinition } from '../../ollama/types.js';
import { getConfig } from '../../config/settings.js';
import { validateFilePath, shellQuote, hasShellMetachar, getRootUri, type ToolExecutorContext } from './shared.js';
import { getShellSession } from './runtime.js';

// Shell tools: run_command (generic shell) and run_tests (test-runner
// auto-detection). Both route through the persistent ShellSession on the
// default ToolRuntime so cwd/env/alias state survives across calls.

export const runCommandDef: ToolDefinition = {
  name: 'run_command',
  description:
    'Execute a shell command in a persistent shell session. Environment variables, aliases, and working directory changes persist between calls. ' +
    'Examples: "npm test", "git status", "python main.py". ' +
    'For long-running processes, set background=true to get a command ID, then call again with just command_id to check output. ' +
    'The command and command_id parameters are mutually exclusive — provide one or the other, not both.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'Shell command to run. Mutually exclusive with command_id.',
      },
      timeout: {
        type: 'number',
        description: 'Timeout in seconds (default: 120). Use higher values for builds/installs.',
      },
      background: { type: 'boolean', description: 'If true, run in background and return an ID to check later.' },
      command_id: {
        type: 'string',
        description:
          'Check on a background command by its ID (returned from a previous background call). Mutually exclusive with command.',
      },
    },
    required: [],
  },
};

export const runTestsDef: ToolDefinition = {
  name: 'run_tests',
  description:
    'Run the project test suite with auto-detection of the test runner (npm test, pytest, cargo test, go test, gradle test). ' +
    'Use after fixing a bug or landing a new feature — per the operating rules, every bug fix finishes with `run_tests`. ' +
    'Not for arbitrary shell commands (use `run_command`) or for fetching type errors (use `get_diagnostics`). ' +
    'Prefer this over `run_command "npm test"` so the detection logic handles whichever runner the project uses. ' +
    "Pass `file` to narrow to a single test file when you've already isolated the failure. " +
    'Example: `run_tests(file="tests/auth.test.ts")`.',
  input_schema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description:
          'Optional: explicit test command to run (e.g. "npm test -- --coverage", "pytest -k myfunc"). Omit to auto-detect from project config files.',
      },
      file: {
        type: 'string',
        description:
          'Optional: relative path to a single test file to run (e.g. "tests/auth.test.ts"). Appended to the detected or provided command.',
      },
    },
    required: [],
  },
};

export async function runCommand(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
  const command = input.command as string;

  // Check on a background command
  if (input.command_id) {
    const session = getShellSession();
    const status = session.checkBackground(input.command_id as string);
    if (!status) return `No background command found with ID: ${input.command_id}`;
    const header = status.done
      ? `Background command finished (exit code: ${status.exitCode})`
      : `Background command still running`;
    return `${header}\n\nOutput:\n${status.output || '(no output yet)'}`;
  }

  // Start a background command
  if (input.background) {
    const session = getShellSession();
    const id = session.executeBackground(command);
    return `Background command started with ID: ${id}\nUse run_command with command_id="${id}" to check on it.`;
  }

  // Normal execution through the persistent shell session
  const session = getShellSession();
  const config = getConfig();
  const timeoutSec = (input.timeout as number) || config.shellTimeout || 120;
  try {
    const result = await session.execute(command, {
      timeout: timeoutSec * 1000,
      onOutput: context?.onOutput,
      signal: context?.signal,
    });
    const status = result.exitCode !== 0 ? `\n(exit code: ${result.exitCode})` : '';
    return result.stdout.trim() + status || '(no output)';
  } catch (err) {
    const error = err as { message?: string };
    return `Command failed:\n${error.message || 'Unknown error'}`;
  }
}

export async function runTests(input: Record<string, unknown>): Promise<string> {
  let command = input.command as string | undefined;
  const file = input.file as string | undefined;

  if (!command) {
    // Auto-detect test runner
    try {
      const pkgBytes = await workspace.fs.readFile(Uri.joinPath(getRootUri(), 'package.json'));
      const pkg = JSON.parse(Buffer.from(pkgBytes).toString('utf-8'));
      if (pkg.scripts?.test) {
        command = 'npm test';
      }
    } catch {
      /* no package.json */
    }

    if (!command) {
      // Check for common test files/configs
      const checks: [string, string][] = [
        ['pytest.ini', 'pytest'],
        ['setup.py', 'pytest'],
        ['pyproject.toml', 'pytest'],
        ['Cargo.toml', 'cargo test'],
        ['go.mod', 'go test ./...'],
        ['build.gradle', './gradlew test'],
        ['build.gradle.kts', './gradlew test'],
      ];
      for (const [configFile, testCmd] of checks) {
        try {
          await workspace.fs.stat(Uri.joinPath(getRootUri(), configFile));
          command = testCmd;
          break;
        } catch {
          /* not found */
        }
      }
    }

    if (!command) {
      return 'Could not detect test runner. Specify a command (e.g. "npm test", "pytest").';
    }
  }

  if (file) {
    // Defend against shell injection via the `file` parameter. The model
    // can (intentionally or via prompt injection) submit
    // `file: "foo.test.ts; rm -rf ~"`, and an unquoted interpolation
    // would execute both. Validate as a relative path first, then
    // reject anything containing shell metacharacters, then single-quote
    // the final value for POSIX shells.
    const pathError = validateFilePath(file);
    if (pathError) return `Invalid file path for run_tests: ${pathError}`;
    if (hasShellMetachar(file)) {
      return `Invalid file path for run_tests: "${file}" contains shell metacharacters. Use a plain relative path.`;
    }
    command += ` ${shellQuote(file)}`;
  }

  // Use persistent shell session for test execution
  const session = getShellSession();
  const config = getConfig();
  const timeoutSec = config.shellTimeout || 120;
  try {
    const result = await session.execute(command, { timeout: timeoutSec * 1000 });
    const status = result.exitCode !== 0 ? `\n(exit code: ${result.exitCode})` : '';
    return result.stdout.trim() + status || '(no output)';
  } catch (err) {
    const error = err as { message?: string };
    return `Test command failed: ${error.message || 'Unknown error'}`;
  }
}
