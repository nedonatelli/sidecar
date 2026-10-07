import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace } from 'vscode';
import { parseSidecarIgnore, isSidecarIgnored } from './sidecarIgnore.js';
import { WorkspaceIndex } from './workspaceIndex.js';

const IGNORE = ['# keep secrets out', 'secrets/', '*.pem', 'config/prod', 'notes/*.md', '.env.local'].join('\r\n');

describe('parseSidecarIgnore', () => {
  const m = parseSidecarIgnore(IGNORE);
  it.each([
    ['secrets/db.json', true],
    ['app/secrets/token.txt', true],
    ['certs/server.pem', true],
    ['config/prod/keys.ts', true],
    ['config/prod', true],
    ['notes/todo.md', true],
    ['.env.local', true],
    ['config\\prod\\keys.ts', true], // a backslash path is the same path
    ['src/app.ts', false],
    ['config/production.ts', false],
    ['notes/sub/todo.md', false],
  ])('%s ignored: %s', (p, expected) => {
    expect(isSidecarIgnored(p, m)).toBe(expected);
  });
});

// The docs present .sidecarignore as the way to keep sensitive files out of
// context. It reached only the file watchers: the full scan and the cache
// restore indexed everything, so an ignored file was still ranked and sent.
describe('WorkspaceIndex applies .sidecarignore on the full scan', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('never indexes an ignored file', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([
      { fsPath: '/mock-workspace/src/app.ts' },
      { fsPath: '/mock-workspace/secrets/db.json' },
      { fsPath: '/mock-workspace/certs/server.pem' },
      { fsPath: '/mock-workspace/config/prod/keys.ts' },
    ] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    vi.spyOn(workspace.fs, 'readFile').mockImplementation((async (uri: { fsPath: string }) => {
      if (uri.fsPath.endsWith('.sidecarignore')) return Buffer.from(IGNORE);
      throw new Error('ENOENT');
    }) as never);

    const index = new WorkspaceIndex(5000);
    await index.initialize(['**/*']);
    expect([...index.getFiles()].map((f) => f.relativePath)).toEqual(['src/app.ts']);
  });

  it('matches a folder pin however it is written', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([
      { fsPath: '/mock-workspace/src/config/a.ts' },
      { fsPath: '/mock-workspace/src/other.ts' },
    ] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(new Error('ENOENT'));
    const index = new WorkspaceIndex(5000);
    await index.initialize(['**/*']);
    for (const pin of ['src/config', 'src/config/', 'src\\config']) {
      index.setPinnedPaths([pin]);
      const pinned = (index as unknown as { getPinnedFileSet(): Set<string> }).getPinnedFileSet();
      expect([...pinned], pin).toEqual(['src/config/a.ts']);
    }
  });
});

// `**` was two single-segment stars, so the documented `**/*.jpg` matched one
// level deep only -- never at the root, never two levels down -- and failed open.
describe('.gitignore-style ** and [] in .sidecarignore', () => {
  const ignored = (pattern: string, rel: string) => isSidecarIgnored(rel, parseSidecarIgnore(pattern));

  it.each([
    ['**/*.jpg', 'photo.jpg'],
    ['**/*.jpg', 'a/photo.jpg'],
    ['**/*.jpg', 'a/b/c/photo.jpg'],
    ['**/secrets', 'deep/er/secrets/key.txt'],
    ['docs/**/internal.md', 'docs/internal.md'],
    ['docs/**/internal.md', 'docs/a/b/internal.md'],
    ['config/*.[jy]ml', 'config/app.yml'],
  ])('%s ignores %s', (pattern, rel) => {
    expect(ignored(pattern, rel)).toBe(true);
  });

  it.each([
    ['**/*.jpg', 'a/photo.png'],
    ['docs/**/internal.md', 'src/internal.md'],
    ['config/*.[jy]ml', 'config/app.xml'],
  ])('%s does not ignore %s', (pattern, rel) => {
    expect(ignored(pattern, rel)).toBe(false);
  });
});

// Patterns added mid-session used to apply only after a reload.
describe('a changed .sidecarignore takes effect without a reload', () => {
  it('drops the files it now excludes from the index', async () => {
    const index = new WorkspaceIndex(5000);
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([
      { fsPath: '/mock-workspace/src/a.ts' },
      { fsPath: '/mock-workspace/private/plan.md' },
    ] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    const read = vi.spyOn(workspace.fs, 'readFile').mockRejectedValue(new Error('ENOENT'));
    await index.initialize(['**/*']);
    expect([...index.getFiles()].map((f) => f.relativePath).sort()).toEqual(['private/plan.md', 'src/a.ts']);

    read.mockResolvedValue(Buffer.from('private/') as never);
    await index.reloadIgnore({ fsPath: '/mock-workspace' } as never);
    expect([...index.getFiles()].map((f) => f.relativePath)).toEqual(['src/a.ts']);
  });
});
