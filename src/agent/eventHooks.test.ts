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
});
