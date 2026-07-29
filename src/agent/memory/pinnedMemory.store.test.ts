import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PinnedMemoryStore } from './pinnedMemory.js';

// Real filesystem, deliberately: pinnedMemory.test.ts mocks fs/promises to
// assert call shapes, which cannot exercise what actually happens to bytes on
// disk — and bytes on disk are the whole risk here.

describe('unreadable pins file must not be destroyed', () => {
  it('preserves the bytes and reports the failure instead of writing over them', async () => {
    // Third instance of the same defect (durableMemory, agentMemory, here):
    // load() caught everything into an empty list, and persist() writes the
    // whole collection — so one transient read error plus one pin wiped the
    // user's pinned context.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinned-corrupt-'));
    const file = path.join(dir, 'pins.json');
    const original = '[{"id":"a","path":"src/a.ts","boo';
    await fs.writeFile(file, original, 'utf8');

    const store = new PinnedMemoryStore(dir);
    await store.load();

    const failure = store.getLoadFailure();
    expect(failure).not.toBeNull();
    expect(await fs.readFile(failure!.quarantinedTo!, 'utf8')).toBe(original);

    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a first run is silent and writes atomically', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pinned-fresh-'));
    const store = new PinnedMemoryStore(dir);
    await store.load();
    expect(store.getLoadFailure()).toBeNull();

    await store.pin('src/a.ts', 'because');
    expect(await fs.readdir(dir)).toEqual(['pins.json']); // no .tmp left behind

    const reloaded = new PinnedMemoryStore(dir);
    await reloaded.load();
    expect(reloaded.getEntries().map((e) => e.path)).toEqual(['src/a.ts']);

    await fs.rm(dir, { recursive: true, force: true });
  });
});
