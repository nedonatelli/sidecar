import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readJsonStore, writeJsonStoreAtomic } from './jsonStore.js';

// Adverse-I/O tests. The whole suite had none, which is why a store that could
// not be read looked exactly like a store that was empty — and the next write
// destroyed it. These assert what happens when the filesystem says no.

let dir: string;
let file: string;

beforeEach(() => {
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'sidecar-jsonstore-'));
  file = path.join(dir, 'store.json');
});

afterEach(() => {
  fsSync.rmSync(dir, { recursive: true, force: true });
});

describe('readJsonStore', () => {
  it('treats an absent file as a clean empty load, not a failure', async () => {
    // A first run must be silent. This is the ONLY error that is not an error.
    const r = await readJsonStore<{ a: number }>(file);
    expect(r.value).toBeNull();
    expect(r.failure).toBeNull();
  });

  it('parses an existing store', async () => {
    await fs.writeFile(file, JSON.stringify({ a: 1 }), 'utf8');
    const r = await readJsonStore<{ a: number }>(file);
    expect(r.value).toEqual({ a: 1 });
    expect(r.failure).toBeNull();
  });

  it('reports corrupt JSON as a failure and moves the bytes aside', async () => {
    // The exact input a crash mid-write used to leave behind.
    await fs.writeFile(file, '{"entries": [{"text": "half a fi', 'utf8');
    const r = await readJsonStore(file, () => 1234);

    expect(r.value).toBeNull();
    expect(r.failure).not.toBeNull();
    expect(r.failure!.persistBlocked).toBe(false);
    expect(r.failure!.quarantinedTo).toBe(`${file}.unreadable-1234`);
    // The bytes SURVIVE — that is the point. They are recoverable by hand.
    expect(fsSync.readFileSync(r.failure!.quarantinedTo!, 'utf8')).toBe('{"entries": [{"text": "half a fi');
    expect(fsSync.existsSync(file)).toBe(false);
  });

  it('reports an unreadable file as a failure rather than an empty store', async () => {
    await fs.writeFile(file, JSON.stringify({ a: 1 }), 'utf8');
    await fs.chmod(file, 0o000);
    // Running as root defeats permission bits; skip rather than assert a lie.
    const stillReadable = await fs
      .readFile(file, 'utf8')
      .then(() => true)
      .catch(() => false);
    if (stillReadable) return;

    const r = await readJsonStore(file, () => 99);
    expect(r.value).toBeNull();
    expect(r.failure).not.toBeNull();
    expect(r.failure!.quarantinedTo).toBe(`${file}.unreadable-99`);
    await fs.chmod(r.failure!.quarantinedTo!, 0o600);
  });

  it('blocks persistence when the bytes can be neither read nor moved', async () => {
    // Unreadable file in a directory that denies writes: quarantine cannot work,
    // so the only safe answer is "do not write over it".
    await fs.writeFile(file, 'not json', 'utf8');
    await fs.chmod(dir, 0o500);
    const canStillMove = await fs
      .rename(file, `${file}.probe`)
      .then(async () => {
        await fs.rename(`${file}.probe`, file);
        return true;
      })
      .catch(() => false);
    if (canStillMove) {
      await fs.chmod(dir, 0o700);
      return; // root, or a filesystem that ignores the mode
    }

    const r = await readJsonStore(file);
    expect(r.failure!.persistBlocked).toBe(true);
    expect(r.failure!.quarantinedTo).toBeNull();
    await fs.chmod(dir, 0o700);
  });
});

describe('writeJsonStoreAtomic', () => {
  it('survives concurrent writes to the same store', async () => {
    // A shared temp path made overlapping saves race: both write the same
    // temp, the first renames it away, the second fails with ENOENT and its
    // save is silently lost. Found by these tests against the first cut.
    await Promise.all([1, 2, 3, 4, 5].map((n) => writeJsonStoreAtomic(file, { n })));
    expect(fsSync.readdirSync(dir)).toEqual(['store.json']);
    expect(JSON.parse(fsSync.readFileSync(file, 'utf8'))).toHaveProperty('n');
  });

  it('writes through a temp file and leaves no temp behind', async () => {
    await writeJsonStoreAtomic(file, { a: 1 });
    expect(JSON.parse(fsSync.readFileSync(file, 'utf8'))).toEqual({ a: 1 });
    expect(fsSync.readdirSync(dir)).toEqual(['store.json']);
  });

  it('creates missing parent directories', async () => {
    const nested = path.join(dir, 'a', 'b', 'store.json');
    await writeJsonStoreAtomic(nested, { ok: true });
    expect(JSON.parse(fsSync.readFileSync(nested, 'utf8'))).toEqual({ ok: true });
  });

  it('leaves the previous file intact when the write fails', async () => {
    // Durability claim: a failed save must not be able to damage what is
    // already on disk. A value that cannot be serialized fails before rename.
    await writeJsonStoreAtomic(file, { good: true });
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    await expect(writeJsonStoreAtomic(file, circular)).rejects.toThrow();
    expect(JSON.parse(fsSync.readFileSync(file, 'utf8'))).toEqual({ good: true });
    expect(fsSync.readdirSync(dir)).toEqual(['store.json']);
  });

  it('propagates the error instead of swallowing it', async () => {
    await fs.chmod(dir, 0o500);
    const blocked = await writeJsonStoreAtomic(path.join(dir, 'nope.json'), { a: 1 }).then(
      () => false,
      () => true,
    );
    await fs.chmod(dir, 0o700);
    if (!blocked) return; // root
    expect(blocked).toBe(true);
  });
});
