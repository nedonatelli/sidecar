import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ManagedChildProcess, ProcessRegistry } from './processLifecycle.js';

// ---------------------------------------------------------------------------
// Tests for processLifecycle.ts (v0.70)
//
// ManagedChildProcess wraps ChildProcess with deterministic cleanup:
//   - Graceful close → SIGTERM → SIGKILL chain
//   - State tracking (running/closing/closed)
//   - Integration with ProcessRegistry
//
// ProcessRegistry is a singleton that:
//   - Tracks all managed processes
//   - Writes PID manifest for orphan detection
//   - Sweeps orphans from prior sessions on startup
// ---------------------------------------------------------------------------

describe('ManagedChildProcess', () => {
  let proc: ManagedChildProcess;

  beforeEach(() => {
    proc = new ManagedChildProcess();
  });

  afterEach(async () => {
    // Clean up any running process
    if (proc.isAlive) {
      await proc.close();
    }
  });

  describe('spawn', () => {
    it('spawns a process and sets state to running', () => {
      proc.spawn({
        name: 'test-echo',
        command: 'echo',
        args: ['hello'],
        skipRegistry: true,
      });

      expect(proc.state).toBe('running');
      expect(proc.pid).toBeDefined();
      expect(proc.info?.name).toBe('test-echo');
      expect(proc.info?.command).toBe('echo');
    });

    it('throws if called when already running', () => {
      proc.spawn({
        name: 'test-sleep',
        command: process.platform === 'win32' ? 'ping' : 'sleep',
        args: process.platform === 'win32' ? ['-n', '10', '127.0.0.1'] : ['10'],
        skipRegistry: true,
      });

      expect(() =>
        proc.spawn({
          name: 'test-sleep-2',
          command: 'sleep',
          args: ['10'],
          skipRegistry: true,
        }),
      ).toThrow(/already running/);
    });

    it('merges environment variables', () => {
      proc.spawn({
        name: 'test-env',
        command: process.platform === 'win32' ? 'cmd' : 'sh',
        args: process.platform === 'win32' ? ['/c', 'echo %TEST_VAR%'] : ['-c', 'echo $TEST_VAR'],
        env: { TEST_VAR: 'hello' },
        skipRegistry: true,
      });

      expect(proc.isAlive).toBe(true);
    });
  });

  describe('close', () => {
    it('closes a running process', async () => {
      proc.spawn({
        name: 'test-sleep',
        command: process.platform === 'win32' ? 'ping' : 'sleep',
        args: process.platform === 'win32' ? ['-n', '100', '127.0.0.1'] : ['100'],
        skipRegistry: true,
      });

      expect(proc.isAlive).toBe(true);

      await proc.close();

      expect(proc.state).toBe('closed');
      expect(proc.isAlive).toBe(false);
    });

    it('calls gracefulClose before killing', async () => {
      const gracefulClose = vi.fn();

      proc.spawn({
        name: 'test-sleep',
        command: process.platform === 'win32' ? 'ping' : 'sleep',
        args: process.platform === 'win32' ? ['-n', '100', '127.0.0.1'] : ['100'],
        skipRegistry: true,
        gracefulClose,
      });

      await proc.close();

      expect(gracefulClose).toHaveBeenCalled();
    });

    it('is idempotent — multiple close() calls resolve without error', async () => {
      proc.spawn({
        name: 'test-sleep',
        command: process.platform === 'win32' ? 'ping' : 'sleep',
        args: process.platform === 'win32' ? ['-n', '100', '127.0.0.1'] : ['100'],
        skipRegistry: true,
      });

      // Both should resolve without error
      await Promise.all([proc.close(), proc.close()]);
      expect(proc.state).toBe('closed');
    });

    it('resolves immediately if already closed', async () => {
      // Never spawned — should resolve immediately
      await expect(proc.close()).resolves.toBeUndefined();
    });
  });

  describe('events', () => {
    it('emits exit when process terminates', async () => {
      const exitHandler = vi.fn();
      proc.on('exit', exitHandler);

      proc.spawn({
        name: 'test-true',
        command: process.platform === 'win32' ? 'cmd' : 'true',
        args: process.platform === 'win32' ? ['/c', 'exit 0'] : [],
        skipRegistry: true,
      });

      // Wait for natural exit
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
      });

      expect(exitHandler).toHaveBeenCalled();
      expect(proc.state).toBe('closed');
    });
  });
});

