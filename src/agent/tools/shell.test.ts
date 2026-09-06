import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolExecutorContext } from './shared.js';

// End-to-end test for the per-call ToolRuntime seam: when a caller
// passes `context.toolRuntime`, `runCommand` and `runTests` must resolve
// their ShellSession from it, NOT from the default runtime. This is the
// contract BackgroundAgentManager relies on for parallel-agent isolation.

const { defaultRuntimeSpy, ShellSessionStub } = vi.hoisted(() => {
  class Stub {
    execute = vi.fn(async (_cmd: string, _opts?: unknown) => ({ stdout: 'ok', exitCode: 0, timedOut: false }));
    executeBackground = vi.fn(() => 'bg-1');
    checkBackground = vi.fn(() => ({ done: true, exitCode: 0, output: 'done' }));
    dispose = vi.fn();
    isAlive = true;
  }
  const defaultSession = new Stub();
  // The default ToolRuntime — returned by getDefaultToolRuntime() in the
  // fallback branch. We use identity (`toBe`) in assertions to prove the
  // per-call runtime's session was chosen instead of this one.
  const defaultRuntime = {
    getShellSession: vi.fn(() => defaultSession),
    symbolGraph: null,
    dispose: vi.fn(),
  };
  return { defaultRuntimeSpy: defaultRuntime, ShellSessionStub: Stub };
});

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock' } }],
    fs: {
      readFile: vi.fn().mockRejectedValue(new Error('no package.json')),
      stat: vi.fn().mockRejectedValue(new Error('not found')),
    },
    findFiles: vi.fn().mockResolvedValue([]),
  },
  Uri: {
    joinPath: (base: { fsPath: string }, ...segs: string[]) => ({
      fsPath: base.fsPath + '/' + segs.join('/'),
    }),
  },
}));

vi.mock('../../config/settings.js', () => ({
  getConfig: () => ({ shellTimeout: 120, shellMaxOutputMB: 10 }),
}));

vi.mock('./runtime.js', () => ({
  getDefaultToolRuntime: () => defaultRuntimeSpy,
}));

import { runCommand, runTests, detectLanguageMismatchedLint, detectMaskedVerification } from './shell.js';
import { workspace } from 'vscode';

function makeContext(session: InstanceType<typeof ShellSessionStub>): ToolExecutorContext {
  return {
    toolRuntime: {
      getShellSession: () => session,
      dispose: () => undefined,
      symbolGraph: null,
    } as unknown as ToolExecutorContext['toolRuntime'],
  };
}

