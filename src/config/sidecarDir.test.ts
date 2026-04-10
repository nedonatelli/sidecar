import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFs = {
  createDirectory: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn(),
};

vi.mock('vscode', () => ({
  workspace: {
    workspaceFolders: [{ uri: { fsPath: '/project' } }],
    fs: mockFs,
  },
  Uri: {
    file: (p: string) => ({ fsPath: p, path: p }),
    joinPath: (base: { fsPath: string }, ...segs: string[]) => {
      const joined = base.fsPath + '/' + segs.join('/');
      return { fsPath: joined, path: joined };
    },
  },
}));

import { SidecarDir } from './sidecarDir.js';

describe('SidecarDir', () => {
  let dir: SidecarDir;

  beforeEach(() => {
    dir = new SidecarDir();
    vi.clearAllMocks();
  });

  it('initializes and creates directory structure', async () => {
    const result = await dir.initialize();
    expect(result).toBe(true);
    expect(dir.isReady()).toBe(true);
    expect(mockFs.createDirectory).toHaveBeenCalled();
  });

  it('getPath returns absolute path', async () => {
    await dir.initialize();
    const p = dir.getPath('cache', 'index.json');
    expect(p).toContain('.sidecar');
    expect(p).toContain('cache');
    expect(p).toContain('index.json');
  });

  it('readJson returns parsed JSON', async () => {
    await dir.initialize();
    mockFs.readFile.mockResolvedValue(Buffer.from('{"key": "value"}'));
    const data = await dir.readJson('cache/test.json');
    expect(data).toEqual({ key: 'value' });
  });

  it('readJson returns null for missing files', async () => {
    await dir.initialize();
    mockFs.readFile.mockRejectedValue(new Error('ENOENT'));
    const data = await dir.readJson('cache/missing.json');
    expect(data).toBeNull();
  });

  it('readJson returns null for invalid JSON', async () => {
    await dir.initialize();
    mockFs.readFile.mockResolvedValue(Buffer.from('not json'));
    const data = await dir.readJson('cache/bad.json');
    expect(data).toBeNull();
  });

  it('writeJson writes formatted JSON', async () => {
    await dir.initialize();
    await dir.writeJson('cache/out.json', { hello: 'world' });
    expect(mockFs.writeFile).toHaveBeenCalled();
    const written = mockFs.writeFile.mock.calls[mockFs.writeFile.mock.calls.length - 1][1];
    const parsed = JSON.parse(written.toString());
    expect(parsed).toEqual({ hello: 'world' });
  });

  it('throws if not initialized', () => {
    expect(() => dir.getPath('foo')).toThrow('not initialized');
  });

  it('isReady returns false before initialization', () => {
    expect(dir.isReady()).toBe(false);
  });
});