describe('ProcessRegistry', () => {
  // Each test gets a fresh registry by resetting before and after
  beforeEach(() => {
    ProcessRegistry._reset();
  });

  afterEach(async () => {
    // Ensure all processes are cleaned up before resetting
    try {
      const registry = ProcessRegistry.instance;
      await registry.dispose();
    } catch {
      // Ignore errors
    }
    ProcessRegistry._reset();
  });

  describe('singleton', () => {
    it('returns the same instance', () => {
      const a = ProcessRegistry.instance;
      const b = ProcessRegistry.instance;
      expect(a).toBe(b);
    });

    it('generates a unique session ID', () => {
      const id = ProcessRegistry.instance.sessionId;
      expect(id).toMatch(/^\d+-[a-z0-9]+$/);
    });
  });

  describe('register/unregister', () => {
    it('tracks registered processes', () => {
      const proc = new ManagedChildProcess();
      proc.spawn({
        name: 'test-sleep',
        command: process.platform === 'win32' ? 'ping' : 'sleep',
        args: process.platform === 'win32' ? ['-n', '10', '127.0.0.1'] : ['10'],
        // Don't skip registry
      });

      expect(ProcessRegistry.instance.processCount).toBe(1);
      expect(ProcessRegistry.instance.get(proc.pid!)).toBe(proc);
    });

    it('unregisters on process exit', async () => {
      const registry = ProcessRegistry.instance;
      const proc = new ManagedChildProcess();

      proc.spawn({
        name: 'test-true',
        command: process.platform === 'win32' ? 'cmd' : 'true',
        args: process.platform === 'win32' ? ['/c', 'exit 0'] : [],
      });

      // Wait for natural exit
      await new Promise<void>((resolve) => {
        proc.once('exit', () => resolve());
      });

      // Small delay to let the unregister propagate
      await new Promise((r) => setTimeout(r, 50));

      expect(registry.processCount).toBe(0);
    });
  });

  describe('dispose', () => {
    it('closes all registered processes', async () => {
      // Get a fresh registry instance
      const registry = ProcessRegistry.instance;

      const proc1 = new ManagedChildProcess();
      const proc2 = new ManagedChildProcess();

      proc1.spawn({
        name: 'test-sleep-1',
        command: process.platform === 'win32' ? 'ping' : 'sleep',
        args: process.platform === 'win32' ? ['-n', '100', '127.0.0.1'] : ['100'],
      });

      proc2.spawn({
        name: 'test-sleep-2',
        command: process.platform === 'win32' ? 'ping' : 'sleep',
        args: process.platform === 'win32' ? ['-n', '100', '127.0.0.1'] : ['100'],
      });

      expect(registry.processCount).toBe(2);

      // Wait for both processes to fully exit
      const exitPromises = [
        new Promise<void>((resolve) => proc1.once('exit', () => resolve())),
        new Promise<void>((resolve) => proc2.once('exit', () => resolve())),
      ];

      await registry.dispose();
      await Promise.all(exitPromises);

      expect(proc1.state).toBe('closed');
      expect(proc2.state).toBe('closed');
      expect(registry.processCount).toBe(0);
    });

    it('is idempotent', async () => {
      const registry = ProcessRegistry.instance;
      await registry.dispose();
      await expect(registry.dispose()).resolves.toBeUndefined();
    });
  });

  describe('getAll', () => {
    it('returns all registered processes', async () => {
      const registry = ProcessRegistry.instance;

      const proc1 = new ManagedChildProcess();
      const proc2 = new ManagedChildProcess();

      proc1.spawn({
        name: 'test-1',
        command: process.platform === 'win32' ? 'ping' : 'sleep',
        args: process.platform === 'win32' ? ['-n', '10', '127.0.0.1'] : ['10'],
      });

      proc2.spawn({
        name: 'test-2',
        command: process.platform === 'win32' ? 'ping' : 'sleep',
        args: process.platform === 'win32' ? ['-n', '10', '127.0.0.1'] : ['10'],
      });

      const all = registry.getAll();
      expect(all).toHaveLength(2);
      expect(all).toContain(proc1);
      expect(all).toContain(proc2);

      // Clean up
      await registry.dispose();
    });
  });
});