describe('shell tool runtime resolution', () => {
  beforeEach(() => {
    defaultRuntimeSpy.getShellSession.mockClear();
  });

  describe('runCommand', () => {
    it('uses the per-call ToolRuntime when context.toolRuntime is provided', async () => {
      const injected = new ShellSessionStub();
      await runCommand({ command: 'echo hi' }, makeContext(injected));
      expect(injected.execute).toHaveBeenCalledTimes(1);
      // Default runtime must never have been touched — that's the whole point.
      expect(defaultRuntimeSpy.getShellSession).not.toHaveBeenCalled();
    });

    it('falls back to the default runtime when no context is provided', async () => {
      await runCommand({ command: 'echo hi' });
      expect(defaultRuntimeSpy.getShellSession).toHaveBeenCalledTimes(1);
    });

    it('surfaces a background=true hint when a foreground command times out', async () => {
      const injected = new ShellSessionStub();
      injected.execute = vi.fn(async (_cmd: string, _opts?: unknown) => ({
        stdout: 'partial output',
        exitCode: 0,
        timedOut: true,
      }));
      const out = await runCommand({ command: 'python gui_calculator.py' }, makeContext(injected));
      expect(out).toContain('did not exit');
      expect(out).toContain('background: true');
      expect(out).toContain('partial output');
    });

    it('does NOT add the timeout hint when the command exits normally', async () => {
      const injected = new ShellSessionStub();
      const out = await runCommand({ command: 'ls' }, makeContext(injected));
      expect(out).not.toContain('did not exit');
    });

    it('routes background command starts through the per-call runtime', async () => {
      const injected = new ShellSessionStub();
      await runCommand({ command: 'sleep 1', background: true }, makeContext(injected));
      expect(injected.executeBackground).toHaveBeenCalledWith('sleep 1');
      expect(defaultRuntimeSpy.getShellSession).not.toHaveBeenCalled();
    });

    it('routes background status checks through the per-call runtime', async () => {
      const injected = new ShellSessionStub();
      const out = await runCommand({ command_id: 'bg-1' }, makeContext(injected));
      expect(injected.checkBackground).toHaveBeenCalledWith('bg-1');
      expect(out).toContain('Background command finished');
    });

    it('bypasses the shared VS Code terminal when a cwd override is active (shadow isolation)', async () => {
      // terminalExecution is ON here, but a shadow/fork/facet cwd is set. The
      // shared terminal can't be re-rooted per run, so it must be skipped — the
      // command has to route through the cwd-rooted ShellSession instead.
      // If the guard regressed, buildExecutor would construct AgentTerminalExecutor,
      // whose window.onDidCloseTerminal subscription throws under this vscode mock.
      const injected = new ShellSessionStub();
      const ctx = {
        cwd: '/tmp/.sidecar/shadows/task-1',
        config: { shellTimeout: 120, shellMaxOutputMB: 10, terminalExecutionEnabled: true },
        toolRuntime: { getShellSession: () => injected, dispose: () => undefined, symbolGraph: null },
      } as unknown as ToolExecutorContext;
      await expect(runCommand({ command: 'npm test' }, ctx)).resolves.toBeDefined();
      expect(injected.execute).toHaveBeenCalledTimes(1);
    });
  });

  describe('runTests', () => {
    it('names tsc as the available check in a TypeScript-only workspace (no runner anywhere)', async () => {
      // 2026-08 audit: the unconditional hint suggested npm test / pytest in
      // workspaces that have neither — ministral ran pytest against
      // TypeScript, llama burned its whole command budget chasing runners
      // that cannot exist (replace-todo-body-with-implementation).
      (workspace.findFiles as ReturnType<typeof vi.fn>).mockImplementation(async (pattern: unknown) =>
        String(pattern) === '**/*.{ts,tsx}' ? [{ fsPath: '/mock/src/clamp.ts' }] : [],
      );
      const out = await runTests({}, makeContext(new ShellSessionStub()));
      expect(out).toContain('npx tsc --noEmit');
      expect(out).toContain('Do not guess');
      expect(out).not.toContain('e.g. "npm test", "pytest"');
    });

    it('names the interpreter for a Python-only workspace with no test files', async () => {
      (workspace.findFiles as ReturnType<typeof vi.fn>).mockImplementation(async (pattern: unknown) =>
        String(pattern) === '**/*.py' ? [{ fsPath: '/mock/src/tool.py' }] : [],
      );
      const out = await runTests({}, makeContext(new ShellSessionStub()));
      expect(out).toContain('py_compile');
    });

    it('says plainly that no automated check exists when the workspace has neither', async () => {
      (workspace.findFiles as ReturnType<typeof vi.fn>).mockImplementation(async () => []);
      const out = await runTests({}, makeContext(new ShellSessionStub()));
      expect(out).toContain('no automated check is available');
    });

    it('uses the per-call ToolRuntime when context.toolRuntime is provided', async () => {
      const injected = new ShellSessionStub();
      // No command, no test-runner config → returns the "could not detect"
      // string BEFORE touching any shell session. Supply an explicit
      // command so we exercise the session path.
      await runTests({ command: 'npm test' }, makeContext(injected));
      expect(injected.execute).toHaveBeenCalledTimes(1);
      expect(defaultRuntimeSpy.getShellSession).not.toHaveBeenCalled();
    });

    it('falls back to the default runtime when no context is provided', async () => {
      await runTests({ command: 'npm test' });
      expect(defaultRuntimeSpy.getShellSession).toHaveBeenCalledTimes(1);
    });

    it('prefers pytest when the pytest probe succeeds (collects pytest-style AND unittest tests)', async () => {
      (workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ fsPath: '/mock/test_calc.py' }]);
      const injected = new ShellSessionStub(); // execute → exitCode 0 by default → probe "succeeds"
      await runTests({ file: 'test_calc.py' }, makeContext(injected));
      // call 0 = the `pytest --version` probe, call 1 = the actual run
      expect(injected.execute.mock.calls[0][0]).toBe('python3 -m pytest --version');
      expect(injected.execute.mock.calls[1][0]).toBe("python3 -m pytest 'test_calc.py'");
    });

    it('falls back to `python -m unittest` when pytest is NOT available', async () => {
      (workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ fsPath: '/mock/test_calc.py' }]);
      const injected = new ShellSessionStub();
      // Probe (pytest --version) reports pytest missing → exitCode 1; the run keeps default.
      injected.execute = vi.fn(async (cmd: string) =>
        cmd.includes('pytest --version')
          ? { stdout: 'No module named pytest', exitCode: 1, timedOut: false }
          : { stdout: 'ok', exitCode: 0, timedOut: false },
      );
      await runTests({ file: 'test_calc.py' }, makeContext(injected));
      expect(injected.execute.mock.calls[1][0]).toBe("python -m unittest 'test_calc.py'");
    });

    it('uses `unittest discover` (no file) when pytest is unavailable and no file is given', async () => {
      (workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce([{ fsPath: '/mock/test_calc.py' }]);
      const injected = new ShellSessionStub();
      injected.execute = vi.fn(async (cmd: string) =>
        cmd.includes('pytest --version')
          ? { stdout: '', exitCode: 1, timedOut: false }
          : { stdout: 'ok', exitCode: 0, timedOut: false },
      );
      await runTests({}, makeContext(injected));
      expect(injected.execute.mock.calls[1][0]).toBe('python -m unittest discover');
    });

    it('still reports "could not detect" when no manifest and no Python test files exist', async () => {
      (workspace.findFiles as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
      const out = await runTests({});
      expect(out).toContain('Could not detect test runner');
    });
  });

  describe('detectMaskedVerification', () => {
    it('flags running a script with || true (masked launch — the dogfood case)', () => {
      const msg = detectMaskedVerification('python gui_calculator.py || true');
      expect(msg).not.toBeNull();
      expect(msg).toContain('masks failures');
    });

    it('flags a test run that suppresses errors with 2>/dev/null', () => {
      expect(detectMaskedVerification('npm test 2>/dev/null')).not.toBeNull();
      expect(detectMaskedVerification('python3 -m pytest 2>/dev/null')).not.toBeNull();
    });

    it('flags a backgrounded launch followed by masked cleanup (launch-and-discard)', () => {
      expect(detectMaskedVerification('python3 gui.py & sleep 1; pkill -f gui.py || true')).not.toBeNull();
    });

    it('flags a masked python -c inline smoke test (the iter-7 dogfood gap)', () => {
      expect(
        detectMaskedVerification(
          'python3 -c "from gui_calculator import CalculatorApp; CalculatorApp(None)" 2>&1 || true',
        ),
      ).not.toBeNull();
      expect(detectMaskedVerification('node -e "require(\'./app\')" 2>/dev/null')).not.toBeNull();
    });

    it('does NOT flag a plain verification run (no mask)', () => {
      expect(detectMaskedVerification('python gui_calculator.py')).toBeNull();
      expect(detectMaskedVerification('npm test')).toBeNull();
      expect(detectMaskedVerification('python3 -m py_compile gui.py')).toBeNull();
    });

    it('does NOT flag pure cleanup with || true (no program execution to verify)', () => {
      expect(detectMaskedVerification('pkill -f gui_calculator.py || true')).toBeNull();
      expect(detectMaskedVerification('rm -f out.tmp 2>/dev/null')).toBeNull();
    });

    it('does NOT flag a status-reporting `|| echo` idiom (it keeps a fail signal)', () => {
      expect(detectMaskedVerification('python3 -m py_compile gui.py && echo OK || echo FAILED')).toBeNull();
    });

    it('runCommand appends the advisory to a masked verification result', async () => {
      const injected = new ShellSessionStub();
      const out = await runCommand({ command: 'python gui_calculator.py || true' }, makeContext(injected));
      expect(out).toContain('masks failures');
      expect(injected.execute).toHaveBeenCalled(); // the command still runs
    });
  });

  describe('detectLanguageMismatchedLint', () => {
    it('redirects eslint run against only Python files', () => {
      const msg = detectLanguageMismatchedLint('npx eslint calculator.py test_calc.py');
      expect(msg).not.toBeNull();
      expect(msg).toContain('get_diagnostics');
    });

    it('leaves a real JS/TS eslint run alone', () => {
      expect(detectLanguageMismatchedLint('npx eslint src/foo.ts')).toBeNull();
      expect(detectLanguageMismatchedLint('eslint a.py b.js')).toBeNull(); // has a JS target
    });

    it('leaves config-driven / directory eslint runs alone (no file targets)', () => {
      expect(detectLanguageMismatchedLint('npx eslint .')).toBeNull();
      expect(detectLanguageMismatchedLint('eslint --fix')).toBeNull();
    });

    it('ignores non-eslint commands', () => {
      expect(detectLanguageMismatchedLint('python -m unittest test_calc.py')).toBeNull();
    });

    it('runCommand returns the redirect without executing eslint on Python', async () => {
      const injected = new ShellSessionStub();
      const out = await runCommand({ command: 'npx eslint calculator.py' }, makeContext(injected));
      expect(out).toContain('ESLint only lints');
      expect(injected.execute).not.toHaveBeenCalled();
    });
  });

  describe('commandFilter', () => {
    it('rejects commands that fail the filter', async () => {
      const injected = new ShellSessionStub();
      const ctx: ToolExecutorContext = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolRuntime: { getShellSession: () => injected, symbolGraph: null, dispose: vi.fn() } as any,
        commandFilter: (cmd) => cmd.startsWith('cat '), // Only allow cat
      };
      const result = await runCommand({ command: 'rm -rf /' }, ctx);
      expect(result).toContain('Command rejected');
      expect(injected.execute).not.toHaveBeenCalled();
    });

    it('allows commands that pass the filter', async () => {
      const injected = new ShellSessionStub();
      const ctx: ToolExecutorContext = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolRuntime: { getShellSession: () => injected, symbolGraph: null, dispose: vi.fn() } as any,
        commandFilter: (cmd) => cmd.startsWith('cat '),
      };
      await runCommand({ command: 'cat file.txt' }, ctx);
      expect(injected.execute).toHaveBeenCalledTimes(1);
    });

    it('does not apply filter to background status checks', async () => {
      const injected = new ShellSessionStub();
      const ctx: ToolExecutorContext = {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toolRuntime: { getShellSession: () => injected, symbolGraph: null, dispose: vi.fn() } as any,
        commandFilter: () => false, // Reject everything
      };
      // command_id lookups should still work even with a restrictive filter
      const result = await runCommand({ command_id: 'bg-1' }, ctx);
      expect(result).toContain('Background command finished');
    });
  });
});
