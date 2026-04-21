import { describe, it, expect, vi } from 'vitest';
import { buildConflictPrompt, applyResolutions, resolveConflicts } from './conflictResolver.js';
import type { ConflictBlock, ConflictFile } from './conflictDetector.js';

function makeBlock(overrides: Partial<ConflictBlock> = {}): ConflictBlock {
  return {
    index: 0,
    ours: 'ours code',
    base: null,
    theirs: 'theirs code',
    oursLabel: 'HEAD',
    theirsLabel: 'feature',
    startOffset: 0,
    endOffset: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildConflictPrompt
// ---------------------------------------------------------------------------

describe('buildConflictPrompt', () => {
  it('includes ours, theirs, and instruction in 2-way format', () => {
    const prompt = buildConflictPrompt(makeBlock());
    expect(prompt).toContain('ours code');
    expect(prompt).toContain('theirs code');
    expect(prompt).toContain('MERGED OUTPUT');
    expect(prompt).not.toContain('BASE');
  });

  it('includes base section in diff3 format', () => {
    const prompt = buildConflictPrompt(makeBlock({ base: 'base content' }));
    expect(prompt).toContain('base content');
    expect(prompt).toContain('BASE');
  });

  it('includes ours and theirs labels', () => {
    const prompt = buildConflictPrompt(makeBlock({ oursLabel: 'main', theirsLabel: 'pr-123' }));
    expect(prompt).toContain('main');
    expect(prompt).toContain('pr-123');
  });
});

// ---------------------------------------------------------------------------
// applyResolutions
// ---------------------------------------------------------------------------

describe('applyResolutions', () => {
  it('replaces a single block span with the resolution', () => {
    // content: "BEFORE[conflict block]AFTER"
    const original = 'BEFORE<<<conflict>>>AFTER';
    const block = makeBlock({ index: 0, startOffset: 6, endOffset: 20 });
    const resolutions = new Map([[0, 'RESOLVED']]);
    expect(applyResolutions(original, [block], resolutions)).toBe('BEFORERESOLVEDAFTER');
  });

  it('handles multiple blocks in reverse-offset order for stability', () => {
    const original = 'A[b1]B[b2]C';
    // b1 at offset 1–4, b2 at offset 6–9
    const blocks: ConflictBlock[] = [
      makeBlock({ index: 0, startOffset: 1, endOffset: 5 }),
      makeBlock({ index: 1, startOffset: 6, endOffset: 10 }),
    ];
    const resolutions = new Map([
      [0, 'X'],
      [1, 'Y'],
    ]);
    const result = applyResolutions(original, blocks, resolutions);
    expect(result).toBe('AXBYC');
  });

  it('leaves unresolved blocks unchanged', () => {
    const original = 'AB';
    const block = makeBlock({ index: 0, startOffset: 0, endOffset: 1 });
    // No entry in resolutions map → block stays
    const result = applyResolutions(original, [block], new Map());
    expect(result).toBe('AB');
  });
});

// ---------------------------------------------------------------------------
// resolveConflicts
// ---------------------------------------------------------------------------

describe('resolveConflicts', () => {
  function makeFile(blocks: ConflictBlock[], content: string): ConflictFile {
    return {
      fsPath: '/workspace/file.ts',
      relativePath: 'file.ts',
      blocks,
      originalContent: content,
    };
  }

  it('resolves all blocks on happy path', async () => {
    const original = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch\n';
    const block = makeBlock({ index: 0, startOffset: 0, endOffset: original.length });
    const file = makeFile([block], original);

    const client = {
      complete: vi.fn().mockResolvedValue('merged'),
    } as unknown as import('../ollama/client.js').SideCarClient;
    const result = await resolveConflicts(file, client);

    expect(result.resolvedBlocks).toBe(1);
    expect(result.totalBlocks).toBe(1);
    expect(result.resolvedContent).toBe('merged');
  });

  it('skips a block when complete() throws a non-abort error', async () => {
    const block0 = makeBlock({ index: 0, startOffset: 0, endOffset: 5 });
    const block1 = makeBlock({ index: 1, startOffset: 5, endOffset: 10 });
    const file = makeFile([block0, block1], '0123456789');

    const client = {
      complete: vi.fn().mockRejectedValueOnce(new Error('LLM timeout')).mockResolvedValueOnce('ok'),
    } as unknown as import('../ollama/client.js').SideCarClient;

    const result = await resolveConflicts(file, client);
    expect(result.resolvedBlocks).toBe(1);
    expect(result.totalBlocks).toBe(2);
  });

  it('stops iterating on AbortError', async () => {
    const block0 = makeBlock({ index: 0, startOffset: 0, endOffset: 5 });
    const block1 = makeBlock({ index: 1, startOffset: 5, endOffset: 10 });
    const file = makeFile([block0, block1], '0123456789');

    const abortErr = new Error('abort');
    abortErr.name = 'AbortError';
    const client = {
      complete: vi.fn().mockRejectedValue(abortErr),
    } as unknown as import('../ollama/client.js').SideCarClient;

    const result = await resolveConflicts(file, client);
    expect(result.resolvedBlocks).toBe(0);
    // complete() called once (for block0), then aborted before block1
    expect(client.complete).toHaveBeenCalledTimes(1);
  });

  it('stops early when signal is already aborted', async () => {
    const block = makeBlock({ index: 0, startOffset: 0, endOffset: 5 });
    const file = makeFile([block], '01234');

    const ac = new AbortController();
    ac.abort();
    const client = { complete: vi.fn() } as unknown as import('../ollama/client.js').SideCarClient;

    const result = await resolveConflicts(file, client, ac.signal);
    expect(result.resolvedBlocks).toBe(0);
    expect(client.complete).not.toHaveBeenCalled();
  });
});
