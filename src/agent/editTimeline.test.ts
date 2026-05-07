import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EditTimelineStore, computeDiffStats, formatDiffStats } from './editTimeline.js';

// Mock vscode so workspace.fs is available
vi.mock('vscode', async () => {
  const { workspace, Uri } = await import('../__mocks__/vscode.js');
  return { workspace, Uri };
});

describe('EditTimelineStore', () => {
  let store: EditTimelineStore;

  beforeEach(() => {
    store = new EditTimelineStore();
  });

  it('records first write with original content', () => {
    store.record('src/foo.ts', 'original', 'new content');
    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].relPath).toBe('src/foo.ts');
    expect(entries[0].originalContent).toBe('original');
    expect(entries[0].newContent).toBe('new content');
    expect(entries[0].editCount).toBe(1);
  });

  it('records new file (undefined original)', () => {
    store.record('src/new.ts', undefined, 'brand new');
    const entries = store.list();
    expect(entries[0].originalContent).toBeUndefined();
  });

  it('subsequent write updates newContent and editCount but preserves original', () => {
    store.record('src/foo.ts', 'original', 'v1');
    store.record('src/foo.ts', 'should be ignored', 'v2');
    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0].originalContent).toBe('original');
    expect(entries[0].newContent).toBe('v2');
    expect(entries[0].editCount).toBe(2);
  });

  it('normalizes windows path separators', () => {
    store.record('src\\foo.ts', 'orig', 'new');
    expect(store.list()[0].relPath).toBe('src/foo.ts');
  });

  it('returns size', () => {
    expect(store.size).toBe(0);
    store.record('a.ts', 'x', 'y');
    expect(store.size).toBe(1);
    store.record('b.ts', 'x', 'y');
    expect(store.size).toBe(2);
  });

  it('clear removes all entries and notifies', () => {
    const cb = vi.fn();
    store.onChange(cb);
    store.record('a.ts', 'x', 'y');
    cb.mockClear();
    store.clear();
    expect(store.size).toBe(0);
    expect(cb).toHaveBeenCalledOnce();
  });

  it('onChange fires on record and returns unsubscribe', () => {
    const cb = vi.fn();
    const unsub = store.onChange(cb);
    store.record('a.ts', 'x', 'y');
    expect(cb).toHaveBeenCalledOnce();
    unsub();
    store.record('b.ts', 'x', 'y');
    expect(cb).toHaveBeenCalledOnce(); // not called again
  });

  it('list sorts by most-recently-edited first', async () => {
    store.record('a.ts', 'x', 'y');
    // Ensure different timestamps
    await new Promise((r) => setTimeout(r, 2));
    store.record('b.ts', 'x', 'y');
    const paths = store.list().map((e) => e.relPath);
    expect(paths[0]).toBe('b.ts');
    expect(paths[1]).toBe('a.ts');
  });
});

describe('computeDiffStats', () => {
  it('counts added lines for new file', () => {
    const stats = computeDiffStats(undefined, 'a\nb\nc');
    expect(stats.added).toBe(3);
    expect(stats.removed).toBe(0);
  });

  it('counts added lines when file grows', () => {
    const stats = computeDiffStats('a\nb', 'a\nb\nc\nd');
    expect(stats.added).toBe(2);
    expect(stats.removed).toBe(0);
  });

  it('counts removed lines when file shrinks', () => {
    const stats = computeDiffStats('a\nb\nc', 'a');
    expect(stats.added).toBe(0);
    expect(stats.removed).toBe(2);
  });
});

describe('formatDiffStats', () => {
  it('formats added and removed', () => {
    expect(formatDiffStats({ added: 5, removed: 3 })).toBe('+5 -3');
  });

  it('formats added only', () => {
    expect(formatDiffStats({ added: 2, removed: 0 })).toBe('+2');
  });

  it('formats removed only', () => {
    expect(formatDiffStats({ added: 0, removed: 4 })).toBe('-4');
  });

  it('returns ~ for no change', () => {
    expect(formatDiffStats({ added: 0, removed: 0 })).toBe('~');
  });
});
