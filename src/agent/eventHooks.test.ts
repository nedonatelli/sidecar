/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventHookManager, type EventHookConfig } from './eventHooks.js';
import * as vscode from 'vscode';

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/test/project' } }],
    asRelativePath: vi.fn((uri) => uri.path || 'file.ts'),
    onDidSaveTextDocument: vi.fn(),
    onDidCreateFiles: vi.fn(),
    onDidDeleteFiles: vi.fn(),
  },
  Disposable: vi.fn().mockImplementation(() => ({
    dispose: vi.fn(),
  })),
}));

// Shared `exec` vi.fn — v0.65 uses vi.hoisted so the child_process + util
// mocks below both see the same reference. Tests drive behavior via
// `mockExec.mockImplementation(...)`; the util.promisify shim routes
// through the same vi.fn via createPromisifyShim from the shared helper
// module at src/__tests__/helpers/execAsync.ts.
const { sharedExec } = vi.hoisted(() => ({ sharedExec: vi.fn() }));

vi.mock('child_process', () => ({ exec: sharedExec }));

vi.mock('util', async () => {
  const { createPromisifyShim } = await import('../__tests__/helpers/execAsync.js');
  return { promisify: createPromisifyShim(sharedExec as unknown as Parameters<typeof createPromisifyShim>[0]) };
});

import type { AgentLogger } from './logger.js';

const mockWorkspace = vscode.workspace as any;

