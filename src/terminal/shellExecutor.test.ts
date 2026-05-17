import { describe, it, expect, vi } from 'vitest';
import { CompositeShellExecutor } from './shellExecutor.js';
import type { ShellExecuteOptions, ShellResult } from './shellSession.js';

const makeTerminal = (result: ShellResult | null | Error) => ({
  execute: vi.fn(async (_cmd: string, _opts: ShellExecuteOptions) => {
    if (result instanceof Error) throw result;
    return result;
  }),
  dispose: vi.fn(),
});

const makeSession = (result?: ShellResult) => ({
  execute: vi.fn(async (_cmd: string, _opts: ShellExecuteOptions): Promise<ShellResult> => {
    return result ?? { stdout: 'session output', exitCode: 0, timedOut: false };
  }),
  executeBackground: vi.fn((_cmd: string) => 'bg-123'),
  checkBackground: vi.fn((_id: string) => ({ done: true, output: 'bg done', exitCode: 0 })),
  dispose: vi.fn(),
});

describe('CompositeShellExecutor', () => {
  describe('foreground execution — terminal path', () => {
    it('returns terminal result when integration available', async () => {
      const termResult: ShellResult = { stdout: 'terminal output', exitCode: 0, timedOut: false };
      const terminal = makeTerminal(termResult);
      const session = makeSession();
      const executor = new CompositeShellExecutor(terminal as never, session as never, {
        terminalEnabled: true,
        fallbackToChildProcess: true,
      });

      const result = await executor.execute('echo hi');
      expect(result.stdout).toBe('terminal output');
      expect(terminal.execute).toHaveBeenCalledOnce();
      expect(session.execute).not.toHaveBeenCalled();
    });

    it('falls back to session when terminal returns null', async () => {
      const terminal = makeTerminal(null);
      const session = makeSession();
      const executor = new CompositeShellExecutor(terminal as never, session as never, {
        terminalEnabled: true,
        fallbackToChildProcess: true,
      });

      const result = await executor.execute('echo hi');
      expect(result.stdout).toBe('session output');
      expect(terminal.execute).toHaveBeenCalledOnce();
      expect(session.execute).toHaveBeenCalledOnce();
    });

    it('falls back to session when terminal throws and fallback enabled', async () => {
      const terminal = makeTerminal(new Error('integration broken'));
      const session = makeSession();
      const executor = new CompositeShellExecutor(terminal as never, session as never, {
        terminalEnabled: true,
        fallbackToChildProcess: true,
      });

      const result = await executor.execute('echo hi');
      expect(result.stdout).toBe('session output');
      expect(session.execute).toHaveBeenCalledOnce();
    });

    it('rethrows terminal error when fallback disabled', async () => {
      const terminal = makeTerminal(new Error('integration broken'));
      const session = makeSession();
      const executor = new CompositeShellExecutor(terminal as never, session as never, {
        terminalEnabled: true,
        fallbackToChildProcess: false,
      });

      await expect(executor.execute('echo hi')).rejects.toThrow('integration broken');
      expect(session.execute).not.toHaveBeenCalled();
    });

    it('throws when terminal returns null and fallback disabled', async () => {
      const terminal = makeTerminal(null);
      const session = makeSession();
      const executor = new CompositeShellExecutor(terminal as never, session as never, {
        terminalEnabled: true,
        fallbackToChildProcess: false,
      });

      await expect(executor.execute('echo hi')).rejects.toThrow('shell integration is unavailable');
      expect(session.execute).not.toHaveBeenCalled();
    });
  });

  describe('foreground execution — terminal disabled', () => {
    it('uses session directly when terminalEnabled is false', async () => {
      const terminal = makeTerminal({ stdout: 'should not appear', exitCode: 0, timedOut: false });
      const session = makeSession();
      const executor = new CompositeShellExecutor(terminal as never, session as never, {
        terminalEnabled: false,
        fallbackToChildProcess: true,
      });

      const result = await executor.execute('echo hi');
      expect(result.stdout).toBe('session output');
      expect(terminal.execute).not.toHaveBeenCalled();
      expect(session.execute).toHaveBeenCalledOnce();
    });
  });

  describe('background commands', () => {
    it('executeBackground always uses session', () => {
      const terminal = makeTerminal(null);
      const session = makeSession();
      const executor = new CompositeShellExecutor(terminal as never, session as never, {
        terminalEnabled: true,
        fallbackToChildProcess: true,
      });

      const id = executor.executeBackground('sleep 60');
      expect(id).toBe('bg-123');
      expect(session.executeBackground).toHaveBeenCalledWith('sleep 60');
    });

    it('checkBackground always uses session', () => {
      const terminal = makeTerminal(null);
      const session = makeSession();
      const executor = new CompositeShellExecutor(terminal as never, session as never, {
        terminalEnabled: true,
        fallbackToChildProcess: true,
      });

      const status = executor.checkBackground('bg-123');
      expect(status?.done).toBe(true);
      expect(session.checkBackground).toHaveBeenCalledWith('bg-123');
    });
  });

  describe('dispose', () => {
    it('disposes both terminal and session', () => {
      const terminal = makeTerminal(null);
      const session = makeSession();
      const executor = new CompositeShellExecutor(terminal as never, session as never, {
        terminalEnabled: true,
        fallbackToChildProcess: true,
      });

      executor.dispose();
      expect(terminal.dispose).toHaveBeenCalledOnce();
      expect(session.dispose).toHaveBeenCalledOnce();
    });
  });
});
