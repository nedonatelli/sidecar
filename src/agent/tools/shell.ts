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
import type { ShellSession } from '../../terminal/shellSession.js';
import { AgentTerminalExecutor } from '../../terminal/agentExecutor.js';
import { CompositeShellExecutor } from '../../terminal/shellExecutor.js';

// Shell tools: run_command (generic shell) and run_tests (test-runner
// auto-detection). v0.92 unifies the two execution paths behind
// CompositeShellExecutor: the terminal (shell-integration) path is tried
// first; ShellSession is the fallback. Background commands always route
// to ShellSession — the shell-integration API has no background-execution
// equivalent.

/**
 * Resolve the ShellSession for this tool call. When a per-call
 * `toolRuntime` is present on the context (BackgroundAgentManager
 * constructs one per run so parallel agents don't share cwd/env state),
 * we use its session. Otherwise we fall back to the process-wide default.
 */
function resolveShellSession(context?: ToolExecutorContext): ShellSession {
  const runtime = context?.toolRuntime ?? getDefaultToolRuntime();
  return runtime.getShellSession(context?.config);
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

/**
 * Build a CompositeShellExecutor for the current tool call, wiring the
 * process-wide terminal executor against the per-context shell session.
 *
 * AgentTerminalExecutor is only constructed when terminalExecution is enabled
 * — its constructor subscribes to window.onDidCloseTerminal, which fails in
 * test environments that don't provide a window mock. When the terminal path
 * is disabled a no-op placeholder satisfies the interface and is never called.
 */
function buildExecutor(context?: ToolExecutorContext): CompositeShellExecutor {
  const cfg = context?.config ?? getConfig();
  const session = resolveShellSession(context);
  const terminalEnabled = cfg.terminalExecutionEnabled;
  const terminal = terminalEnabled
    ? getAgentTerminalExecutor()
    : ({ execute: async () => null, dispose: () => {} } as never);
  return new CompositeShellExecutor(terminal, session, {
    terminalEnabled,
    fallbackToChildProcess: cfg.terminalExecutionFallbackToChildProcess,
  });
}

/**
 * Shared execution helper: run `command` via the composite executor and
 * format the result as a tool-result string.
 */
async function executeShell(command: string, timeoutMs: number, context?: ToolExecutorContext): Promise<string> {
  const executor = buildExecutor(context);
  try {
    const result = await executor.execute(command, {
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
    'Per operating rule 6: call `get_diagnostics` first after edits (fast type/lint check), then `run_tests` to verify behaviour. ' +
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

  // Start a background command — always ShellSession (no terminal equivalent)
  if (input.background) {
    const session = resolveShellSession(context);
    const id = session.executeBackground(command);
    return `Background command started with ID: ${id}\nUse run_command with command_id="${id}" to check on it.`;
  }

  const config = context?.config ?? getConfig();
  const timeoutMs = ((input.timeout as number) || config.shellTimeout || 120) * 1000;
  return executeShell(command, timeoutMs, context);
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
    const pathError = validateFilePath(file);
    if (pathError) return `Invalid file path for run_tests: ${pathError}`;
    if (hasShellMetachar(file)) {
      return `Invalid file path for run_tests: "${file}" contains shell metacharacters. Use a plain relative path.`;
    }
    command += ` ${shellQuote(file)}`;
  }

  const config = context?.config ?? getConfig();
  const timeoutMs = (config.shellTimeout || 120) * 1000;
  const output = await executeShell(command, timeoutMs, context);
  context?.testController?.reportRun(command, output);
  return output;
}

export const shellTools: RegisteredTool[] = [
  { definition: runCommandDef, executor: runCommand, requiresApproval: true },
  { definition: runTestsDef, executor: runTests, requiresApproval: true },
];
