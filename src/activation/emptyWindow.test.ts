/* eslint-disable @typescript-eslint/no-explicit-any */
// Activation in a window with NO folder open (empty window): it threw
// '.sidecar directory not initialized', and the chat view and most commands
// were never registered. (#142)
// package.json activates on onStartupFinished, so this runs in every window.
import { describe, it, expect, vi } from 'vitest';
import * as vscode from 'vscode';

// The shared mock has no MarkdownString; the status bar builds its hover with one.
vi.mock('vscode', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  MarkdownString: class {
    value = '';
    isTrusted: unknown;
    supportThemeIcons = false;
    appendMarkdown(t: string) {
      this.value += t;
      return this;
    }
  },
}));

// Any namespace member the minimal mock lacks resolves to a no-op function
// returning a permissive object, so only REAL activation errors surface.
function anyObj(): any {
  const base: any = { dispose: () => {}, selection: [], visible: false, event: () => ({ dispose: () => {} }) };
  return new Proxy(base, {
    get(t, p) {
      if (p in t) return t[p];
      if (p === 'then' || typeof p === 'symbol') return undefined;
      return (..._a: unknown[]) => anyObj();
    },
    set(t, p, v) {
      t[p] = v;
      return true;
    },
  });
}
const fallbackProto = new Proxy(
  {},
  {
    get(_t, p) {
      if (p === 'then' || typeof p === 'symbol') return undefined;
      return (..._a: unknown[]) => anyObj();
    },
  },
);
for (const ns of ['workspace', 'window', 'commands', 'languages', 'chat', 'lm', 'env', 'extensions', 'tests']) {
  const o = (vscode as any)[ns];
  if (o) Object.setPrototypeOf(o, fallbackProto);
}

function memento(): any {
  const m = new Map<string, unknown>();
  return {
    get: (k: string, d?: unknown) => (m.has(k) ? m.get(k) : d),
    update: async (k: string, v: unknown) => void m.set(k, v),
    keys: () => [...m.keys()],
    setKeysForSync: () => {},
  };
}

function fakeContext(): any {
  return {
    subscriptions: [] as { dispose(): unknown }[],
    extensionPath: process.cwd(),
    extensionUri: { fsPath: process.cwd(), scheme: 'file', path: process.cwd() },
    storageUri: undefined,
    globalStorageUri: { fsPath: process.cwd() + '/.review-tmp-storage', scheme: 'file', path: '' },
    globalState: memento(),
    workspaceState: memento(),
    secrets: {
      get: async () => undefined,
      store: async () => {},
      delete: async () => {},
      onDidChange: () => ({ dispose() {} }),
    },
    extension: { id: 'nedonatelli.sidecar', packageJSON: { version: '0.127.0' } },
    asAbsolutePath: (p: string) => p,
  };
}

describe('activation in an empty window', () => {
  it('control: with a folder open, initCoreServices sets root synchronously and getPath works', async () => {
    (vscode.workspace as any).workspaceFolders = [{ uri: { fsPath: '/mock-workspace' }, name: 'mock', index: 0 }];
    const { initCoreServices } = await import('./servicesInit.js');
    const { sidecarDir } = initCoreServices(fakeContext());
    expect(() => sidecarDir!.getPath()).not.toThrow();
  });

  it('no folder: arena registration falls back to the home directory', async () => {
    (vscode.workspace as any).workspaceFolders = undefined;
    const { initCoreServices } = await import('./servicesInit.js');
    const { registerArenaCommands } = await import('./arenaSetup.js');
    const { getConfig } = await import('../config/settings.js');
    expect(getConfig().arenaEnabled).toBe(true);
    expect(getConfig().enableAgentMemory).toBe(true);
    const ctx = fakeContext();
    const { sidecarDir } = initCoreServices(ctx);
    let err: unknown;
    try {
      registerArenaCommands(ctx, (() => ({})) as any, sidecarDir);
    } catch (e) {
      err = e;
    }
    console.log('arena error:', (err as Error)?.message);
    expect(err).toBeUndefined(); // correct behavior: fall back to homedir path
  });

  it('no folder: activate() should not throw (asserts correct behavior)', async () => {
    (vscode.workspace as any).workspaceFolders = undefined;
    // Collections the minimal mock lacks; VS Code always provides them.
    (vscode.workspace as any).textDocuments = [];
    (vscode.window as any).visibleTextEditors = [];
    (vscode.window as any).tabGroups = { all: [], onDidChangeTabs: () => ({ dispose() {} }) };
    const ext = await import('../extension.js');
    const ctx = fakeContext();
    let err: unknown;
    try {
      ext.activate(ctx);
    } catch (e) {
      err = e;
    }
    const cmds = (vscode.commands as any).__registered ?? null;
    console.log(
      'activate error:',
      err instanceof Error
        ? err.message +
            String.fromCharCode(10) +
            err.stack?.split(String.fromCharCode(10)).slice(0, 7).join(String.fromCharCode(10))
        : err,
    );
    console.log('subscriptions registered before throw:', ctx.subscriptions.length, cmds);
    expect(err).toBeUndefined();
  }, 180_000);
});
