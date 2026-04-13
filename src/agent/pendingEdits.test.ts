import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PendingEditStore } from './pendingEdits.js';

describe('PendingEditStore', () => {
  let store: PendingEditStore;

  beforeEach(() => {
    store = new PendingEditStore();
  });

  it('starts empty', () => {
    expect(store.size).toBe(0);
    expect(store.getAll()).toEqual([]);
    expect(store.get('/a.ts')).toBeUndefined();
    expect(store.has('/a.ts')).toBe(false);
  });

  it('records a new edit', () => {
    store.record('/a.ts', 'old', 'new', 'write_file');
    expect(store.size).toBe(1);
    const edit = store.get('/a.ts');
    expect(edit).toBeDefined();
    expect(edit!.filePath).toBe('/a.ts');
    expect(edit!.originalContent).toBe('old');
    expect(edit!.newContent).toBe('new');
    expect(edit!.lastTool).toBe('write_file');
  });

  it('records a file creation with null originalContent', () => {
    store.record('/fresh.ts', null, 'export const x = 1;', 'write_file');
    const edit = store.get('/fresh.ts');
    expect(edit!.originalContent).toBeNull();
    expect(edit!.newContent).toBe('export const x = 1;');
  });

  it('preserves originalContent on subsequent edits to the same file', () => {
    store.record('/a.ts', 'v1', 'v2', 'write_file');
    store.record('/a.ts', 'should-be-ignored', 'v3', 'edit_file');
    const edit = store.get('/a.ts');
    expect(edit!.originalContent).toBe('v1'); // baseline locked on first record
    expect(edit!.newContent).toBe('v3'); // latest write wins
    expect(edit!.lastTool).toBe('edit_file');
    expect(store.size).toBe(1);
  });

  it('preserves originalContent across write-then-edit-then-write', () => {
    store.record('/a.ts', 'baseline', 'step1', 'write_file');
    store.record('/a.ts', null, 'step2', 'edit_file'); // ignored baseline
    store.record('/a.ts', 'also-ignored', 'step3', 'write_file');
    const edit = store.get('/a.ts');
    expect(edit!.originalContent).toBe('baseline');
    expect(edit!.newContent).toBe('step3');
  });

  it('removes a pending edit by path', () => {
    store.record('/a.ts', 'old', 'new', 'write_file');
    store.record('/b.ts', 'old', 'new', 'write_file');
    expect(store.remove('/a.ts')).toBe(true);
    expect(store.size).toBe(1);
    expect(store.has('/a.ts')).toBe(false);
    expect(store.has('/b.ts')).toBe(true);
  });

  it('returns false when removing a path that was never recorded', () => {
    expect(store.remove('/missing.ts')).toBe(false);
    expect(store.size).toBe(0);
  });

  it('clear() drops every entry', () => {
    store.record('/a.ts', 'x', 'y', 'write_file');
    store.record('/b.ts', 'x', 'y', 'write_file');
    store.record('/c.ts', 'x', 'y', 'write_file');
    store.clear();
    expect(store.size).toBe(0);
    expect(store.getAll()).toEqual([]);
  });

  it('getAll returns entries sorted by file path for deterministic UI order', () => {
    store.record('/c.ts', 'x', 'y', 'write_file');
    store.record('/a.ts', 'x', 'y', 'write_file');
    store.record('/b.ts', 'x', 'y', 'write_file');
    const all = store.getAll();
    expect(all.map((e) => e.filePath)).toEqual(['/a.ts', '/b.ts', '/c.ts']);
  });

  it('getAll returns a snapshot that does not mutate the store', () => {
    store.record('/a.ts', 'x', 'y', 'write_file');
    const snap = store.getAll();
    snap.push({ filePath: '/b.ts', originalContent: null, newContent: '', updatedAt: 0, lastTool: 'write_file' });
    expect(store.size).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Event emitter
  // ---------------------------------------------------------------------------

  it('fires onChanged when an edit is recorded', () => {
    const listener = vi.fn();
    store.onChanged(listener);
    store.record('/a.ts', 'x', 'y', 'write_file');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires onChanged when an existing edit is updated', () => {
    store.record('/a.ts', 'x', 'y', 'write_file');
    const listener = vi.fn();
    store.onChanged(listener);
    store.record('/a.ts', 'x', 'z', 'edit_file');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('fires onChanged when an edit is removed', () => {
    store.record('/a.ts', 'x', 'y', 'write_file');
    const listener = vi.fn();
    store.onChanged(listener);
    store.remove('/a.ts');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire onChanged when remove targets a missing entry', () => {
    const listener = vi.fn();
    store.onChanged(listener);
    store.remove('/missing.ts');
    expect(listener).not.toHaveBeenCalled();
  });

  it('fires onChanged when clear() drops entries', () => {
    store.record('/a.ts', 'x', 'y', 'write_file');
    const listener = vi.fn();
    store.onChanged(listener);
    store.clear();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not fire onChanged when clear() runs on an empty store', () => {
    const listener = vi.fn();
    store.onChanged(listener);
    store.clear();
    expect(listener).not.toHaveBeenCalled();
  });

  it('updatedAt advances across successive updates to the same file', async () => {
    store.record('/a.ts', 'x', 'v1', 'write_file');
    const first = store.get('/a.ts')!.updatedAt;
    // Advance the clock one millisecond before the second record so the
    // updatedAt delta is observable even on fast machines.
    await new Promise((r) => setTimeout(r, 2));
    store.record('/a.ts', null, 'v2', 'edit_file');
    const second = store.get('/a.ts')!.updatedAt;
    expect(second).toBeGreaterThan(first);
  });

  it('dispose() clears entries and releases the emitter', () => {
    store.record('/a.ts', 'x', 'y', 'write_file');
    store.dispose();
    expect(store.size).toBe(0);
  });
});
