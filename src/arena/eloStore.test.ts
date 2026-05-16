import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EloStore } from './eloStore.js';
import { ELO_DEFAULT_RATING } from './types.js';

// Stub out filesystem so tests never touch disk.
vi.mock('fs/promises', () => ({
  readFile: vi.fn().mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

function makeStore(): EloStore {
  return new EloStore('/tmp/.sidecar/arena/elo.json');
}

describe('EloStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns default rating for unknown model', async () => {
    const store = makeStore();
    await store.load();
    expect(store.getRating('unknown-model')).toBe(ELO_DEFAULT_RATING);
  });

  it('starts both models at default rating', async () => {
    const store = makeStore();
    await store.load();
    await store.recordWin('model-a', ['model-b']);
    // After one win both are registered; winner should be above default
    expect(store.getRating('model-a')).toBeGreaterThan(ELO_DEFAULT_RATING);
    expect(store.getRating('model-b')).toBeLessThan(ELO_DEFAULT_RATING);
  });

  it('winner gains points and loser loses the same amount', async () => {
    const store = makeStore();
    await store.load();
    await store.recordWin('a', ['b']);
    const delta = store.getRating('a') - ELO_DEFAULT_RATING;
    const lost = ELO_DEFAULT_RATING - store.getRating('b');
    // delta should equal lost (zero-sum for equal starting ratings)
    expect(delta).toBe(lost);
  });

  it('delta is at most K=32 for equal opponents', async () => {
    const store = makeStore();
    await store.load();
    await store.recordWin('a', ['b']);
    const delta = store.getRating('a') - ELO_DEFAULT_RATING;
    expect(delta).toBeLessThanOrEqual(32);
    expect(delta).toBeGreaterThan(0);
  });

  it('higher-rated winner gains fewer points (expected win)', async () => {
    const store = makeStore();
    await store.load();
    // Prime a with many wins so it has a higher rating
    for (let i = 0; i < 10; i++) {
      await store.recordWin('a', ['b']);
    }
    const ratingBefore = store.getRating('a');
    await store.recordWin('a', ['b']);
    const gained = store.getRating('a') - ratingBefore;
    // gain should be small (well below K) for a heavy favourite
    expect(gained).toBeLessThan(10);
  });

  it('tracks wins and losses counts', async () => {
    const store = makeStore();
    await store.load();
    await store.recordWin('a', ['b']);
    await store.recordWin('a', ['b']);
    const state = store.getState();
    expect(state.wins['a']).toBe(2);
    expect(state.losses['b']).toBe(2);
  });

  it('records multi-way wins against all losers', async () => {
    const store = makeStore();
    await store.load();
    await store.recordWin('a', ['b', 'c']);
    const state = store.getState();
    expect(state.wins['a']).toBe(2); // one win per loser
    expect(state.losses['b']).toBe(1);
    expect(state.losses['c']).toBe(1);
    expect(state.totalMatches).toBe(2);
  });

  it('getRatings returns a snapshot (not a live reference)', async () => {
    const store = makeStore();
    await store.load();
    const snap = store.getRatings();
    await store.recordWin('a', ['b']);
    expect(snap['a']).toBeUndefined(); // snapshot taken before the win
  });

  it('saves after every recordWin', async () => {
    const { writeFile } = await import('fs/promises');
    const store = makeStore();
    await store.load();
    await store.recordWin('a', ['b']);
    expect(writeFile).toHaveBeenCalledOnce();
    await store.recordWin('a', ['b']);
    expect(writeFile).toHaveBeenCalledTimes(2);
  });

  it('load survives missing file (fresh start)', async () => {
    const store = makeStore();
    await expect(store.load()).resolves.not.toThrow();
    expect(store.getRating('anything')).toBe(ELO_DEFAULT_RATING);
  });
});
