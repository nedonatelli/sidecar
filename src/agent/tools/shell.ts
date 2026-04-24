import { workspace, Uri } from 'vscode';
import type { ToolDefinition } from '../../ollama/types.js';
import { getConfig } from '../../config/settings.js';
import {
  validateFilePath,
  shellQuote,
  hasShellMetachar,
  getRootUri,
  type ToolExecutorContext,
  type RegisteredTool,
} from './shared.js';
import { getDefaultToolRuntime } from './runtime.js';
import type { ShellSession, ShellResult } from '../../terminal/shellSession.js';
import { AgentTerminalExecutor } from '../../terminal/agentExecutor.js';

// Shell tools: run_command (generic shell) and run_tests (test-runner
// auto-detection). v0.59 splits execution into two layers:
//
//   1. AgentTerminalExecutor — first-choice path when
//      `sidecar.terminalExecution.enabled` is true and the terminal's
//      `shellIntegration` is available. Runs the command in a reusable
//      "SideCar Agent" terminal so the user sees the execution live,
//      streams stdout back via the shell-integration `read()` API, and
//      reads the exit code from `onDidEndTerminalShellExecution`.
//
//   2. ShellSession — fallback when terminal execution returns null
//      (shell integration unavailable) or when the user has disabled
//      the terminal path. Uses `child_process.spawn` with the hardened
//      per-command prefix. Kept for parity with pre-v0.59 behavior and
//      as a safety net for bare shells.
//
// Background commands always take the ShellSession path — the shell
// integration API has no `executeBackground` equivalent and the existing
// per-session background-tracking infrastructure is what consumers of
// `command_id` expect.

/**
 * Resolve the ShellSession for this tool call. When a per-call
 * `toolRuntime` is present on the context (BackgroundAgentManager
 * constructs one per run so parallel agents don't share cwd/env state),
 * we use its session. Otherwise we fall back to the process-wide default.
 */
function resolveShellSession(context?: ToolExecutorContext): ShellSession {
  const runtime = context?.toolRuntime ?? getDefaultToolRuntime();
  return runtime.getShellSession();
}

/**
 * Process-wide singleton executor. Shell integration state is per-terminal
 * and the reuse pattern is user-facing (user sees one terminal, not a new
 * one every command), so a single instance is the right shape. Spawned
 * lazily on first use.
 */
let _defaultAgentTerminalExecutor: AgentTerminalExecutor | null = null;

function getAgentTerminalExecutor(): AgentTerminalExecutor {
  if (!_defaultAgentTerminalExecutor) {
    const cfg = getConfig();
    _defaultAgentTerminalExecutor = new AgentTerminalExecutor({
      terminalName: cfg.terminalExecutionTerminalName,
      shellIntegrationTimeoutMs: cfg.terminalExecutionShellIntegrationTimeoutMs,
    });
  }
  return _defaultAgentTerminalExecutor;
}

/** Test-only hook to dispose the process-wide executor between runs. */
export function disposeAgentTerminalExecutor(): void {
  _defaultAgentTerminalExecutor?.dispose();
  _defaultAgentTerminalExecutor = null;
}

/**
 * Try the shell-integrated terminal path first. Returns the result on
 * success or `null` if the feature is disabled / integration is absent,
 * letting the caller fall back to `ShellSession`.
 */
