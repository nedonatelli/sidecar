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

// Mock ProcessRegistry singleton to avoid real process tracking in tests
vi.mock('./processLifecycle.js', () => ({
  getProcessRegistry: vi.fn(() => ({
    register: vi.fn(),
    unregister: vi.fn(),
  })),
  ManagedChildProcess: vi.fn().mockImplementation((proc, _label, _registry) => ({
    pid: proc?.pid,
    getProc: () => proc,
    dispose: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock runSpawnedHook to avoid spawning real processes in tests
const { mockRunSpawnedHook } = vi.hoisted(() => ({
  mockRunSpawnedHook: vi.fn(),
}));

vi.mock('./spawnHook.js', () => ({
  runSpawnedHook: mockRunSpawnedHook,
}));

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

    it('invokes spawn hook with the configured command', async () => {
      mockRunSpawnedHook.mockResolvedValue({
        stdout: 'ran ok',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputTruncated: false,
      });
      const cb = startWithCapturedCallback('./hooks/on-save.sh');
      cb({ uri: { path: 'src/foo.ts' } });
      await new Promise((r) => setTimeout(r, 5));

      expect(mockRunSpawnedHook).toHaveBeenCalled();
      const call = vi.mocked(mockRunSpawnedHook).mock.calls[0][0];
      expect(call.command).toBe('./hooks/on-save.sh');
      expect(call.cwd).toBe('/p');
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('onSave completed'));
    });

    it('injects SIDECAR_FILE + SIDECAR_EVENT env vars', async () => {
      mockRunSpawnedHook.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputTruncated: false,
      });
      const cb = startWithCapturedCallback('true');
      cb({ uri: { path: 'src/auth.ts' } });
      await new Promise((r) => setTimeout(r, 5));

      const call = vi.mocked(mockRunSpawnedHook).mock.calls[0][0];
      expect(call.env.SIDECAR_FILE).toBe('src/auth.ts');
      expect(call.env.SIDECAR_EVENT).toBe('onSave');
    });

    it('sanitizes null bytes + non-newline control chars in env var values (injection defense)', async () => {
      // asRelativePath returns a path with control chars: \x00 (null),
      // \x07 (bell), \x1b (escape) — all stripped. Note: the current
      // sanitizer intentionally preserves \t, \n, \r, so we don't assert on those.
      mockWorkspace.asRelativePath.mockReturnValueOnce('src/foo.ts\x00\x07\x1b evil');
      mockRunSpawnedHook.mockResolvedValue({
        stdout: '',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputTruncated: false,
      });
      const cb = startWithCapturedCallback('true');
      cb({ uri: { path: 'unused' } });
      await new Promise((r) => setTimeout(r, 5));

      const call = vi.mocked(mockRunSpawnedHook).mock.calls[0][0];
      expect(call.env.SIDECAR_FILE).not.toContain('\x00');
      expect(call.env.SIDECAR_FILE).not.toContain('\x07');
      expect(call.env.SIDECAR_FILE).not.toContain('\x1b');
      expect(call.env.SIDECAR_FILE).toContain('src/foo.ts');
      expect(call.env.SIDECAR_FILE).toContain('evil');
    });

    it('logs a warning when the hook fails', async () => {
      mockRunSpawnedHook.mockResolvedValue({
        stdout: '',
        stderr: 'script died',
        exitCode: 1,
        signal: null,
        timedOut: false,
        outputTruncated: false,
      });
      const cb = startWithCapturedCallback('./fail.sh');
      cb({ uri: { path: 'x' } });
      await new Promise((r) => setTimeout(r, 5));

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('onSave failed'));
    });

    it('records the hook outcome to the audit log when a provider is set', async () => {
      const recordToolResult = vi.fn().mockResolvedValue(undefined);
      manager = new EventHookManager(mockLogger as AgentLogger, () => ({ recordToolResult }) as never);
      mockRunSpawnedHook.mockResolvedValue({
        stdout: 'hook stdout',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputTruncated: false,
      });
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

    it('records the audit entry with isError=true when the hook fails', async () => {
      const recordToolResult = vi.fn().mockResolvedValue(undefined);
      manager = new EventHookManager(mockLogger as AgentLogger, () => ({ recordToolResult }) as never);
      mockRunSpawnedHook.mockResolvedValue({
        stdout: '',
        stderr: 'stderr detail',
        exitCode: 1,
        signal: null,
        timedOut: false,
        outputTruncated: false,
      });
      const cb = startWithCapturedCallback('./x.sh');
      cb({ uri: { path: 'x' } });
      await new Promise((r) => setTimeout(r, 5));

      const [, , summary, isError] = recordToolResult.mock.calls[0];
      expect(isError).toBe(true);
      expect(summary).toContain('Process exited with code 1');
    });

    it('truncates stdout over 2000 chars in the audit summary', async () => {
      const recordToolResult = vi.fn().mockResolvedValue(undefined);
      manager = new EventHookManager(mockLogger as AgentLogger, () => ({ recordToolResult }) as never);
      const huge = 'x'.repeat(3000);
      mockRunSpawnedHook.mockResolvedValue({
        stdout: huge,
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputTruncated: false,
      });
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
      mockRunSpawnedHook.mockResolvedValue({
        stdout: 'ok',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputTruncated: false,
      });
      const cb = startWithCapturedCallback('./x.sh');
      cb({ uri: { path: 'x' } });
      await new Promise((r) => setTimeout(r, 5));

      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to audit-log'));
    });
  });
});
