import { describe, it, expect, vi } from 'vitest';
import { PlanStore, extractGoal } from './planStore.js';
import type { PlanCheckpoint } from './planStore.js';

// ---------------------------------------------------------------------------
// Tests for planStore.ts — PlanCheckpoint persistence.
//
// SidecarDir is stubbed to avoid real filesystem writes. Covers:
//   - save / load round-trip
//   - clear sets null (so exists() returns false)
//   - exists() returns false when no checkpoint or null stored
//   - exists() returns true when valid checkpoint present
//   - save failures are swallowed (non-fatal)
//   - load failures return null
//   - extractGoal: first user message, truncation, fallback
// ---------------------------------------------------------------------------

function makeCheckpoint(overrides: Partial<PlanCheckpoint> = {}): PlanCheckpoint {
  return {
    goal: 'Fix the auth bug',
    messages: [{ role: 'user', content: 'Fix the auth bug' }],
    turnCount: 3,
    runId: 'run-abc-123',
    createdAt: 1_000_000,
    updatedAt: 1_001_000,
    ...overrides,
  };
}

function makeSidecarDir(stored: unknown = null) {
  let data = stored;
  return {
    writeJson: vi.fn(async (_path: string, value: unknown) => {
      data = value;
    }),
    readJson: vi.fn(async () => data),
  };
}

describe('PlanStore — save / load', () => {
  it('saves and loads a checkpoint round-trip', async () => {
    const dir = makeSidecarDir();
    const store = new PlanStore(dir as never);
    const cp = makeCheckpoint();
    await store.save(cp);
    const loaded = await store.load();
    expect(loaded?.goal).toBe('Fix the auth bug');
    expect(loaded?.turnCount).toBe(3);
    expect(loaded?.runId).toBe('run-abc-123');
  });

  it('returns null when no checkpoint has been written', async () => {
    const dir = makeSidecarDir(null);
    const store = new PlanStore(dir as never);
    const loaded = await store.load();
    expect(loaded).toBeNull();
  });

  it('returns null when readJson throws', async () => {
    const dir = {
      readJson: vi.fn(async () => {
        throw new Error('disk error');
      }),
      writeJson: vi.fn(),
    };
    const store = new PlanStore(dir as never);
    const loaded = await store.load();
    expect(loaded).toBeNull();
  });

  it('swallows writeJson errors (non-fatal)', async () => {
    const dir = {
      writeJson: vi.fn(async () => {
        throw new Error('disk full');
      }),
      readJson: vi.fn(async () => null),
    };
    const store = new PlanStore(dir as never);
    // Should not throw
    await expect(store.save(makeCheckpoint())).resolves.toBeUndefined();
  });
});

describe('PlanStore — clear / exists', () => {
  it('exists() returns true when a valid checkpoint is stored', async () => {
    const dir = makeSidecarDir(makeCheckpoint());
    const store = new PlanStore(dir as never);
    expect(await store.exists()).toBe(true);
  });

  it('exists() returns false when checkpoint is null', async () => {
    const dir = makeSidecarDir(null);
    const store = new PlanStore(dir as never);
    expect(await store.exists()).toBe(false);
  });

  it('exists() returns false when checkpoint has no goal field', async () => {
    const dir = makeSidecarDir({ turnCount: 1 }); // missing goal
    const store = new PlanStore(dir as never);
    expect(await store.exists()).toBe(false);
  });

  it('clear() writes null so subsequent exists() returns false', async () => {
    const dir = makeSidecarDir(makeCheckpoint());
    const store = new PlanStore(dir as never);
    expect(await store.exists()).toBe(true);
    await store.clear();
    expect(await store.exists()).toBe(false);
  });
});

describe('extractGoal', () => {
  it('returns the first user message content', () => {
    const messages = [
      { role: 'assistant' as const, content: 'You are helpful' },
      { role: 'user' as const, content: 'Refactor the auth module' },
    ];
    expect(extractGoal(messages)).toBe('Refactor the auth module');
  });

  it('truncates long messages to 80 chars with ellipsis', () => {
    const longMsg = 'x'.repeat(100);
    const messages = [{ role: 'user' as const, content: longMsg }];
    const goal = extractGoal(messages);
    // text.slice(0, 77) + '…' = 77 + 1 = 78 chars
    expect(goal).toHaveLength(78);
    expect(goal.length).toBeLessThanOrEqual(80);
    expect(goal.endsWith('…')).toBe(true);
  });

  it('returns fallback when no user message exists', () => {
    const messages = [{ role: 'assistant' as const, content: 'Hi' }];
    expect(extractGoal(messages)).toBe('(unknown task)');
  });

  it('returns fallback for empty messages array', () => {
    expect(extractGoal([])).toBe('(unknown task)');
  });

  it('handles non-string content gracefully', () => {
    const messages = [{ role: 'user' as const, content: [{ type: 'text', text: 'hello' }] as never }];
    expect(extractGoal(messages)).toBe('(unknown task)'); // non-string content → empty string → fallback path skipped
  });
});
