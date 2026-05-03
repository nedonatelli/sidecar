import { describe, it, expect, vi, beforeEach } from 'vitest';

// Using vi.hoisted to prevent hoisting issues with vi.mock
const { mockFs } = vi.hoisted(() => ({
  mockFs: {
    createDirectory: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn(),
    writeFile: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn(),
    readDirectory: vi.fn(),
  },
}));

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

  it('writes .gitignore when stat throws (file missing)', async () => {
    mockFs.stat.mockRejectedValueOnce(new Error('ENOENT'));
    const result = await dir.initialize();
    expect(result).toBe(true);
    expect(mockFs.writeFile).toHaveBeenCalled();
    const calls = mockFs.writeFile.mock.calls;
    const gitignoreCall = calls.find((c: unknown[]) => {
      const uri = c[0] as { fsPath?: string; path?: string };
      return (uri?.path ?? uri?.fsPath ?? '').includes('.gitignore');
    });
    expect(gitignoreCall).toBeDefined();
  });

  it('appendJsonl creates a new file when it does not exist', async () => {
    await dir.initialize();
    mockFs.readFile.mockRejectedValueOnce(new Error('ENOENT'));
    await dir.appendJsonl('logs/api.jsonl', { event: 'test' });
    const calls = mockFs.writeFile.mock.calls;
    const lastCall = calls[calls.length - 1];
    const written = lastCall[1].toString();
    expect(written).toContain('"event":"test"');
    expect(written.endsWith('\n')).toBe(true);
  });

  it('appendJsonl appends to an existing file', async () => {
    await dir.initialize();
    const existing = Buffer.from('{"a":1}\n');
    mockFs.readFile.mockResolvedValueOnce(existing);
    await dir.appendJsonl('logs/api.jsonl', { b: 2 });
    const calls = mockFs.writeFile.mock.calls;
    const lastCall = calls[calls.length - 1];
    const written = lastCall[1].toString();
    expect(written).toContain('"a":1');
    expect(written).toContain('"b":2');
  });

  it('writeText writes UTF-8 content', async () => {
    await dir.initialize();
    await dir.writeText('plans/foo.md', '# Plan');
    const calls = mockFs.writeFile.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[1].toString()).toBe('# Plan');
  });

  it('readText returns string content', async () => {
    await dir.initialize();
    mockFs.readFile.mockResolvedValueOnce(Buffer.from('hello world'));
    const result = await dir.readText('plans/foo.md');
    expect(result).toBe('hello world');
  });

  it('readText returns null when file is missing', async () => {
    await dir.initialize();
    mockFs.readFile.mockRejectedValueOnce(new Error('ENOENT'));
    const result = await dir.readText('plans/missing.md');
    expect(result).toBeNull();
  });

  it('listFiles returns file names in a subdirectory', async () => {
    await dir.initialize();
    const mockEntries: [string, number][] = [
      ['file1.md', 1],
      ['file2.md', 1],
      ['subdir', 2],
    ];
    mockFs.readDirectory.mockResolvedValueOnce(mockEntries);
    const result = await dir.listFiles('plans');
    expect(result).toEqual(['file1.md', 'file2.md']);
  });

  it('listFiles returns empty array when directory is missing', async () => {
    await dir.initialize();
    mockFs.readDirectory.mockRejectedValueOnce(new Error('ENOENT'));
    const result = await dir.listFiles('plans');
    expect(result).toEqual([]);
  });
});