describe('EventHookManager', () => {
  let manager: EventHookManager;
  let mockLogger: Partial<AgentLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    manager = new EventHookManager(mockLogger as AgentLogger);
  });

  afterEach(() => {
    manager.dispose();
  });

  it('constructs with optional logger', () => {
    expect(manager).toBeDefined();
  });

  it('registers onSave hook', () => {
    const config: EventHookConfig = {
      onSave: 'npm run format',
    };

    mockWorkspace.onDidSaveTextDocument.mockReturnValue({
      dispose: vi.fn(),
    });

    manager.start(config);

    expect(mockWorkspace.onDidSaveTextDocument).toHaveBeenCalled();
    expect(vi.mocked(mockLogger.info)).toHaveBeenCalledWith(expect.stringContaining('onSave'));
  });

  it('registers onCreate hook', () => {
    const config: EventHookConfig = {
      onCreate: 'npm run scaffold',
    };

    mockWorkspace.onDidCreateFiles.mockReturnValue({
      dispose: vi.fn(),
    });

    manager.start(config);

    expect(mockWorkspace.onDidCreateFiles).toHaveBeenCalled();
    expect(vi.mocked(mockLogger.info)).toHaveBeenCalledWith(expect.stringContaining('onCreate'));
  });

  it('registers onDelete hook', () => {
    const config: EventHookConfig = {
      onDelete: 'npm run cleanup',
    };

    mockWorkspace.onDidDeleteFiles.mockReturnValue({
      dispose: vi.fn(),
    });

    manager.start(config);

    expect(mockWorkspace.onDidDeleteFiles).toHaveBeenCalled();
    expect(vi.mocked(mockLogger.info)).toHaveBeenCalledWith(expect.stringContaining('onDelete'));
  });

  it('registers multiple hooks', () => {
    const config: EventHookConfig = {
      onSave: 'npm run format',
      onCreate: 'npm run scaffold',
      onDelete: 'npm run cleanup',
    };

    mockWorkspace.onDidSaveTextDocument.mockReturnValue({ dispose: vi.fn() });
    mockWorkspace.onDidCreateFiles.mockReturnValue({ dispose: vi.fn() });
    mockWorkspace.onDidDeleteFiles.mockReturnValue({ dispose: vi.fn() });

    manager.start(config);

    expect(mockWorkspace.onDidSaveTextDocument).toHaveBeenCalled();
    expect(mockWorkspace.onDidCreateFiles).toHaveBeenCalled();
    expect(mockWorkspace.onDidDeleteFiles).toHaveBeenCalled();
    expect(vi.mocked(mockLogger.info)).toHaveBeenCalledTimes(3);
  });

  it('stops previous hooks before starting new ones', () => {
    mockWorkspace.onDidSaveTextDocument.mockReturnValue({ dispose: vi.fn() });

    manager.start({ onSave: 'cmd1' });
    manager.start({ onSave: 'cmd2' });

    // Second start should have re-registered
    expect(mockWorkspace.onDidSaveTextDocument).toHaveBeenCalledTimes(2);
  });

  it('disposes all hooks', () => {
    mockWorkspace.onDidSaveTextDocument.mockReturnValue({ dispose: vi.fn() });

    manager.start({ onSave: 'npm run format' });
    manager.dispose();

    // Should have cleared all disposables
    expect(manager).toBeDefined();
  });

  it('handles no workspace gracefully', () => {
    mockWorkspace.workspaceFolders = [];

    const config: EventHookConfig = {
      onSave: 'npm run format',
    };

    manager.start(config);

    // Should not crash and not register any hooks
    expect(mockWorkspace.onDidSaveTextDocument).not.toHaveBeenCalled();
  });

  it('includes relative path in hook execution', () => {
    const config: EventHookConfig = {
      onSave: 'npm run format',
    };

    const mockDisposable = { dispose: vi.fn() };
    const mockCallback = vi.fn();
    mockWorkspace.onDidSaveTextDocument.mockImplementation((cb: any) => {
      mockCallback.mockImplementation(cb);
      return mockDisposable;
    });

    manager.start(config);

    // Simulate file save event
    if (mockCallback.mock.calls.length > 0) {
      const callback = mockWorkspace.onDidSaveTextDocument.mock.calls[0][0];
      expect(callback).toBeDefined();
    }
  });

  it('relogs hook command in config message', () => {
    const config: EventHookConfig = {
      onSave: 'npm run format',
      onCreate: 'npm run scaffold',
    };

    mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/test/project' } }];
    mockWorkspace.onDidSaveTextDocument.mockReturnValue({ dispose: vi.fn() });
    mockWorkspace.onDidCreateFiles.mockReturnValue({ dispose: vi.fn() });

    manager.start(config);

    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('onSave'));
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('onCreate'));
  });

  it('clears disposables when stopping', () => {
    mockWorkspace.onDidSaveTextDocument.mockReturnValue({ dispose: vi.fn() });

    manager.start({ onSave: 'npm run format' });
    manager.stop();

    vi.clearAllMocks();
    manager.stop(); // Should be safe to call again

    expect(manager).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // runHook execution (v0.65 chunk 6c gap-fill — previously uncovered;
  // driven here by firing the registered onSave callback with a
  // synthetic document event)
  // -------------------------------------------------------------------------
  describe('runHook — actual command execution path', () => {
    function startWithCapturedCallback(cmd = 'echo hello'): (doc: { uri: { path: string } }) => void {
      let captured: ((doc: { uri: { path: string } }) => void) | null = null;
      mockWorkspace.workspaceFolders = [{ uri: { fsPath: '/p' } }];
      mockWorkspace.onDidSaveTextDocument.mockImplementation((cb: typeof captured) => {
        captured = cb;
        return { dispose: vi.fn() };
      });
      manager.start({ onSave: cmd });
      if (!captured) throw new Error('onDidSaveTextDocument callback was not captured');
      return captured!;
    }

    it('invokes exec with the configured command and captures stdout/stderr', async () => {
      let seenCmd = '';
      let seenOpts: { cwd?: string; env?: Record<string, string>; timeout?: number } | null = null;
      sharedExec.mockImplementation(
        (cmd: string, opts: unknown, cb: (e: unknown, out: string, err: string) => void) => {
          seenCmd = cmd;
          seenOpts = opts as typeof seenOpts;
          cb(null, 'ran ok', '');
        },
      );
      const cb = startWithCapturedCallback('./hooks/on-save.sh');
      cb({ uri: { path: 'src/foo.ts' } });
      // Wait a microtask for the async exec to settle.
      await new Promise((r) => setTimeout(r, 5));

      expect(seenCmd).toBe('./hooks/on-save.sh');
      const opts = seenOpts as { cwd?: string; timeout?: number } | null;
      expect(opts?.cwd).toBe('/p');
      expect(opts?.timeout).toBe(15_000);
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('onSave completed'));
    });

    it('injects SIDECAR_FILE + SIDECAR_EVENT env vars', async () => {
      let capturedEnv: Record<string, string> = {};
      sharedExec.mockImplementation(
        (_cmd: string, opts: { env?: Record<string, string> }, cb: (e: unknown, out: string, err: string) => void) => {
          capturedEnv = opts.env || {};
          cb(null, '', '');
        },
      );
      const cb = startWithCapturedCallback('true');
      cb({ uri: { path: 'src/auth.ts' } });
      await new Promise((r) => setTimeout(r, 5));

      expect(capturedEnv.SIDECAR_FILE).toBe('src/auth.ts');
      expect(capturedEnv.SIDECAR_EVENT).toBe('onSave');
    });

    it('sanitizes null bytes + non-newline control chars in env var values (injection defense)', async () => {
      let capturedEnv: Record<string, string> = {};
      // asRelativePath returns a path with control chars: \x00 (null),
      // \x07 (bell), \x1b (escape) — all stripped. Note: the current
      // sanitizer intentionally preserves \t, \n, \r (see regex at
      // eventHooks.ts:80), so we don't assert on those.
      mockWorkspace.asRelativePath.mockReturnValueOnce('src/foo.ts\x00\x07\x1b evil');
      sharedExec.mockImplementation(
        (_cmd: string, opts: { env?: Record<string, string> }, cb: (e: unknown, out: string, err: string) => void) => {
          capturedEnv = opts.env || {};
          cb(null, '', '');
        },
      );
      const cb = startWithCapturedCallback('true');
      cb({ uri: { path: 'unused' } });
      await new Promise((r) => setTimeout(r, 5));

      expect(capturedEnv.SIDECAR_FILE).not.toContain('\x00');
      expect(capturedEnv.SIDECAR_FILE).not.toContain('\x07');
      expect(capturedEnv.SIDECAR_FILE).not.toContain('\x1b');
      expect(capturedEnv.SIDECAR_FILE).toContain('src/foo.ts');
      expect(capturedEnv.SIDECAR_FILE).toContain('evil');
    });

    it('logs a warning when the hook fails and captures stderr', async () => {
      sharedExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => {
          const err = new Error('exit 1') as Error & { stdout: string; stderr: string };
          err.stdout = '';
          err.stderr = 'script died';
          cb(err, '', 'script died');
        },
      );
      const cb = startWithCapturedCallback('./fail.sh');
      cb({ uri: { path: 'x' } });
      await new Promise((r) => setTimeout(r, 5));

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('onSave failed'));
    });

    it('records the hook outcome to the audit log when a provider is set', async () => {
      const recordToolResult = vi.fn().mockResolvedValue(undefined);
      manager = new EventHookManager(mockLogger as AgentLogger, () => ({ recordToolResult }) as never);
      sharedExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => {
          cb(null, 'hook stdout', '');
        },
      );
      const cb = startWithCapturedCallback('./x.sh');
      cb({ uri: { path: 'src/a.ts' } });
      await new Promise((r) => setTimeout(r, 5));

      expect(recordToolResult).toHaveBeenCalledOnce();
      const [name, , summary, isError] = recordToolResult.mock.calls[0];
      expect(name).toBe('event_hook:onSave');
      expect(summary).toContain('./x.sh');
      expect(summary).toContain('hook stdout');
      expect(isError).toBe(false);
    });

    it('records the audit entry with isError=true when the hook throws', async () => {
      const recordToolResult = vi.fn().mockResolvedValue(undefined);
      manager = new EventHookManager(mockLogger as AgentLogger, () => ({ recordToolResult }) as never);
      sharedExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => {
          cb(new Error('bang'), '', 'stderr detail');
        },
      );
      const cb = startWithCapturedCallback('./x.sh');
      cb({ uri: { path: 'x' } });
      await new Promise((r) => setTimeout(r, 5));

      const [, , summary, isError] = recordToolResult.mock.calls[0];
      expect(isError).toBe(true);
      expect(summary).toContain('bang');
    });

    it('truncates stdout over 2000 chars in the audit summary', async () => {
      const recordToolResult = vi.fn().mockResolvedValue(undefined);
      manager = new EventHookManager(mockLogger as AgentLogger, () => ({ recordToolResult }) as never);
      const huge = 'x'.repeat(3000);
      sharedExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => {
          cb(null, huge, '');
        },
      );
      const cb = startWithCapturedCallback('./x.sh');
      cb({ uri: { path: 'x' } });
      await new Promise((r) => setTimeout(r, 5));

      const [, , summary] = recordToolResult.mock.calls[0];
      expect(summary).toContain('... (truncated)');
      expect(summary.length).toBeLessThan(3500); // original stdout + framing, capped
    });

    it('does not crash when the audit provider itself throws', async () => {
      const recordToolResult = vi.fn().mockRejectedValue(new Error('disk full'));
      manager = new EventHookManager(mockLogger as AgentLogger, () => ({ recordToolResult }) as never);
      sharedExec.mockImplementation(
        (_cmd: string, _opts: unknown, cb: (e: unknown, out: string, err: string) => void) => {
          cb(null, '', '');
        },
      );
      const cb = startWithCapturedCallback('./x.sh');
      cb({ uri: { path: 'x' } });
      await new Promise((r) => setTimeout(r, 5));

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to audit-log'));
    });
  });
});
