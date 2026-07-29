import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeFileAtomic } from './atomicWrite.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sidecar-atomic-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('writeFileAtomic', () => {
  it('writes the file and leaves no temp behind', async () => {
    const f = path.join(dir, 'a.txt');
    await writeFileAtomic(f, 'hello');
    expect(fs.readFileSync(f, 'utf8')).toBe('hello');
    expect(fs.readdirSync(dir)).toEqual(['a.txt']);
  });

  it('creates missing parent directories', async () => {
    const f = path.join(dir, 'x', 'y', 'b.txt');
    await writeFileAtomic(f, 'nested');
    expect(fs.readFileSync(f, 'utf8')).toBe('nested');
  });

  it('survives concurrent writes to the same path', async () => {
    // A shared `<file>.tmp` loses writes: the first rename moves it away and
    // the second fails ENOENT. Unique temps per write are what make this safe.
    const f = path.join(dir, 'c.txt');
    await Promise.all(['1', '2', '3', '4', '5'].map((v) => writeFileAtomic(f, v)));
    expect(fs.readdirSync(dir)).toEqual(['c.txt']);
    expect(['1', '2', '3', '4', '5']).toContain(fs.readFileSync(f, 'utf8'));
  });

  it('preserves the previous file when the write fails', async () => {
    const f = path.join(dir, 'd.txt');
    await writeFileAtomic(f, 'original');
    // A directory where the temp file wants to go — rename cannot clobber it.
    await expect(
      writeFileAtomic(path.join(dir, 'sub'), 'x').then(() => writeFileAtomic(f, undefined as never)),
    ).rejects.toThrow();
    expect(fs.readFileSync(f, 'utf8')).toBe('original');
  });

  it('does not leave a temp file behind on failure', async () => {
    const f = path.join(dir, 'e.txt');
    await writeFileAtomic(f, 'v1');
    await writeFileAtomic(f, undefined as never).catch(() => undefined);
    expect(fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});
