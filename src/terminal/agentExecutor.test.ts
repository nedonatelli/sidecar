/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { window } from 'vscode';
import { AgentTerminalExecutor } from './agentExecutor.js';

// Helpers to build a fake Terminal + fake ShellIntegration that the
// executor's duck-typed accessors understand. We don't rely on the real
// VS Code types — just the shape `AgentTerminalExecutor` duck-types
// against (`shellIntegration.executeCommand`, `read()`, event payloads).

interface FakeExecution {
  // Chunks the execution will yield via read(). Iteration completes when
  // the array runs out.
  chunks: string[];
  // Promise resolves when read() finishes iterating — lets tests await
  // "streaming has fully drained" before asserting.
  drained: Promise<void>;
}

function fakeExecution(chunks: string[]): FakeExecution {
  let resolveDrained!: () => void;
  const drained = new Promise<void>((r) => (resolveDrained = r));
  const asyncIter: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        async next() {
          if (i < chunks.length) return { value: chunks[i++], done: false };
          resolveDrained();
          return { value: undefined as never, done: true };
        },
      };
    },
  };
  return { chunks, drained, ...{ read: () => asyncIter } } as FakeExecution & { read: () => AsyncIterable<string> };
}

function makeFakeTerminal(opts: { withIntegration: boolean; executions?: FakeExecution[] }): {
  terminal: any;
  fireEndEvent: (ev: { execution: unknown; exitCode: number | undefined }) => void;
  sendTextCalls: string[];
  endListeners: Array<(ev: { execution: unknown; exitCode: number | undefined }) => void>;
} {
  const sendTextCalls: string[] = [];
  const endListeners: Array<(ev: { execution: unknown; exitCode: number | undefined }) => void> = [];
  const executions = opts.executions ?? [];
  let execIdx = 0;

  const integration = opts.withIntegration
    ? {
        executeCommand: (_cmd: string) => {
          // Hand back the next pre-queued execution, or a default empty
          // one so tests that don't care about chunks don't have to set
          // `executions` explicitly.
          const exec = executions[execIdx++] ?? fakeExecution([]);
          return exec;
        },
      }
    : undefined;

  const terminal = {
    show: () => {},
    sendText: (text: string) => {
      sendTextCalls.push(text);
    },
    dispose: () => {},
    exitStatus: undefined,
    shellIntegration: integration,
  };

  const fireEndEvent = (ev: { execution: unknown; exitCode: number | undefined }) => {
    for (const listener of endListeners) listener(ev);
  };

  return { terminal, fireEndEvent, sendTextCalls, endListeners };
}

