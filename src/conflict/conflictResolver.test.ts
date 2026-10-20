import { describe, it, expect, vi } from 'vitest';
import { buildConflictPrompt, applyResolutions, resolveConflicts, cleanResolution } from './conflictResolver.js';
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

  // #119: the span ends with the >>>>>>> line's line break and the resolution
  // is trimmed, so the next line was glued onto the resolved block.
  it('keeps the line break after a resolved block (LF and CRLF)', async () => {
    const { parseConflictBlocks } = await import('./conflictDetector.js');
    for (const eol of ['\n', '\r\n']) {
      const original = ['before', '<<<<<<< HEAD', 'ours', '=======', 'theirs', '>>>>>>> branch', 'after', ''].join(eol);
      const blocks = parseConflictBlocks(original);
      expect(applyResolutions(original, blocks, new Map([[0, 'merged']]))).toBe(
        ['before', 'merged', 'after', ''].join(eol),
      );
      expect(applyResolutions(original, blocks, new Map([[0, '']]))).toBe(['before', 'after', ''].join(eol));
    }
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
    // The file's trailing line break survives (#119); it used to be dropped.
    expect(result.resolvedContent).toBe('merged\n');
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

// ---------------------------------------------------------------------------
// ML-19 (#165): the resolution used to be .trim()'d
// ---------------------------------------------------------------------------
describe('cleanResolution (ML-19)', () => {
  it("keeps the first line's indentation", () => {
    expect(cleanResolution('    return a + b;\n')).toBe('    return a + b;');
  });

  it('drops leading blank lines and trailing whitespace only', () => {
    expect(cleanResolution('\n\n  \n    x = 1\n    y = 2  \n\n')).toBe('    x = 1\n    y = 2');
  });

  it('unwraps a code fence around the whole answer instead of writing it', () => {
    expect(cleanResolution('```python\n    x = 1\n    y = 2\n```')).toBe('    x = 1\n    y = 2');
    expect(cleanResolution('```\nfoo()\n```\n')).toBe('foo()');
  });

  it('leaves code that merely contains a fence alone', () => {
    const md = 'Usage:\n```\nrun()\n```\nmore';
    expect(cleanResolution(md)).toBe(md);
  });
});

describe('applyResolutions line endings (ML-19)', () => {
  it('writes a multi-line resolution with CRLF into a CRLF file', async () => {
    const { parseConflictBlocks } = await import('./conflictDetector.js');
    const original = ['a', '<<<<<<< HEAD', 'x', '=======', 'y', '>>>>>>> b', 'z', ''].join('\r\n');
    const blocks = parseConflictBlocks(original);
    const out = applyResolutions(original, blocks, new Map([[0, 'line1\nline2']]));
    expect(out).toBe(['a', 'line1', 'line2', 'z', ''].join('\r\n'));
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });
});

describe('resolveConflicts keeps indentation end to end (ML-19)', () => {
  it('a fenced, indented answer lands in an indented CRLF block intact', async () => {
    const { parseConflictBlocks } = await import('./conflictDetector.js');
    const original = ['def f():', '<<<<<<< HEAD', '    return 1', '=======', '    return 2', '>>>>>>> b', ''].join(
      '\r\n',
    );
    const file = {
      fsPath: '/w/f.py',
      relativePath: 'f.py',
      blocks: parseConflictBlocks(original),
      originalContent: original,
    } as ConflictFile;
    const client = {
      complete: vi.fn().mockResolvedValue('```python\n    return 1 + 2\n```'),
    } as unknown as import('../ollama/client.js').SideCarClient;
    const { resolvedContent } = await resolveConflicts(file, client);
    expect(resolvedContent).toBe(['def f():', '    return 1 + 2', ''].join('\r\n'));
  });
});
