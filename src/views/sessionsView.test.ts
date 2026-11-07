import { describe, it, expect, vi, beforeEach } from 'vitest';
import { commands, window, type Memento, type TreeDataProvider, type ExtensionContext } from 'vscode';
import { SessionManager } from '../agent/sessions.js';
import { registerSessionsView } from './sessionsView.js';

const created = vi.hoisted(() => ({ provider: null as unknown }));

vi.mock('vscode', async (importOriginal) => {
  const mod = await importOriginal<typeof import('vscode')>();
  return {
    ...mod,
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    window: {
      ...mod.window,
      createTreeView: (_id: string, opts: { treeDataProvider: unknown }) => {
        created.provider = opts.treeDataProvider;
        return { selection: [], dispose: () => {} };
      },
    },
  };
});

function memento(): Memento {
  const store = new Map<string, unknown>();
  return {
    get: (key: string, def?: unknown) => store.get(key) ?? def,
    update: (key: string, value: unknown) => {
      store.set(key, value);
      return Promise.resolve();
    },
    keys: () => [...store.keys()],
  } as unknown as Memento;
}

type Item = { session: { id: string; name: string } };

describe('Sessions view (#120)', () => {
  let state: Memento;
  let context: ExtensionContext;
  let provider: TreeDataProvider<Item> & { onDidChangeTreeData: (l: () => void) => void };

  beforeEach(() => {
    state = memento();
    context = { subscriptions: [] } as unknown as ExtensionContext;
    registerSessionsView(context, new SessionManager(state), {
      loadSession: () => {},
      saveCurrentSession: () => {},
      branchCurrentSession: () => {},
    });
    provider = created.provider as typeof provider;
  });

  const names = (items: Item[]) => items.map((i) => i.session.name).sort();

  it('shows a branch at the root once its parent is deleted', () => {
    const manager = new SessionManager(state);
    const parent = manager.save('parent', []);
    manager.branch(parent.id, 'branch', []);
    expect(names(provider.getChildren() as Item[])).toEqual(['parent']);

    manager.delete(parent.id);
    expect(names(provider.getChildren() as Item[])).toEqual(['branch']);
  });

  it('refreshes when another SessionManager saves, and stops after dispose', () => {
    const refreshed = vi.fn();
    provider.onDidChangeTreeData(refreshed);

    // The chat holds its own manager over the same storage.
    new SessionManager(state).save('from chat', []);
    expect(refreshed).toHaveBeenCalledTimes(1);

    for (const d of context.subscriptions) d.dispose();
    new SessionManager(state).save('after dispose', []);
    expect(refreshed).toHaveBeenCalledTimes(1);
  });
});

describe('Sessions view Branch (#419)', () => {
  function registerBranch(loadSession: () => void, branchCurrentSession: (name?: string) => void) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    vi.spyOn(commands, 'registerCommand').mockImplementation(((id: string, cb: (...args: unknown[]) => unknown) => {
      handlers.set(id, cb);
      return { dispose: () => {} };
    }) as never);
    const context = { subscriptions: [] } as unknown as ExtensionContext;
    registerSessionsView(context, new SessionManager(memento()), {
      loadSession,
      saveCurrentSession: () => {},
      branchCurrentSession,
    });
    return handlers.get('sidecar.sessions.branch')!;
  }
  const item = { session: { id: 's1', name: 'old work' } };

  beforeEach(() => vi.restoreAllMocks());

  it('does not load the session when the name prompt is cancelled', async () => {
    // Loading the session stops a running agent; a cancelled Branch used to do that anyway.
    const loadSession = vi.fn();
    const branch = vi.fn();
    vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined);
    await registerBranch(loadSession, branch)(item);
    expect(loadSession).not.toHaveBeenCalled();
    expect(branch).not.toHaveBeenCalled();
  });

  it('loads the session, then branches it, once named', async () => {
    const calls: string[] = [];
    vi.spyOn(window, 'showInputBox').mockImplementation(async () => {
      calls.push('ask');
      return 'try-b';
    });
    await registerBranch(
      () => calls.push('load'),
      (name) => calls.push('branch ' + name),
    )(item);
    expect(calls).toEqual(['ask', 'load', 'branch try-b']);
  });
});
