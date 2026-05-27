import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openArena, openArenaAgent, type ArenaCommandDeps } from './arenaCommands.js';
import { window } from 'vscode';
import { ELO_DEFAULT_RATING } from './types.js';
import { checkMemoryPreflight } from '../system/memoryMonitor.js';

vi.mock('./arenaPanel.js', () => ({
  ArenaPanel: { create: vi.fn() },
}));

vi.mock('../system/memoryMonitor.js', () => ({
  checkMemoryPreflight: vi.fn().mockResolvedValue(true),
}));

vi.mock('../agent/fork/forkDispatcher.js', () => ({
  dispatchForks: vi.fn().mockResolvedValue([]),
}));

vi.mock('../agent/fork/forkReview.js', () => ({
  reviewForkBatch: vi.fn().mockResolvedValue({ winnerIndex: null, appliedOk: false, skippedLabels: [] }),
}));

function makeClient(models: string[] = ['llama3:8b', 'qwen3:8b']) {
  return { listInstalledModels: vi.fn().mockResolvedValue(models.map((name) => ({ name }))) };
}

function makeEloStore(rating = ELO_DEFAULT_RATING) {
  return {
    getRating: vi.fn().mockReturnValue(rating),
    recordWin: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue({ ratings: {}, wins: {}, losses: {}, totalMatches: 0 }),
  };
}

/** Returns a deps object + the raw eloStore mock for assertion. */
function makeSetup(
  overrides: { models?: string[]; preFilledModels?: string[]; preFilledTask?: string; failingClient?: boolean } = {},
) {
  const store = makeEloStore();
  const client = overrides.failingClient
    ? { listInstalledModels: vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) }
    : makeClient(overrides.models);
  const deps = {
    context: {},
    createClient: () => client,
    eloStore: store,
    ...(overrides.preFilledModels ? { preFilledModels: overrides.preFilledModels } : {}),
    ...(overrides.preFilledTask ? { preFilledTask: overrides.preFilledTask } : {}),
  } as unknown as ArenaCommandDeps;
  return { deps, store };
}

describe('openArena', () => {
  let quickPick: ReturnType<typeof vi.spyOn>;
  let inputBox: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkMemoryPreflight).mockResolvedValue(true);
    quickPick = vi.spyOn(window, 'showQuickPick').mockResolvedValue(undefined as never);
    inputBox = vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined as never);
  });

  it('opens ArenaPanel with pre-filled models (skips QuickPick)', async () => {
    const { ArenaPanel } = await import('./arenaPanel.js');
    const { deps } = makeSetup({ preFilledModels: ['a:latest', 'b:latest'] });

    await openArena(deps);

    expect(ArenaPanel.create).toHaveBeenCalledWith(
      deps.context,
      expect.anything(),
      deps.eloStore,
      ['a:latest', 'b:latest'],
      expect.any(Function),
    );
    expect(quickPick).not.toHaveBeenCalled();
  });

  it('shows QuickPick when fewer than 2 pre-filled models', async () => {
    const { ArenaPanel } = await import('./arenaPanel.js');
    quickPick.mockResolvedValue([{ label: 'llama3:8b' }, { label: 'qwen3:8b' }] as never);
    const { deps } = makeSetup({ preFilledModels: ['only-one'] });

    await openArena(deps);

    expect(quickPick).toHaveBeenCalled();
    expect(ArenaPanel.create).toHaveBeenCalled();
  });

  it('returns early when user cancels model QuickPick', async () => {
    const { ArenaPanel } = await import('./arenaPanel.js');
    quickPick.mockResolvedValue(undefined);

    await openArena(makeSetup().deps);

    expect(ArenaPanel.create).not.toHaveBeenCalled();
  });

  it('returns early when fewer than 2 models are picked', async () => {
    const { ArenaPanel } = await import('./arenaPanel.js');
    quickPick.mockResolvedValue([{ label: 'llama3:8b' }] as never);

    await openArena(makeSetup().deps);

    expect(ArenaPanel.create).not.toHaveBeenCalled();
  });

  it('falls back to free-text entry when no installed models', async () => {
    const { ArenaPanel } = await import('./arenaPanel.js');
    const { deps } = makeSetup({ models: [] });
    inputBox.mockResolvedValue('modelA, modelB');

    await openArena(deps);

    expect(inputBox).toHaveBeenCalled();
    expect(ArenaPanel.create).toHaveBeenCalledWith(
      deps.context,
      expect.anything(),
      deps.eloStore,
      ['modelA', 'modelB'],
      expect.any(Function),
    );
  });

  it('returns early when free-text entry is cancelled', async () => {
    const { ArenaPanel } = await import('./arenaPanel.js');
    const { deps } = makeSetup({ models: [] });
    inputBox.mockResolvedValue(undefined);

    await openArena(deps);

    expect(ArenaPanel.create).not.toHaveBeenCalled();
  });

  it('falls through to free-text entry when backend is unreachable', async () => {
    const { ArenaPanel } = await import('./arenaPanel.js');
    const { deps } = makeSetup({ failingClient: true });
    inputBox.mockResolvedValue(undefined);

    await openArena(deps);

    expect(inputBox).toHaveBeenCalled();
    expect(ArenaPanel.create).not.toHaveBeenCalled();
  });

  it('blocks Arena when RAM preflight fails', async () => {
    const { ArenaPanel } = await import('./arenaPanel.js');
    const { checkMemoryPreflight } = await import('../system/memoryMonitor.js');
    vi.mocked(checkMemoryPreflight).mockResolvedValue(false);
    const { deps } = makeSetup({ preFilledModels: ['a:latest', 'b:latest'] });

    await openArena(deps);

    expect(ArenaPanel.create).not.toHaveBeenCalled();
  });
});

