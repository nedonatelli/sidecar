import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PinnedMemoryStore } from './pinnedMemory.js';
import * as fs from 'fs/promises';

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

const mockReadFile = fs.readFile as ReturnType<typeof vi.fn>;
const mockWriteFile = fs.writeFile as ReturnType<typeof vi.fn>;

function makeStore() {
  return new PinnedMemoryStore('/workspace/.sidecar');
}

describe('PinnedMemoryStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    mockWriteFile.mockResolvedValue(undefined);
  });

  it('is not ready before load', () => {
    expect(makeStore().isReady()).toBe(false);
  });

  it('is ready after load even if file missing', async () => {
    const store = makeStore();
    await store.load();
    expect(store.isReady()).toBe(true);
    expect(store.getEntries()).toEqual([]);
  });

  it('loads existing entries from disk', async () => {
    const existing = [
      { id: 'abc123', path: 'docs/arch.md', label: 'arch.md', boost: 1, content: '# Arch', pinnedAt: 1000 },
    ];
    mockReadFile.mockResolvedValueOnce(JSON.stringify(existing));
    const store = makeStore();
    await store.load();
    expect(store.getEntries()).toHaveLength(1);
    expect(store.getEntries()[0].label).toBe('arch.md');
  });

  it('pins a new entry and persists', async () => {
    const store = makeStore();
    await store.load();
    const entry = await store.pin('docs/arch.md', '# Architecture', { label: 'Architecture', boost: 2.0 });
    expect(entry.label).toBe('Architecture');
    expect(entry.boost).toBe(2.0);
    expect(entry.content).toBe('# Architecture');
    expect(mockWriteFile).toHaveBeenCalled();
  });

  it('re-pinning the same path updates the entry', async () => {
    const store = makeStore();
    await store.load();
    await store.pin('docs/arch.md', 'v1');
    await store.pin('docs/arch.md', 'v2');
    expect(store.size()).toBe(1);
    expect(store.getEntries()[0].content).toBe('v2');
  });

  it('unpins by id', async () => {
    const store = makeStore();
    await store.load();
    const entry = await store.pin('docs/arch.md', '# Arch');
    expect(store.size()).toBe(1);
    await store.unpin(entry.id);
    expect(store.size()).toBe(0);
  });

  it('getEntries returns entries sorted by boost descending', async () => {
    const store = makeStore();
    await store.load();
    await store.pin('a.md', 'a', { boost: 0.5 });
    await store.pin('b.md', 'b', { boost: 2.0 });
    await store.pin('c.md', 'c', { boost: 1.0 });
    const entries = store.getEntries();
    expect(entries.map((e) => e.path)).toEqual(['b.md', 'c.md', 'a.md']);
  });

  it('fires onChange on pin and unpin', async () => {
    const store = makeStore();
    await store.load();
    const onChange = vi.fn();
    store.setOnChange(onChange);
    const entry = await store.pin('docs/arch.md', '# Arch');
    expect(onChange).toHaveBeenCalledTimes(1);
    await store.unpin(entry.id);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('updateContent refreshes content without changing id', async () => {
    const store = makeStore();
    await store.load();
    const entry = await store.pin('docs/arch.md', 'old content');
    await store.updateContent(entry.id, 'new content');
    expect(store.getEntries()[0].content).toBe('new content');
    expect(store.getEntries()[0].id).toBe(entry.id);
  });

  it('uses basename as default label', async () => {
    const store = makeStore();
    await store.load();
    const entry = await store.pin('src/agent/memory/spec.md', '# Spec');
    expect(entry.label).toBe('spec.md');
  });
});
