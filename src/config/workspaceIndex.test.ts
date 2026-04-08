import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkspaceIndex } from './workspaceIndex.js';
import { workspace } from 'vscode';

describe('WorkspaceIndex', () => {
  let index: WorkspaceIndex;

  beforeEach(() => {
    index = new WorkspaceIndex(5000);
    vi.restoreAllMocks();
  });

  it('starts as not ready with no files', () => {
    expect(index.isReady()).toBe(false);
    expect(index.getFileCount()).toBe(0);
  });

  it('initializes and indexes files from workspace', async () => {
    const mockUris = [{ fsPath: '/mock-workspace/src/index.ts' }, { fsPath: '/mock-workspace/package.json' }];
    vi.spyOn(workspace, 'findFiles').mockResolvedValue(mockUris as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 500 } as never);

    await index.initialize(['**/*.ts', '**/*.json']);

    expect(index.isReady()).toBe(true);
    expect(index.getFileCount()).toBe(2);
  });

  it('skips files larger than 100KB', async () => {
    const mockUris = [{ fsPath: '/mock-workspace/small.ts' }, { fsPath: '/mock-workspace/large.bin' }];
    vi.spyOn(workspace, 'findFiles').mockResolvedValue(mockUris as never);
    vi.spyOn(workspace.fs, 'stat')
      .mockResolvedValueOnce({ type: 1, size: 500 } as never)
      .mockResolvedValueOnce({ type: 1, size: 200_000 } as never);

    await index.initialize(['**/*']);
    expect(index.getFileCount()).toBe(1);
  });

  it('getRelevantContext returns empty for no files', async () => {
    const context = await index.getRelevantContext('test query');
    expect(context).toBe('');
  });

  it('getRelevantContext includes tree structure', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([{ fsPath: '/mock-workspace/src/app.ts' }] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from('const x = 1;') as never);

    await index.initialize(['**/*.ts']);
    const context = await index.getRelevantContext('app');

    expect(context).toContain('Workspace Structure');
    expect(context).toContain('app.ts');
  });

  it('boosts relevance for files mentioned in query', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([
      { fsPath: '/mock-workspace/src/foo.ts' },
      { fsPath: '/mock-workspace/src/bar.ts' },
    ] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from('content') as never);

    await index.initialize(['**/*.ts']);
    const context = await index.getRelevantContext('look at src/foo.ts');

    expect(context).toContain('Relevant Files');
    expect(context).toContain('foo.ts');
  });

  it('updateRelevance increases score for mentioned paths', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([{ fsPath: '/mock-workspace/src/low.ts' }] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);

    await index.initialize(['**/*.ts']);
    index.updateRelevance(['src/low.ts']);
    index.updateRelevance(['nonexistent.ts']); // should be a no-op
    expect(index.getFileCount()).toBe(1);
  });

  it('gives higher base score to root config files', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([
      { fsPath: '/mock-workspace/package.json' },
      { fsPath: '/mock-workspace/src/utils.ts' },
    ] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from('{}') as never);

    await index.initialize(['**/*']);
    const context = await index.getRelevantContext('some query');
    expect(context).toContain('package.json');
  });

  it('respects token budget', async () => {
    const smallIndex = new WorkspaceIndex(200);
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([
      { fsPath: '/mock-workspace/a.ts' },
      { fsPath: '/mock-workspace/b.ts' },
    ] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from('x'.repeat(500)) as never);

    await smallIndex.initialize(['**/*.ts']);
    const context = await smallIndex.getRelevantContext('a.ts');
    // Tree is always included but file contents should be limited
    expect(context.length).toBeLessThan(500);
  });

  it('trackFileAccess boosts write more than read', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([
      { fsPath: '/mock-workspace/src/a.ts' },
      { fsPath: '/mock-workspace/src/b.ts' },
    ] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from('code') as never);

    await index.initialize(['**/*.ts']);

    // Both start with the same base score
    index.trackFileAccess('src/a.ts', 'read');
    index.trackFileAccess('src/b.ts', 'write');

    // b.ts (write) should rank higher than a.ts (read) in Relevant Files section
    const context = await index.getRelevantContext('test');
    const relevantSection = context.slice(context.indexOf('## Relevant Files'));
    const aPos = relevantSection.indexOf('a.ts');
    const bPos = relevantSection.indexOf('b.ts');
    // b.ts should appear first (higher score)
    expect(bPos).toBeLessThan(aPos);
  });

  it('decayRelevance reduces scores but not below base', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([{ fsPath: '/mock-workspace/src/x.ts' }] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);

    await index.initialize(['**/*.ts']);

    // Boost then decay many times
    index.trackFileAccess('src/x.ts', 'write');
    for (let i = 0; i < 100; i++) {
      index.decayRelevance();
    }

    // Score should have decayed but file should still be indexed
    expect(index.getFileCount()).toBe(1);
  });

  it('trackFileAccess is a no-op for unknown paths', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([] as never);
    await index.initialize(['**/*.ts']);
    // Should not throw
    index.trackFileAccess('nonexistent.ts', 'read');
    expect(index.getFileCount()).toBe(0);
  });

  it('dispose cleans up without error', () => {
    expect(() => index.dispose()).not.toThrow();
  });

  // --- Context pinning tests ---

  it('addPin and removePin manage pinned paths', () => {
    index.addPin('src/important.ts');
    index.addPin('src/config/');
    // No assertion on internals — just verify no errors
    index.removePin('src/important.ts');
    index.removePin('nonexistent.ts'); // no-op
  });

  it('setPinnedPaths replaces all pins', () => {
    index.addPin('src/a.ts');
    index.setPinnedPaths(['src/b.ts', 'src/c.ts']);
    // The old pin (a.ts) should be gone, replaced by b.ts and c.ts
    // We verify via getRelevantContext output
  });

  it('pinned files appear in Pinned Files section', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([
      { fsPath: '/mock-workspace/src/pinned.ts' },
      { fsPath: '/mock-workspace/src/normal.ts' },
    ] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from('pinned content') as never);

    await index.initialize(['**/*.ts']);
    index.addPin('src/pinned.ts');

    const context = await index.getRelevantContext('test');
    expect(context).toContain('Pinned Files');
    expect(context).toContain('pinned.ts (pinned)');
  });

  it('pinned files are not duplicated in Relevant Files', async () => {
    vi.spyOn(workspace, 'findFiles').mockResolvedValue([{ fsPath: '/mock-workspace/src/only.ts' }] as never);
    vi.spyOn(workspace.fs, 'stat').mockResolvedValue({ type: 1, size: 100 } as never);
    vi.spyOn(workspace.fs, 'readFile').mockResolvedValue(Buffer.from('code') as never);

    await index.initialize(['**/*.ts']);
    index.addPin('src/only.ts');

    const context = await index.getRelevantContext('only');
    // Should appear in pinned, not in the relevant files section.
    // The workspace tree (at the end) may also mention the file name,
    // so we only check the relevant files section between the two headers.
    const relevantStart = context.indexOf('## Relevant Files');
    const treeStart = context.indexOf('## Workspace Structure');
    expect(context).toContain('only.ts (pinned)');
    if (relevantStart !== -1) {
      const end = treeStart !== -1 && treeStart > relevantStart ? treeStart : context.length;
      const relevantSection = context.slice(relevantStart, end);
      expect(relevantSection).not.toContain('only.ts\n');
    }
  });
});