describe('openArenaAgent', () => {
  let quickPick: ReturnType<typeof vi.spyOn>;
  let inputBox: ReturnType<typeof vi.spyOn>;
  let infoMsg: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkMemoryPreflight).mockResolvedValue(true);
    quickPick = vi.spyOn(window, 'showQuickPick').mockResolvedValue(undefined as never);
    inputBox = vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined as never);
    infoMsg = vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);
  });

  const callbacks = {} as never;
  const reviewDeps = {} as never;

  it('dispatches forks and skips ELO when user does not pick a winner', async () => {
    const { reviewForkBatch } = await import('../agent/fork/forkReview.js');
    vi.mocked(reviewForkBatch).mockResolvedValue({ winnerIndex: null, appliedOk: false, skippedLabels: [] });
    const { deps, store } = makeSetup({ preFilledModels: ['a:latest', 'b:latest'], preFilledTask: 'fix tests' });

    await openArenaAgent(deps, callbacks, reviewDeps);

    expect(store.recordWin).not.toHaveBeenCalled();
  });

  it('records ELO when user picks a winner', async () => {
    const { reviewForkBatch } = await import('../agent/fork/forkReview.js');
    vi.mocked(reviewForkBatch).mockResolvedValue({ winnerIndex: 0, appliedOk: true, skippedLabels: [] });
    const { deps, store } = makeSetup({ preFilledModels: ['a:latest', 'b:latest'], preFilledTask: 'fix tests' });

    await openArenaAgent(deps, callbacks, reviewDeps);

    expect(store.recordWin).toHaveBeenCalledWith('a:latest', ['b:latest']);
    expect(infoMsg).toHaveBeenCalledWith(expect.stringContaining('wins'));
  });

  it('prompts for a task when none pre-filled and returns early on cancel', async () => {
    inputBox.mockResolvedValue(undefined);
    const { deps } = makeSetup({ preFilledModels: ['a:latest', 'b:latest'] });

    await openArenaAgent(deps, callbacks, reviewDeps);

    expect(inputBox).toHaveBeenCalled();
    const { dispatchForks } = await import('../agent/fork/forkDispatcher.js');
    expect(dispatchForks).not.toHaveBeenCalled();
  });

  it('prompts for models when fewer than 2 pre-filled and returns early on cancel', async () => {
    quickPick.mockResolvedValue(undefined);
    const { deps } = makeSetup({ preFilledTask: 'a task' });

    await openArenaAgent(deps, callbacks, reviewDeps);

    expect(quickPick).toHaveBeenCalled();
    const { dispatchForks } = await import('../agent/fork/forkDispatcher.js');
    expect(dispatchForks).not.toHaveBeenCalled();
  });

  it('skips ELO when review was not applied successfully', async () => {
    const { reviewForkBatch } = await import('../agent/fork/forkReview.js');
    vi.mocked(reviewForkBatch).mockResolvedValue({ winnerIndex: 1, appliedOk: false, skippedLabels: [] });
    const { deps, store } = makeSetup({ preFilledModels: ['x:1', 'y:2'], preFilledTask: 'do stuff' });

    await openArenaAgent(deps, callbacks, reviewDeps);

    expect(store.recordWin).not.toHaveBeenCalled();
  });
});
