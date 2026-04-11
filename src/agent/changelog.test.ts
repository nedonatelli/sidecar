import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChangeLog } from './changelog.js';

// Mock vscode
vi.mock('vscode', () => {
  const files = new Map<string, string>();
  return {
    workspace: {
      workspaceFolders: [{ uri: { fsPath: '/project' } }],
      fs: {
        readFile: vi.fn().mockImplementation(async (uri: { path: string }) => {
          const content = files.get(uri.path);
          if (content === undefined) throw new Error('File not found');
          return Buffer.from(content, 'utf-8');
        }),
        writeFile: vi.fn().mockImplementation(async (uri: { path: string }, data: Buffer) => {
          files.set(uri.path, data.toString('utf-8'));
        }),
        delete: vi.fn().mockImplementation(async (uri: { path: string }) => {
          if (!files.has(uri.path)) throw new Error('File not found');
          files.delete(uri.path);
        }),
      },
    },
    Uri: {
      joinPath: (_base: unknown, ...segments: string[]) => ({
        path: '/project/' + segments.join('/'),
        fsPath: '/project/' + segments.join('/'),
      }),
    },
    // Expose files map for test setup
    __files: files,
  };
});

// Access the mock files map
import * as vscode from 'vscode';
const files = (vscode as unknown as { __files: Map<string, string> }).__files;

describe('ChangeLog', () => {
  let changelog: ChangeLog;

  beforeEach(() => {
    changelog = new ChangeLog();
    files.clear();
    vi.clearAllMocks();
  });

  describe('snapshotFile', () => {
    it('captures existing file content', async () => {
      files.set('/project/src/main.ts', 'original content');
      await changelog.snapshotFile('src/main.ts');
      const changes = changelog.getChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0].filePath).toBe('src/main.ts');
      expect(changes[0].originalContent).toBe('original content');
    });

    it('records null for new files', async () => {
      await changelog.snapshotFile('new-file.ts');
      const changes = changelog.getChanges();
      expect(changes).toHaveLength(1);
      expect(changes[0].originalContent).toBeNull();
    });

    it('does not duplicate snapshots for the same file', async () => {
      files.set('/project/f.ts', 'v1');
      await changelog.snapshotFile('f.ts');
      files.set('/project/f.ts', 'v2');
      await changelog.snapshotFile('f.ts');
      expect(changelog.getChanges()).toHaveLength(1);
      expect(changelog.getChanges()[0].originalContent).toBe('v1');
    });
  });

  describe('hasChanges', () => {
    it('returns false when empty', () => {
      expect(changelog.hasChanges()).toBe(false);
    });

    it('returns true after snapshot', async () => {
      files.set('/project/f.ts', 'x');
      await changelog.snapshotFile('f.ts');
      expect(changelog.hasChanges()).toBe(true);
    });
  });

  describe('rollbackAll', () => {
    it('restores modified files and deletes new files', async () => {
      files.set('/project/existing.ts', 'original');
      await changelog.snapshotFile('existing.ts');
      await changelog.snapshotFile('created.ts'); // new file

      // Simulate agent edits
      files.set('/project/existing.ts', 'modified');
      files.set('/project/created.ts', 'new content');

      const result = await changelog.rollbackAll();
      expect(result.restored).toBe(1);
      expect(result.deleted).toBe(1);
      expect(result.failed).toBe(0);

      // existing.ts should be restored
      expect(files.get('/project/existing.ts')).toBe('original');
      // created.ts should be deleted
      expect(files.has('/project/created.ts')).toBe(false);
      // changelog should be cleared
      expect(changelog.hasChanges()).toBe(false);
    });

    it('processes changes in reverse order', async () => {
      const order: string[] = [];
      files.set('/project/a.ts', 'a');
      files.set('/project/b.ts', 'b');
      await changelog.snapshotFile('a.ts');
      await changelog.snapshotFile('b.ts');

      // Track write order via mock
      const origWrite = vscode.workspace.fs.writeFile as ReturnType<typeof vi.fn>;
      origWrite.mockImplementation(async (uri: { path: string }, data: Buffer) => {
        order.push(uri.path);
        files.set(uri.path, data.toString('utf-8'));
      });

      await changelog.rollbackAll();
      // b.ts should be processed before a.ts (reverse order)
      expect(order[0]).toContain('b.ts');
      expect(order[1]).toContain('a.ts');
    });
  });

  describe('rollbackFile', () => {
    it('restores a single file', async () => {
      files.set('/project/f.ts', 'original');
      await changelog.snapshotFile('f.ts');
      files.set('/project/f.ts', 'changed');

      const result = await changelog.rollbackFile('f.ts');
      expect(result).toBe(true);
      expect(files.get('/project/f.ts')).toBe('original');
      expect(changelog.getChanges()).toHaveLength(0);
    });

    it('returns false for untracked file', async () => {
      const result = await changelog.rollbackFile('unknown.ts');
      expect(result).toBe(false);
    });

    it('deletes a file that was newly created', async () => {
      await changelog.snapshotFile('new.ts'); // originalContent = null
      files.set('/project/new.ts', 'content');

      const result = await changelog.rollbackFile('new.ts');
      expect(result).toBe(true);
      expect(files.has('/project/new.ts')).toBe(false);
    });
  });

  describe('clear', () => {
    it('removes all tracked changes', async () => {
      files.set('/project/f.ts', 'x');
      await changelog.snapshotFile('f.ts');
      changelog.clear();
      expect(changelog.hasChanges()).toBe(false);
      expect(changelog.getChanges()).toHaveLength(0);
    });
  });

  describe('getChangeSummary', () => {
    it('returns original and current content for each change', async () => {
      files.set('/project/a.ts', 'original');
      await changelog.snapshotFile('a.ts');
      files.set('/project/a.ts', 'modified');

      const summary = await changelog.getChangeSummary();
      expect(summary).toHaveLength(1);
      expect(summary[0].filePath).toBe('a.ts');
      expect(summary[0].original).toBe('original');
      expect(summary[0].current).toBe('modified');
    });

    it('returns null current when file was deleted', async () => {
      files.set('/project/b.ts', 'content');
      await changelog.snapshotFile('b.ts');
      files.delete('/project/b.ts');

      const summary = await changelog.getChangeSummary();
      expect(summary).toHaveLength(1);
      expect(summary[0].original).toBe('content');
      expect(summary[0].current).toBeNull();
    });

    it('returns null original for new files', async () => {
      await changelog.snapshotFile('new.ts');
      files.set('/project/new.ts', 'new content');

      const summary = await changelog.getChangeSummary();
      expect(summary).toHaveLength(1);
      expect(summary[0].original).toBeNull();
      expect(summary[0].current).toBe('new content');
    });

    it('returns empty array when no workspace', async () => {
      const origFolders = (await import('vscode')).workspace.workspaceFolders;
      const vsc = await import('vscode');
      (vsc.workspace as Record<string, unknown>).workspaceFolders = undefined;

      const summary = await changelog.getChangeSummary();
      expect(summary).toEqual([]);

      (vsc.workspace as Record<string, unknown>).workspaceFolders = origFolders;
    });
  });
});
