import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseConflictBlocks, findConflictedFiles } from './conflictDetector.js';

// ---------------------------------------------------------------------------
// parseConflictBlocks — pure function tests
// ---------------------------------------------------------------------------

describe('parseConflictBlocks', () => {
  it('returns empty array when no markers', () => {
    expect(parseConflictBlocks('just normal code\nno conflicts here')).toEqual([]);
  });

  it('parses a standard 2-way conflict', () => {
    const content = [
      'before',
      '<<<<<<< HEAD',
      'ours content',
      '=======',
      'theirs content',
      '>>>>>>> feature-branch',
      'after',
    ].join('\n');

    const blocks = parseConflictBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].ours).toBe('ours content');
    expect(blocks[0].theirs).toBe('theirs content');
    expect(blocks[0].base).toBeNull();
    expect(blocks[0].oursLabel).toBe('HEAD');
    expect(blocks[0].theirsLabel).toBe('feature-branch');
    expect(blocks[0].index).toBe(0);
  });

  it('parses diff3 format with base section', () => {
    const content = ['<<<<<<< HEAD', 'ours', '||||||| base', 'base content', '=======', 'theirs', '>>>>>>> other'].join(
      '\n',
    );

    const blocks = parseConflictBlocks(content);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].ours).toBe('ours');
    expect(blocks[0].base).toBe('base content');
    expect(blocks[0].theirs).toBe('theirs');
  });

  it('parses multiple blocks in order', () => {
    const content = [
      '<<<<<<< HEAD',
      'a',
      '=======',
      'b',
      '>>>>>>> branch',
      'middle',
      '<<<<<<< HEAD',
      'c',
      '=======',
      'd',
      '>>>>>>> branch',
    ].join('\n');

    const blocks = parseConflictBlocks(content);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].index).toBe(0);
    expect(blocks[0].ours).toBe('a');
    expect(blocks[1].index).toBe(1);
    expect(blocks[1].ours).toBe('c');
  });

  it('offsets are non-overlapping and monotonically increasing', () => {
    const content = [
      '<<<<<<< HEAD',
      'x',
      '=======',
      'y',
      '>>>>>>> b',
      'gap',
      '<<<<<<< HEAD',
      'p',
      '=======',
      'q',
      '>>>>>>> b',
    ].join('\n');

    const [b0, b1] = parseConflictBlocks(content);
    expect(b0.startOffset).toBeLessThan(b0.endOffset);
    expect(b0.endOffset).toBeLessThan(b1.startOffset);
    expect(b1.startOffset).toBeLessThan(b1.endOffset);
  });

  it('silently drops an unclosed (malformed) block', () => {
    const content = ['<<<<<<< HEAD', 'ours', '=======', 'theirs'].join('\n');
    // No closing >>>>>>> — should produce no complete blocks
    expect(parseConflictBlocks(content)).toHaveLength(0);
  });

  it('captures multi-line ours and theirs content', () => {
    const content = ['<<<<<<< HEAD', 'line1', 'line2', '=======', 'theirLine1', 'theirLine2', '>>>>>>> other'].join(
      '\n',
    );
    const [block] = parseConflictBlocks(content);
    expect(block.ours).toBe('line1\nline2');
    expect(block.theirs).toBe('theirLine1\ntheirLine2');
  });
});

// ---------------------------------------------------------------------------
// findConflictedFiles — uses mocked fs
// ---------------------------------------------------------------------------

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: vi.fn(),
      stat: vi.fn(),
      readFile: vi.fn(),
    },
  };
});

import * as fsMock from 'fs';

describe('findConflictedFiles', () => {
  const root = '/workspace';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns files containing conflict markers', async () => {
    const conflictContent = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';
    vi.mocked(fsMock.promises.readdir).mockImplementation(async (dir) => {
      if (dir === root) return [{ name: 'file.ts', isFile: () => true, isDirectory: () => false }] as never;
      return [] as never;
    });
    vi.mocked(fsMock.promises.stat).mockResolvedValue({ size: 100 } as never);
    vi.mocked(fsMock.promises.readFile).mockResolvedValue(Buffer.from(conflictContent) as never);

    const files = await findConflictedFiles(root);
    expect(files).toHaveLength(1);
    expect(files[0].blocks).toHaveLength(1);
    expect(files[0].relativePath).toBe('file.ts');
  });

  it('skips files with no conflict markers', async () => {
    vi.mocked(fsMock.promises.readdir).mockImplementation(async (dir) => {
      if (dir === root) return [{ name: 'clean.ts', isFile: () => true, isDirectory: () => false }] as never;
      return [] as never;
    });
    vi.mocked(fsMock.promises.stat).mockResolvedValue({ size: 50 } as never);
    vi.mocked(fsMock.promises.readFile).mockResolvedValue(Buffer.from('no conflicts here') as never);

    expect(await findConflictedFiles(root)).toHaveLength(0);
  });

  it('skips node_modules directory', async () => {
    vi.mocked(fsMock.promises.readdir).mockImplementation(async (dir) => {
      if (dir === root) return [{ name: 'node_modules', isFile: () => false, isDirectory: () => true }] as never;
      return [] as never;
    });

    expect(await findConflictedFiles(root)).toHaveLength(0);
    // readFile should never have been called
    expect(fsMock.promises.readFile).not.toHaveBeenCalled();
  });
});
