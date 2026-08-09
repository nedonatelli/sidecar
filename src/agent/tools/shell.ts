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

/** Call on extension deactivate to release the terminal and its VS Code event subscriptions. */
export function disposeAgentTerminalExecutor(): void {
  _defaultAgentTerminalExecutor?.dispose();
  _defaultAgentTerminalExecutor = null;
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
  // The shared VS Code terminal runs in the workspace root and can't be
  // re-rooted per run, so a cwd override (ShadowWorkspace / fork / facet) must
  // route through the ShellSession, which honors the per-run runtime's cwd.
  // Otherwise commands and tests would execute against the main tree instead
  // of the shadow the agent is editing.
  const terminalEnabled = cfg.terminalExecutionEnabled && context?.cwd === undefined;
  const terminal = terminalEnabled
    ? getAgentTerminalExecutor()
    : ({ execute: async () => null, dispose: () => {} } as never);
  return new CompositeShellExecutor(terminal, session, {
    terminalEnabled,
    fallbackToChildProcess: cfg.terminalExecutionFallbackToChildProcess,
  });
}

const JS_TS_EXT = /\.(jsx?|mjs|cjs|tsx?|mts|cts|vue)$/i;
const PY_EXT = /\.pyi?$/i;

/**
 * Catch a language-mismatched lint invocation before it runs: ESLint is a
 * JS/TS-only linter, but a model building a Python project will reach for it
 * out of habit (observed in dogfooding — `npx eslint calculator.py` errored
 * with a confusing "Oops! Something went wrong!"). When every explicit file
 * target is non-JS/TS and at least one is Python, redirect rather than run —
 * the confusing failure wastes a turn and teaches the model nothing.
 *
 * Returns a redirect message, or null when the command should run normally.
 */
export function detectLanguageMismatchedLint(command: string): string | null {
  if (!/(^|\s|\/)(eslint)\b/i.test(command)) return null;
  const fileTargets = command.split(/\s+/).filter((tok) => /\.[a-z]+$/i.test(tok) && !tok.startsWith('-'));
  if (fileTargets.length === 0) return null; // linting a dir/config-driven run — leave it alone
  if (fileTargets.some((f) => JS_TS_EXT.test(f))) return null; // has real JS/TS targets
  if (!fileTargets.some((f) => PY_EXT.test(f))) return null; // not the Python case
  return (
    'ESLint only lints JavaScript/TypeScript — it cannot check Python files. ' +
    'For static checks on edited code, call `get_diagnostics`. ' +
    'Edited Python is already parse-checked automatically before you finish. ' +
    'If you want Python linting specifically, run a Python linter via run_command (e.g. `ruff check .`, `python -m pyflakes <file>`), not ESLint.'
  );
}

// A program execution whose result is meaningful as verification: an
// interpreter running a file, or a test/build runner.
const PROGRAM_EXEC_RE =
  /(^|[\s;&|])(python3?|node|deno|bun|ruby|php)\s+[^\s;&|]+\.\w+|(^|[\s;&|])(pytest|jest|vitest|mocha|go\s+test|cargo\s+(test|run|build)|go\s+run|gradle|mvn)\b|(^|[\s;&|])(npm|pnpm|yarn)\s+(test|run|start)\b|(^|[\s;&|])python3?\s+-m\s+(pytest|unittest|py_compile)\b|(^|[\s;&|])(python3?\s+-c|node\s+-e|ruby\s+-e)\b/i;
// Masks that suppress failure/output of a command (NOT `|| echo`, which keeps a
// distinct success/fail signal the model can read).
const FAILURE_MASK_RE = /\|\|\s*true\b|2>\s*\/dev\/null|&>\s*\/dev\/null|>\s*\/dev\/null\s+2>&1/;

/**
 * Detect a command that RUNS a program for verification but masks its
 * failure (`|| true`, `2>/dev/null`, …). Such a command always "succeeds" and
 * swallows the crash/test-failure the agent is trying to detect — dogfooding
 * showed a model "verifying" a GUI with `python gui.py || true`, never seeing
 * the launch crash. Returns an advisory appended to the result (the command
 * still runs); null when no masked execution is present. `pkill … || true`
 * style cleanup is exempt — it isn't a program-execution verification.
 */
