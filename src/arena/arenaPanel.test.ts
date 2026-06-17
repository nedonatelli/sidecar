import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as vscode from 'vscode';
import { ArenaPanel } from './arenaPanel.js';
import type { ArenaToPanel, PanelToArena } from './types.js';

// ---------------------------------------------------------------------------
// Drives the real ArenaPanel through its static create() with a controllable
// fake webview panel: we capture the inbound message handler and record every
// outbound postMessage, then assert the routing / streaming / voting contract.
// ---------------------------------------------------------------------------

function makeFakePanel() {
  let handler: ((msg: PanelToArena) => unknown) | undefined;
  let disposeCb: (() => void) | undefined;
  const posted: ArenaToPanel[] = [];
  const panel = {
    webview: {
      html: '',
      cspSource: 'csp',
      asWebviewUri: (u: unknown) => u,
      onDidReceiveMessage: (cb: (msg: PanelToArena) => unknown) => {
        handler = cb;
        return { dispose() {} };
      },
      postMessage: async (m: ArenaToPanel) => {
        posted.push(m);
        return true;
      },
    },
    reveal() {},
    dispose() {},
    onDidDispose: (cb: () => void) => {
      disposeCb = cb;
      return { dispose() {} };
    },
    onDidChangeViewState: () => ({ dispose() {} }),
  };
  return {
    panel: panel as unknown as vscode.WebviewPanel,
    posted,
    receive: async (m: PanelToArena) => handler!(m),
    fireDispose: () => disposeCb?.(),
  };
}

function makeEloStore() {
  return {
    getRatings: () => ({ 'model-a': 1200, 'model-b': 1200 }),
    getState: () => ({}),
    getRating: () => 1200,
    recordWin: vi.fn(async () => {}),
  };
}

/** Async-generator streamChat fake: yields two text chunks, or throws for 'bad-model'. */
function makeClient() {
  return {
    streamChat: vi.fn(async function* (_messages: unknown, _signal: unknown, _t: unknown, _u: unknown, model: string) {
      if (model === 'bad-model') throw new Error('stream exploded');
      yield { type: 'text', text: `[${model}] hi` };
      yield { type: 'text', text: ' there' };
    }),
  };
}

const fakeContext = { extensionUri: vscode.Uri.file('/ext') } as unknown as vscode.ExtensionContext;

function postedCommands(posted: ArenaToPanel[]): string[] {
  return posted.map((m) => m.command);
}

describe('ArenaPanel', () => {
  let fake: ReturnType<typeof makeFakePanel>;
  let elo: ReturnType<typeof makeEloStore>;
  let client: ReturnType<typeof makeClient>;
  let onChangeModels: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Reset the singleton between tests.
    (ArenaPanel as unknown as { current: ArenaPanel | undefined }).current = undefined;
    fake = makeFakePanel();
    elo = makeEloStore();
    client = makeClient();
    onChangeModels = vi.fn(async () => undefined);
    vi.spyOn(vscode.window, 'createWebviewPanel').mockReturnValue(fake.panel);
  });

  afterEach(() => {
    (ArenaPanel as unknown as { current: ArenaPanel | undefined }).current = undefined;
    vi.restoreAllMocks();
  });

  function create(models = ['model-a', 'model-b']) {
    return ArenaPanel.create(fakeContext, client as never, elo as never, models, onChangeModels as never);
  }

  it('renders HTML and posts an init message with the models on create', () => {
    create();
    expect(fake.panel.webview.html.length).toBeGreaterThan(0);
    const init = fake.posted.find((m) => m.command === 'init');
    expect(init).toBeDefined();
    expect((init as { models: string[] }).models).toEqual(['model-a', 'model-b']);
  });

  it('reuses the singleton instead of creating a second panel', () => {
    create();
    create(['model-c', 'model-d']);
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);
  });

  it('responds to a ready message with init (models + ratings + stats)', async () => {
    create();
    fake.posted.length = 0;
    await fake.receive({ command: 'ready' });
    const init = fake.posted.find((m) => m.command === 'init') as
      | { models: string[]; ratings: unknown; stats: unknown }
      | undefined;
    expect(init).toBeDefined();
    expect(init!.models).toEqual(['model-a', 'model-b']);
    expect(init!.ratings).toEqual({ 'model-a': 1200, 'model-b': 1200 });
  });

  it('fans out a chat session: sessionStart, then a chunk + laneDone per model', async () => {
    create();
    fake.posted.length = 0;
    await fake.receive({ command: 'startChat', models: ['model-a', 'model-b'], prompt: 'hello' });

    expect(client.streamChat).toHaveBeenCalledTimes(2);
    expect(postedCommands(fake.posted)).toContain('sessionStart');

    const chunks = fake.posted.filter((m) => m.command === 'chunk') as { laneIndex: number; text: string }[];
    const dones = fake.posted.filter((m) => m.command === 'laneDone') as { laneIndex: number }[];
    expect(dones.map((d) => d.laneIndex).sort()).toEqual([0, 1]);
    // Lane 0 streamed model-a's text.
    expect(
      chunks
        .filter((c) => c.laneIndex === 0)
        .map((c) => c.text)
        .join(''),
    ).toBe('[model-a] hi there');
  });

  it('reports a per-lane error as laneError without failing the other lanes', async () => {
    create(['model-a', 'bad-model']);
    fake.posted.length = 0;
    await fake.receive({ command: 'startChat', models: ['model-a', 'bad-model'], prompt: 'go' });

    const errors = fake.posted.filter((m) => m.command === 'laneError') as { laneIndex: number; error: string }[];
    expect(errors).toHaveLength(1);
    expect(errors[0].laneIndex).toBe(1);
    expect(errors[0].error).toContain('stream exploded');
    // The healthy lane still completed.
    expect(fake.posted.some((m) => m.command === 'laneDone' && (m as { laneIndex: number }).laneIndex === 0)).toBe(
      true,
    );
  });

  it('records a vote against the current lane models and posts eloUpdate', async () => {
    create();
    // Run a session first — handleVote keys off the session's lane models.
    await fake.receive({ command: 'startChat', models: ['model-a', 'model-b'], prompt: 'hi' });
    fake.posted.length = 0;

    await fake.receive({ command: 'vote', winnerIndex: 0 });

    expect(elo.recordWin).toHaveBeenCalledWith('model-a', ['model-b']);
    expect(fake.posted.some((m) => m.command === 'eloUpdate')).toBe(true);
  });

  it('ignores a vote with no active session (no lane models)', async () => {
    create();
    fake.posted.length = 0;
    await fake.receive({ command: 'vote', winnerIndex: 0 });
    expect(elo.recordWin).not.toHaveBeenCalled();
  });

  it('changeModels updates the panel when the picker returns >= 2 models', async () => {
    onChangeModels.mockResolvedValueOnce(['model-x', 'model-y']);
    create();
    fake.posted.length = 0;

    await fake.receive({ command: 'changeModels' });

    expect(onChangeModels).toHaveBeenCalled();
    const init = fake.posted.find((m) => m.command === 'init') as { models: string[] } | undefined;
    expect(init?.models).toEqual(['model-x', 'model-y']);
  });

  it('changeModels leaves models unchanged when the picker is cancelled', async () => {
    onChangeModels.mockResolvedValueOnce(undefined);
    create();
    fake.posted.length = 0;

    await fake.receive({ command: 'changeModels' });
    expect(fake.posted.find((m) => m.command === 'init')).toBeUndefined();
  });
});
