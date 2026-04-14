import { describe, it, expect, vi, beforeEach } from 'vitest';

// Lazy counter for distinct stub shell sessions — lets the test assert
// identity (not just shape) without spawning a real shell process. Each
// `new ShellSession(...)` call bumps the counter and returns a fresh
// object keyed by it.
const { shellCounter, ShellSessionStub } = vi.hoisted(() => {
  const counter = { n: 0 };
  class Stub {
    readonly id: number;
    readonly cwd: string;
    isAlive = true;
    disposed = false;
    dispose = vi.fn(() => {
      this.disposed = true;
      this.isAlive = false;
    });
    constructor(cwd: string) {
      counter.n += 1;
      this.id = counter.n;
      this.cwd = cwd;
    }
  }
  return { shellCounter: counter, ShellSessionStub: Stub };
});

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/mock-root' } }],
  },
}));

vi.mock('../../config/settings.js', () => ({
  getConfig: () => ({ shellMaxOutputMB: 10 }),
}));

vi.mock('../../terminal/shellSession.js', () => ({
  ShellSession: ShellSessionStub,
}));

import { ToolRuntime, getDefaultToolRuntime, disposeShellSession, setSymbolGraph } from './runtime.js';

describe('ToolRuntime', () => {
  beforeEach(() => {
    shellCounter.n = 0;
  });

  describe('isolation between instances', () => {
    it('each ToolRuntime owns a distinct lazily-constructed ShellSession', () => {
      const a = new ToolRuntime();
      const b = new ToolRuntime();
      const sessionA = a.getShellSession();
      const sessionB = b.getShellSession();
      expect(sessionA).not.toBe(sessionB);
      // Stub counter should have ticked twice
      expect(shellCounter.n).toBe(2);
    });

    it('getShellSession is memoized within a runtime and returns the same session on repeat calls', () => {
      const runtime = new ToolRuntime();
      const first = runtime.getShellSession();
      const second = runtime.getShellSession();
      expect(first).toBe(second);
      expect(shellCounter.n).toBe(1);
    });

    it('disposing one runtime does not affect the other', () => {
      const a = new ToolRuntime();
      const b = new ToolRuntime();
      const sessionA = a.getShellSession();
      const sessionB = b.getShellSession();

      a.dispose();

      expect((sessionA as unknown as { disposed: boolean }).disposed).toBe(true);
      expect((sessionB as unknown as { disposed: boolean }).disposed).toBe(false);
    });
  });

  describe('dispose()', () => {
    it('tears down the current session and is safe to call twice', () => {
      const runtime = new ToolRuntime();
      const session = runtime.getShellSession() as unknown as { dispose: ReturnType<typeof vi.fn> };
      runtime.dispose();
      expect(session.dispose).toHaveBeenCalledTimes(1);
      expect(() => runtime.dispose()).not.toThrow();
    });

    it('allows a new session to be created after disposal (same runtime can be reused)', () => {
      const runtime = new ToolRuntime();
      const first = runtime.getShellSession();
      runtime.dispose();
      const second = runtime.getShellSession();
      expect(second).not.toBe(first);
      expect(shellCounter.n).toBe(2);
    });

    it('replaces a dead session on the next getShellSession call', () => {
      // If the underlying shell dies for some reason, the next accessor
      // must construct a fresh one rather than hand back the corpse.
      const runtime = new ToolRuntime();
      const dead = runtime.getShellSession() as unknown as { isAlive: boolean };
      dead.isAlive = false;
      const alive = runtime.getShellSession();
      expect(alive).not.toBe(dead);
    });
  });

  describe('getDefaultToolRuntime()', () => {
    it('returns the process-wide singleton consistently', () => {
      const a = getDefaultToolRuntime();
      const b = getDefaultToolRuntime();
      expect(a).toBe(b);
    });

    it('disposeShellSession() tears down the default runtime', () => {
      const runtime = getDefaultToolRuntime();
      const session = runtime.getShellSession() as unknown as { dispose: ReturnType<typeof vi.fn> };
      disposeShellSession();
      expect(session.dispose).toHaveBeenCalled();
    });
  });

  describe('setSymbolGraph()', () => {
    it('writes to the default runtime singleton', () => {
      const fakeGraph = { lookupSymbol: vi.fn() } as unknown as Parameters<typeof setSymbolGraph>[0];
      setSymbolGraph(fakeGraph);
      expect(getDefaultToolRuntime().symbolGraph).toBe(fakeGraph);
      // Reset for other tests
      setSymbolGraph(null);
      expect(getDefaultToolRuntime().symbolGraph).toBeNull();
    });

    it('symbolGraph is not shared between fresh ToolRuntime instances', () => {
      const a = new ToolRuntime();
      const b = new ToolRuntime();
      const fake = { lookupSymbol: vi.fn() } as unknown as Parameters<typeof setSymbolGraph>[0];
      a.symbolGraph = fake;
      expect(b.symbolGraph).toBeNull();
    });
  });
});