export function detectMaskedVerification(command: string): string | null {
  if (!PROGRAM_EXEC_RE.test(command) || !FAILURE_MASK_RE.test(command)) return null;
  return (
    '\n\n⚠️ This command masks failures (`|| true` / `2>/dev/null`), so it "succeeds" even if the program ' +
    'crashed or a test failed — it does NOT verify anything. Re-run it plainly (drop the `|| true` and ' +
    '`2>/dev/null`) and read the real exit code and full output, including any traceback, before treating ' +
    'the change as working.'
  );
}

/**
 * Shared execution helper: run `command` via the composite executor and
 * format the result as a tool-result string.
 */
async function executeShell(
  command: string,
  timeoutMs: number,
  context?: ToolExecutorContext,
  suggestBackgroundOnTimeout = false,
): Promise<string> {
  const executor = buildExecutor(context);
  try {
    const result = await executor.execute(command, {
      timeout: timeoutMs,
      onOutput: context?.onOutput,
      signal: context?.signal,
    });
    // A timeout on a foreground command almost always means the process doesn't
    // exit on its own — a GUI app (tkinter mainloop), a dev server, a file
    // watcher. We can't tell that from the command string ahead of time, but
    // the timeout is the unambiguous signal. Steer the model to re-run it in
    // the background so it doesn't burn another full timeout blocking the loop.
    // Only for run_command — run_tests has no background option, and a hung
    // test suite isn't a backgroundable app.
    if (result.timedOut && suggestBackgroundOnTimeout) {
      const secs = Math.round(timeoutMs / 1000);
      return (
        result.stdout.trim() +
        `\n\n⏱ Command did not exit within ${secs}s. If this is a long-running process ` +
        `(GUI app, dev server, file watcher) it won't return on its own — re-run it with ` +
        `\`background: true\` to launch it without blocking, then check output with \`command_id\`. ` +
        `If you only needed to confirm it starts, this timeout already shows it launched without crashing.`
      ).trim();
    }
    const status = result.exitCode !== 0 ? `\n(exit code: ${result.exitCode})` : '';
    return result.stdout.trim() + status || '(no output)';
  } catch (err) {
    const error = err as { message?: string };
    return `Command failed:\n${error.message || 'Unknown error'}`;
  }
}

/**
 * Run a one-shot verification command (the completion/syntax gate's parse
 * check) through the SAME terminal-first executor the agent's tools use, so it
 * resolves interpreters via the user's login-shell PATH.
 *
 * A raw ShellSession spawns a `--norc --noprofile` / `-f` shell whose minimal
 * PATH can make a bare `python3` hang (on macOS, `/usr/bin/python3` triggers a
 * Command Line Tools install prompt and never returns) — which made the syntax
 * gate's `py_compile` time out at 15s and silently pass a broken file. The
 * integrated terminal runs the user's login shell with the real PATH, exactly
 * like `run_tests`. Returns `timedOut` so callers can tell a timeout (which
 * must NOT be read as "parses cleanly") from a genuine result.
 */
export async function runVerificationCommand(
  command: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ exitCode: number; output: string; timedOut: boolean }> {
  const executor = buildExecutor();
  const r = await executor.execute(command, { timeout: timeoutMs, signal });
  return { exitCode: r.exitCode, output: r.stdout, timedOut: r.timedOut };
}

