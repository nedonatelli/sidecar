import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'path';

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn(),
    readFile: vi.fn(),
  };
});

import * as fs from 'fs/promises';
import { TeamMemoryStore } from './teamMemory.js';

const mockReaddir = fs.readdir as ReturnType<typeof vi.fn>;
const mockReadFile = fs.readFile as ReturnType<typeof vi.fn>;

beforeEach(() => vi.resetAllMocks());

function enoent(): NodeJS.ErrnoException {
  return Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
}

describe('TeamMemoryStore.load', () => {
  it('is ready with no entries when directory does not exist', async () => {
    mockReaddir.mockRejectedValue(enoent());
    const store = new TeamMemoryStore('/proj/.sidecar');
    await store.load();
    expect(store.isReady()).toBe(true);
    expect(store.getEntries()).toEqual([]);
  });

  it('re-throws non-ENOENT readdir errors', async () => {
    mockReaddir.mockRejectedValue(new Error('EPERM'));
    const store = new TeamMemoryStore('/proj/.sidecar');
    await expect(store.load()).rejects.toThrow('EPERM');
  });

  it('ignores non-.md files', async () => {
    mockReaddir.mockResolvedValue(['notes.md', 'README.txt', 'deploy.sh', 'ci.md']);
    mockReadFile.mockResolvedValue('content');
    const store = new TeamMemoryStore('/proj/.sidecar');
    await store.load();
    expect(store.getEntries().map((e) => e.filename)).toEqual(['ci.md', 'notes.md']);
  });

  it('skips empty files', async () => {
    mockReaddir.mockResolvedValue(['empty.md', 'full.md']);
    mockReadFile.mockImplementation((_p: string) => {
      if ((_p as string).includes('empty')) return Promise.resolve('   \n  ');
      return Promise.resolve('some content');
    });
    const store = new TeamMemoryStore('/proj/.sidecar');
    await store.load();
    expect(store.getEntries()).toHaveLength(1);
    expect(store.getEntries()[0].label).toBe('full');
  });

  it('skips unreadable files silently', async () => {
    mockReaddir.mockResolvedValue(['good.md', 'bad.md']);
    mockReadFile.mockImplementation((_p: string) => {
      if ((_p as string).includes('bad')) return Promise.reject(new Error('EACCES'));
      return Promise.resolve('good content');
    });
    const store = new TeamMemoryStore('/proj/.sidecar');
    await store.load();
    expect(store.getEntries()).toHaveLength(1);
    expect(store.getEntries()[0].label).toBe('good');
  });

  it('sorts entries alphabetically by filename', async () => {
    mockReaddir.mockResolvedValue(['zzz.md', 'aaa.md', 'mmm.md']);
    mockReadFile.mockResolvedValue('content');
    const store = new TeamMemoryStore('/proj/.sidecar');
    await store.load();
    expect(store.getEntries().map((e) => e.label)).toEqual(['aaa', 'mmm', 'zzz']);
  });

  it('sets label from filename without .md extension', async () => {
    mockReaddir.mockResolvedValue(['staging-database.md']);
    mockReadFile.mockResolvedValue('postgres://staging:5432/app');
    const store = new TeamMemoryStore('/proj/.sidecar');
    await store.load();
    const [entry] = store.getEntries();
    expect(entry.label).toBe('staging-database');
    expect(entry.filename).toBe('staging-database.md');
    expect(entry.content).toBe('postgres://staging:5432/app');
  });

  it('trims leading/trailing whitespace from content', async () => {
    mockReaddir.mockResolvedValue(['note.md']);
    mockReadFile.mockResolvedValue('\n\n  trimmed content  \n\n');
    const store = new TeamMemoryStore('/proj/.sidecar');
    await store.load();
    expect(store.getEntries()[0].content).toBe('trimmed content');
  });
});

describe('TeamMemoryStore.getDir', () => {
  it('returns the team-memory subdirectory path', () => {
    const store = new TeamMemoryStore('/proj/.sidecar');
    expect(store.getDir()).toContain('team-memory');
    expect(store.getDir()).toContain(path.join('/proj', '.sidecar'));
  });
});

describe('TeamMemoryStore.size', () => {
  it('returns 0 before load', () => {
    const store = new TeamMemoryStore('/proj/.sidecar');
    expect(store.size()).toBe(0);
  });

  it('returns entry count after load', async () => {
    mockReaddir.mockResolvedValue(['a.md', 'b.md']);
    mockReadFile.mockResolvedValue('content');
    const store = new TeamMemoryStore('/proj/.sidecar');
    await store.load();
    expect(store.size()).toBe(2);
  });
});