async function tryTerminalExecute(
  command: string,
  timeoutMs: number,
  context?: ToolExecutorContext,
): Promise<ShellResult | null> {
  const cfg = context?.config ?? getConfig();
  if (!cfg.terminalExecutionEnabled) return null;
  const executor = getAgentTerminalExecutor();
  return executor.execute(command, {
    timeout: timeoutMs,
    onOutput: context?.onOutput,
    signal: context?.signal,
  });
}

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

  // Command filter check (used by delegate_task worker to restrict to read-only commands)
  // Skip for command_id lookups — those are always read-only (just checking status)
  if (command && !input.command_id && context?.commandFilter && !context.commandFilter(command)) {
    return `Command rejected: "${command}" is not in the allowed list for this context. Only read-only commands (grep, cat, find, ls, etc.) are permitted.`;
  }

  // Check on a background command
  if (input.command_id) {
    const session = resolveShellSession(context);
    const status = session.checkBackground(input.command_id as string);
    if (!status) return `No background command found with ID: ${input.command_id}`;
    const header = status.done
      ? `Background command finished (exit code: ${status.exitCode})`
      : `Background command still running`;
    return `${header}\n\nOutput:\n${status.output || '(no output yet)'}`;
  }

  // Start a background command
  if (input.background) {
    const session = resolveShellSession(context);
    const id = session.executeBackground(command);
    return `Background command started with ID: ${id}\nUse run_command with command_id="${id}" to check on it.`;
  }

  // Normal execution — try the shell-integrated terminal path first,
  // fall back to ShellSession if integration is unavailable or disabled.
  const config = context?.config ?? getConfig();
  const timeoutSec = (input.timeout as number) || config.shellTimeout || 120;
  const timeoutMs = timeoutSec * 1000;

  try {
    const terminalResult = await tryTerminalExecute(command, timeoutMs, context);
    if (terminalResult) {
      const status = terminalResult.exitCode !== 0 ? `\n(exit code: ${terminalResult.exitCode})` : '';
      return terminalResult.stdout.trim() + status || '(no output)';
    }
  } catch (err) {
    // Terminal path threw — fall through to ShellSession unless the user
    // explicitly disabled the fallback. This matches the
    // `terminalExecution.fallbackToChildProcess` contract from the
    // package.json description.
    if (!config.terminalExecutionFallbackToChildProcess) {
      const error = err as { message?: string };
      return `Command failed in terminal executor:\n${error.message || 'Unknown error'}`;
    }
  }
  if (!config.terminalExecutionFallbackToChildProcess && config.terminalExecutionEnabled) {
    return 'Command not executed: shell integration is unavailable and `sidecar.terminalExecution.fallbackToChildProcess` is false.';
  }

  const session = resolveShellSession(context);
  try {
    const result = await session.execute(command, {
      timeout: timeoutMs,
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

export async function runTests(input: Record<string, unknown>, context?: ToolExecutorContext): Promise<string> {
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

  // Test execution follows the same try-terminal-then-fall-back-to-
  // ShellSession dispatch as runCommand above. Tests benefit especially
  // from the terminal path: the user can watch test output scroll live
  // and jump to failures via the terminal's shell-integration gutter
  // markers.
  const config = context?.config ?? getConfig();
  const timeoutMs = (config.shellTimeout || 120) * 1000;

  try {
    const terminalResult = await tryTerminalExecute(command, timeoutMs, context);
    if (terminalResult) {
      const status = terminalResult.exitCode !== 0 ? `\n(exit code: ${terminalResult.exitCode})` : '';
      return terminalResult.stdout.trim() + status || '(no output)';
    }
  } catch (err) {
    if (!config.terminalExecutionFallbackToChildProcess) {
      const error = err as { message?: string };
      return `Test command failed in terminal executor: ${error.message || 'Unknown error'}`;
    }
  }
  if (!config.terminalExecutionFallbackToChildProcess && config.terminalExecutionEnabled) {
    return 'Tests not executed: shell integration is unavailable and `sidecar.terminalExecution.fallbackToChildProcess` is false.';
  }

  const session = resolveShellSession(context);
  try {
    const result = await session.execute(command, { timeout: timeoutMs });
    const status = result.exitCode !== 0 ? `\n(exit code: ${result.exitCode})` : '';
    return result.stdout.trim() + status || '(no output)';
  } catch (err) {
    const error = err as { message?: string };
    return `Test command failed: ${error.message || 'Unknown error'}`;
  }
}

export const shellTools: RegisteredTool[] = [
  { definition: runCommandDef, executor: runCommand, requiresApproval: true },
  { definition: runTestsDef, executor: runTests, requiresApproval: true },
];