describe('AgentTerminalExecutor', () => {
  let executor: AgentTerminalExecutor;

  beforeEach(() => {
    // Every test installs its own stubs; restore between tests so the
    // shared vscode mock stays clean for other describe blocks.
    vi.restoreAllMocks();
  });

  afterEach(() => {
    executor?.dispose();
  });

  describe('execute — integration unavailable', () => {
    it('returns null when the freshly created terminal has no shellIntegration', async () => {
      const { terminal } = makeFakeTerminal({ withIntegration: false });
      vi.spyOn(window, 'createTerminal').mockReturnValue(terminal as never);
      vi.spyOn(window, 'onDidCloseTerminal').mockReturnValue({ dispose: () => {} } as never);

      // Tight timeout — poll should fail fast rather than hang the test.
      executor = new AgentTerminalExecutor({ shellIntegrationTimeoutMs: 100 });
      const result = await executor.execute('echo hi');
      expect(result).toBeNull();
    });

    it('returns null when integration exists but executeCommand throws', async () => {
      const { terminal } = makeFakeTerminal({ withIntegration: true });
      // Replace the executeCommand with a thrower.
      (terminal as any).shellIntegration.executeCommand = () => {
        throw new Error('shell init still loading');
      };
      vi.spyOn(window, 'createTerminal').mockReturnValue(terminal as never);
      vi.spyOn(window, 'onDidCloseTerminal').mockReturnValue({ dispose: () => {} } as never);

      executor = new AgentTerminalExecutor({ shellIntegrationTimeoutMs: 100 });
      const result = await executor.execute('echo hi');
      expect(result).toBeNull();
    });
  });

  describe('execute — happy path', () => {
    it('drains streamed chunks and captures exit code from the end event', async () => {
      const exec = fakeExecution(['line1\n', 'line2\n', 'line3\n']);
      const { terminal } = makeFakeTerminal({
        withIntegration: true,
        executions: [exec],
      });
      vi.spyOn(window, 'createTerminal').mockReturnValue(terminal as never);
      vi.spyOn(window, 'onDidCloseTerminal').mockReturnValue({ dispose: () => {} } as never);
      // The executor subscribes to onDidEndTerminalShellExecution; we
      // capture the listener so we can fire the event ourselves.
      let endListener: ((ev: any) => void) | null = null;
      vi.spyOn(window as any, 'onDidEndTerminalShellExecution').mockImplementation(((listener: (ev: any) => void) => {
        endListener = listener;
        return { dispose: () => {} };
      }) as never);

      executor = new AgentTerminalExecutor({ shellIntegrationTimeoutMs: 100 });
      const execPromise = executor.execute('echo multiline');

      // Wait for the streaming loop to drain all three chunks, then fire
      // the end event with exit 0. Order matters only in that the end
      // event is the primary resolver — we could fire it with chunks
      // still pending and the test would still pass, but the realistic
      // ordering is "drain first, then end event."
      await exec.drained;
      endListener!({ execution: exec, exitCode: 0 });

      const result = await execPromise;
      expect(result).not.toBeNull();
      expect(result!.exitCode).toBe(0);
      expect(result!.stdout).toBe('line1\nline2\nline3\n');
      expect(result!.timedOut).toBe(false);
    });

    it('streams chunks to the onOutput callback as they arrive', async () => {
      const exec = fakeExecution(['chunk-a', 'chunk-b', 'chunk-c']);
      const { terminal } = makeFakeTerminal({ withIntegration: true, executions: [exec] });
      vi.spyOn(window, 'createTerminal').mockReturnValue(terminal as never);
      vi.spyOn(window, 'onDidCloseTerminal').mockReturnValue({ dispose: () => {} } as never);
      let endListener: ((ev: any) => void) | null = null;
      vi.spyOn(window as any, 'onDidEndTerminalShellExecution').mockImplementation(((listener: (ev: any) => void) => {
        endListener = listener;
        return { dispose: () => {} };
      }) as never);

      const streamed: string[] = [];
      executor = new AgentTerminalExecutor({ shellIntegrationTimeoutMs: 100 });
      const execPromise = executor.execute('run', {
        onOutput: (chunk) => streamed.push(chunk),
      });

      await exec.drained;
      endListener!({ execution: exec, exitCode: 0 });
      await execPromise;

      expect(streamed).toEqual(['chunk-a', 'chunk-b', 'chunk-c']);
    });

    it('reports exit code 7 correctly', async () => {
      const exec = fakeExecution(['fail output\n']);
      const { terminal } = makeFakeTerminal({ withIntegration: true, executions: [exec] });
      vi.spyOn(window, 'createTerminal').mockReturnValue(terminal as never);
      vi.spyOn(window, 'onDidCloseTerminal').mockReturnValue({ dispose: () => {} } as never);
      let endListener: ((ev: any) => void) | null = null;
      vi.spyOn(window as any, 'onDidEndTerminalShellExecution').mockImplementation(((listener: (ev: any) => void) => {
        endListener = listener;
        return { dispose: () => {} };
      }) as never);

      executor = new AgentTerminalExecutor({ shellIntegrationTimeoutMs: 100 });
      const execPromise = executor.execute('false');
      await exec.drained;
      endListener!({ execution: exec, exitCode: 7 });

      const result = await execPromise;
      expect(result!.exitCode).toBe(7);
      expect(result!.stdout).toBe('fail output\n');
    });

    it('ignores unrelated end events for other executions', async () => {
      const myExec = fakeExecution(['mine\n']);
      const otherExec = fakeExecution([]);
      const { terminal } = makeFakeTerminal({ withIntegration: true, executions: [myExec] });
      vi.spyOn(window, 'createTerminal').mockReturnValue(terminal as never);
      vi.spyOn(window, 'onDidCloseTerminal').mockReturnValue({ dispose: () => {} } as never);
      let endListener: ((ev: any) => void) | null = null;
      vi.spyOn(window as any, 'onDidEndTerminalShellExecution').mockImplementation(((listener: (ev: any) => void) => {
        endListener = listener;
        return { dispose: () => {} };
      }) as never);

      executor = new AgentTerminalExecutor({ shellIntegrationTimeoutMs: 100 });
      const execPromise = executor.execute('my command');
      await myExec.drained;
      // Fire an end event for a DIFFERENT execution first — it must be
      // ignored (execution identity mismatch).
      endListener!({ execution: otherExec, exitCode: 99 });
      // Give the event-handler a microtask to mis-fire if it's buggy.
      await new Promise((r) => setImmediate(r));
      // Now fire the correct one.
      endListener!({ execution: myExec, exitCode: 0 });

      const result = await execPromise;
      expect(result!.exitCode).toBe(0); // NOT 99
    });
  });

  describe('execute — timeout + abort', () => {
    it('sends SIGINT (^C) and resolves with timedOut=true on timeout', async () => {
      // Execution yields one chunk, then hangs forever (no more chunks,
      // no end event). The executor's own timeout should fire.
      let hangResolve!: () => void;
      const hangPromise = new Promise<void>((r) => (hangResolve = r));
      const hangingExec = {
        read: () => ({
          [Symbol.asyncIterator]() {
            let sent = false;
            return {
              async next() {
                if (!sent) {
                  sent = true;
                  return { value: 'starting...\n', done: false };
                }
                await hangPromise;
                return { value: undefined as never, done: true };
              },
            };
          },
        }),
      };
      const { terminal, sendTextCalls } = makeFakeTerminal({
        withIntegration: true,
        executions: [hangingExec as never],
      });
      vi.spyOn(window, 'createTerminal').mockReturnValue(terminal as never);
      vi.spyOn(window, 'onDidCloseTerminal').mockReturnValue({ dispose: () => {} } as never);
      vi.spyOn(window as any, 'onDidEndTerminalShellExecution').mockReturnValue({ dispose: () => {} } as never);

      executor = new AgentTerminalExecutor({ shellIntegrationTimeoutMs: 100 });
      const result = await executor.execute('sleep 999', { timeout: 150 });

      expect(result!.timedOut).toBe(true);
      expect(result!.stdout).toContain('timed out');
      // SIGINT byte sent to the terminal
      expect(sendTextCalls).toContain('\x03');

      hangResolve(); // let the mock's iterator shut down
    });

    it('sends SIGINT and resolves with timedOut=true when the abort signal fires', async () => {
      const hangingExec = {
        read: () => ({
          [Symbol.asyncIterator]() {
            return {
              async next() {
                await new Promise(() => {}); // never resolves
                return { value: undefined as never, done: true };
              },
            };
          },
        }),
      };
      const { terminal, sendTextCalls } = makeFakeTerminal({
        withIntegration: true,
        executions: [hangingExec as never],
      });
      vi.spyOn(window, 'createTerminal').mockReturnValue(terminal as never);
      vi.spyOn(window, 'onDidCloseTerminal').mockReturnValue({ dispose: () => {} } as never);
      vi.spyOn(window as any, 'onDidEndTerminalShellExecution').mockReturnValue({ dispose: () => {} } as never);

      const controller = new AbortController();
      executor = new AgentTerminalExecutor({ shellIntegrationTimeoutMs: 100 });
      const execPromise = executor.execute('sleep 999', { timeout: 10_000, signal: controller.signal });
      setTimeout(() => controller.abort(), 50);

      const result = await execPromise;
      expect(result!.timedOut).toBe(true);
      expect(result!.stdout).toContain('aborted');
      expect(sendTextCalls).toContain('\x03');
    });
  });

  describe('execute — terminal lifecycle', () => {
    it('resolves with a "terminal closed" marker when the terminal is disposed mid-execution', async () => {
      const hangingExec = {
        read: () => ({
          [Symbol.asyncIterator]() {
            return {
              async next() {
                await new Promise(() => {}); // hangs
                return { value: undefined as never, done: true };
              },
            };
          },
        }),
      };
      const { terminal } = makeFakeTerminal({ withIntegration: true, executions: [hangingExec as never] });
      vi.spyOn(window, 'createTerminal').mockReturnValue(terminal as never);
      let closeListener: ((t: unknown) => void) | null = null;
      vi.spyOn(window, 'onDidCloseTerminal').mockImplementation(((listener: (t: unknown) => void) => {
        closeListener = listener;
        return { dispose: () => {} };
      }) as never);
      vi.spyOn(window as any, 'onDidEndTerminalShellExecution').mockReturnValue({ dispose: () => {} } as never);

      executor = new AgentTerminalExecutor({ shellIntegrationTimeoutMs: 100 });
      const execPromise = executor.execute('sleep 999', { timeout: 10_000 });

      // Simulate the user closing the terminal while the command is running.
      setTimeout(() => closeListener?.(terminal), 50);

      const result = await execPromise;
      expect(result!.stdout).toContain('Terminal closed');
    });
  });
});
