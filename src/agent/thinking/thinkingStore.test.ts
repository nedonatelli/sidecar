import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      mkdir: vi.fn().mockResolvedValue(undefined),
      readFile: vi.fn().mockResolvedValue(''),
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { ThinkingStore } from './thinkingStore.js';

describe('ThinkingStore', () => {
  let store: ThinkingStore;

  beforeEach(() => {
    store = new ThinkingStore();
    vi.clearAllMocks();
  });

  it('returns empty array for unknown taskId', () => {
    expect(store.get('unknown-task')).toEqual([]);
  });

  it('appends a thinking entry to the in-memory buffer', async () => {
    await store.append('task-1', 'First thought', 'single');
    const entries = store.get('task-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toContain('First thought');
  });

  it('accumulates multiple entries for the same task', async () => {
    await store.append('task-2', 'Thought A', 'single');
    await store.append('task-2', 'Thought B', 'single');
    await store.append('task-2', 'Thought C', 'single');
    expect(store.get('task-2')).toHaveLength(3);
  });

  it('enforces MAX_ENTRIES ring-buffer cap per task', async () => {
    const MAX = 50;
    for (let i = 0; i < MAX + 5; i++) {
      await store.append('task-ring', `entry-${i}`, 'single');
    }
    const entries = store.get('task-ring');
    expect(entries).toHaveLength(MAX);
    expect(entries[0]).toContain(`entry-5`);
  });

  it('isolates entries between different tasks', async () => {
    await store.append('task-a', 'Alpha', 'single');
    await store.append('task-b', 'Beta', 'self-debate');
    expect(store.get('task-a')).toHaveLength(1);
    expect(store.get('task-b')).toHaveLength(1);
    expect(store.get('task-a')[0]).toContain('Alpha');
    expect(store.get('task-b')[0]).toContain('Beta');
  });

  it('clear removes entries for the specified task', async () => {
    await store.append('task-c', 'To be cleared', 'single');
    store.clear('task-c');
    expect(store.get('task-c')).toEqual([]);
  });

  it('clear does not affect other tasks', async () => {
    await store.append('task-d', 'Keep me', 'single');
    await store.append('task-e', 'Clear me', 'single');
    store.clear('task-e');
    expect(store.get('task-d')).toHaveLength(1);
    expect(store.get('task-e')).toEqual([]);
  });

  it('includes timestamp in appended entries', async () => {
    await store.append('task-ts', 'With time', 'single');
    const entry = store.get('task-ts')[0];
    expect(entry).toMatch(/^\[\d{4}-\d{2}-\d{2}T/);
  });
});
