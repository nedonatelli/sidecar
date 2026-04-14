import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ToolExecutorContext } from './shared.js';

// End-to-end test for the per-call ToolRuntime seam: when a caller
// passes `context.toolRuntime`, `runCommand` and `runTests` must resolve
// their ShellSession from it, NOT from the default runtime. This is the
// contract BackgroundAgentManager relies on for parallel-agent isolation.

const { defaultRuntimeSpy, ShellSessionStub } = vi.hoisted(() => {
  class Stub {
    execute = vi.fn(async () => ({ stdout: 'ok', exitCode: 0, timedOut: false }));
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

import { runCommand, runTests } from './shell.js';

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
  });

  describe('runTests', () => {
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
  });
});