export const runCommandDef: ToolDefinition = {
  name: 'run_command',
  nondeterministicOutput: true,
  description:
    'Execute a shell command in a persistent shell session. Environment variables and working directory changes persist between calls (aliases and shell functions deliberately do not). ' +
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
  nondeterministicOutput: true,
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
  const command = input.command as string | undefined;

  if (!command && !input.command_id) {
    return (
      'Error: run_command requires either `command` (a shell string to execute) or `command_id` ' +
      '(the ID returned by a previous background call). Neither was provided.\n' +
      'Example: run_command({command: "ls -la"}) or run_command({command_id: "bg-abc123"})'
    );
  }
  if (command && input.command_id) {
    throw new Error('Error: `command` and `command_id` are mutually exclusive — provide one, not both.');
  }
  if (input.background && !command) {
    return (
      'Error: `background: true` requires a `command` string to run.\n' +
      'Example: run_command({command: "npm install", background: true})'
    );
  }

  // Command filter check (used by delegate_task worker to restrict to read-only commands)
  if (command && !input.command_id && context?.commandFilter && !context.commandFilter(command)) {
    return `Command rejected: "${command}" is not in the allowed list for this context. Only read-only commands (grep, cat, find, ls, etc.) are permitted.`;
  }

  // Steer away from language-mismatched lint commands (e.g. ESLint on .py files).
  if (command) {
    const mismatch = detectLanguageMismatchedLint(command);
    if (mismatch) return mismatch;
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

  // After the validation guards above, `command` is guaranteed to be a string
  // for every path that reaches here (command_id and background+no-command both
  // return early from the guards). Cast once to avoid repetitive `!` assertions.
  const cmd = command as string;

  // Start a background command — always ShellSession (no terminal equivalent)
  if (input.background) {
    const session = resolveShellSession(context);
    const id = session.executeBackground(cmd);
    return `Background command started with ID: ${id}\nUse run_command with command_id="${id}" to check on it.`;
  }

  const config = context?.config ?? getConfig();
  const timeoutMs = ((input.timeout as number) || config.shellTimeout || 120) * 1000;
  const output = await executeShell(cmd, timeoutMs, context, true);
  // Append an advisory when the command masks the failure of a program it ran
  // for verification — it "succeeded" but verified nothing.
  const maskWarning = detectMaskedVerification(cmd);
  return maskWarning ? output + maskWarning : output;
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

    // Python fallback: no pytest/manifest config, but test files exist
    // (test_*.py / *_test.py). Common for small scripts and from-scratch builds.
    // Prefer pytest when it's installed — it collects BOTH pytest-style plain
    // test classes AND unittest TestCase subclasses, whereas `python -m unittest`
    // collects ONLY TestCase subclasses. Dogfooding: a model wrote a pytest-style
    // `class TestX:` (no TestCase base); `python -m unittest` ran 0 tests, so the
    // behavioral gate's "passing test" requirement could never be satisfied via
    // run_tests. Fall back to unittest only when pytest isn't available (the
    // no-dependency path), so envs without pytest still work.
    if (!command) {
      const pyTests = await workspace.findFiles('**/{test_*,*_test}.py', '**/node_modules/**', 1);
      if (pyTests.length > 0) {
        let pytestAvailable = false;
        try {
          const probe = await buildExecutor(context).execute('python3 -m pytest --version', {
            timeout: 10_000,
            signal: context?.signal,
          });
          pytestAvailable = probe.exitCode === 0;
        } catch {
          /* treat as unavailable → unittest fallback */
        }
        if (pytestAvailable) {
          command = 'python3 -m pytest';
        } else {
          command = file ? 'python -m unittest' : 'python -m unittest discover';
        }
      }
    }

    if (!command) {
      // Workspace-aware guidance. The old unconditional hint suggested
      // `npm test` / `pytest` in workspaces that have neither — ministral ran
      // pytest against a TypeScript-only workspace, and the whole fleet burned
      // iterations chasing runners that cannot exist
      // (replace-todo-body-with-implementation, 2026-08-07). Point at a check
      // that CAN run here, or say plainly that none exists.
      const tsFiles = await workspace.findFiles('**/*.{ts,tsx}', '**/node_modules/**', 1);
      if (tsFiles.length > 0) {
        return (
          'Could not detect test runner: no test script, config, or test files exist in this workspace. ' +
          'For these TypeScript sources the available check is the compiler — run_command with `npx tsc --noEmit`. ' +
          'Do not guess at npm test or pytest here; neither is configured.'
        );
      }
      const pyFiles = await workspace.findFiles('**/*.py', '**/node_modules/**', 1);
      if (pyFiles.length > 0) {
        return (
          'Could not detect test runner: no test files or config exist in this workspace. ' +
          'For these Python sources the available check is the interpreter — run_command with `python3 -m py_compile <file>` ' +
          'or run the script directly. Do not guess at npm test here.'
        );
      }
      return (
        'Could not detect test runner, and this workspace has no test files or config. ' +
        'If tests exist elsewhere, specify the command explicitly; otherwise state that no automated check is available.'
      );
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
