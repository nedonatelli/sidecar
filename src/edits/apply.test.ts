import { describe, it, expect, vi, beforeEach } from 'vitest';
import { workspace } from 'vscode';
import { applyEdit, applyEdits } from './apply.js';
import type { EditBlock } from './parser.js';

// Add missing applyEdit to workspace mock
const ws = workspace as unknown as Record<string, unknown>;
if (!ws.applyEdit) {
  ws.applyEdit = vi.fn().mockResolvedValue(true);
}

describe('applyEdit', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    ws.applyEdit = vi.fn().mockResolvedValue(true);
  });

  it('returns false when no workspace folders', async () => {
    vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue(undefined as never);
    const result = await applyEdit({ filePath: 'test.ts', searchText: 'old', replaceText: 'new' });
    expect(result).toBe(false);
  });

  it('applies exact match edit', async () => {
    const mockDoc = {
      getText: () => 'const x = 1;\nconst y = 2;',
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    };
    vi.spyOn(workspace, 'openTextDocument').mockResolvedValue(mockDoc as never);
    vi.spyOn(workspace, 'applyEdit').mockResolvedValue(true);

    const result = await applyEdit({ filePath: 'test.ts', searchText: 'const x = 1;', replaceText: 'const x = 42;' });
    expect(result).toBe(true);
    expect(workspace.applyEdit).toHaveBeenCalled();
  });

  it('returns false when search text not found', async () => {
    const mockDoc = {
      getText: () => 'const y = 2;',
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    };
    vi.spyOn(workspace, 'openTextDocument').mockResolvedValue(mockDoc as never);

    const result = await applyEdit({ filePath: 'test.ts', searchText: 'nonexistent', replaceText: 'new' });
    expect(result).toBe(false);
  });

  it('applies fuzzy match when search has leading/trailing whitespace', async () => {
    // Exact match fails (leading space in searchText), but after trim() on each line
    // the normalized comparison succeeds.
    const mockDoc = {
      getText: () => 'const x = 1;\nconst y = 2;',
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    };
    vi.spyOn(workspace, 'openTextDocument').mockResolvedValue(mockDoc as never);
    vi.spyOn(workspace, 'applyEdit').mockResolvedValue(true);

    // Leading space causes exact match failure; trim() in searchLines removes it
    const result = await applyEdit({ filePath: 'test.ts', searchText: '  const x = 1;', replaceText: 'const x = 99;' });
    expect(result).toBe(true);
    expect(workspace.applyEdit).toHaveBeenCalled();
  });

  it('returns false when fuzzy-normalized match found but line-by-line comparison fails', async () => {
    // Normalized strings match but line-by-line trimmed comparison fails due to blank line in doc
    const mockDoc = {
      getText: () => 'const x;\n\nconst y;',
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    };
    vi.spyOn(workspace, 'openTextDocument').mockResolvedValue(mockDoc as never);

    // searchText normalizes to match the doc text but the blank line prevents line match
    const result = await applyEdit({ filePath: 'test.ts', searchText: '  const x;   const y;', replaceText: 'new' });
    expect(result).toBe(false);
  });
});

describe('applyEdits', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns all failed when no workspace folders', async () => {
    vi.spyOn(workspace, 'workspaceFolders', 'get').mockReturnValue(undefined as never);
    const blocks: EditBlock[] = [{ filePath: 'a.ts', searchText: 'old', replaceText: 'new' }];
    const result = await applyEdits(blocks);
    expect(result).toEqual({ applied: 0, failed: 1 });
  });

  it('applies multiple edits and counts results', async () => {
    const mockDoc = {
      getText: () => 'const x = 1;',
      positionAt: (offset: number) => ({ line: 0, character: offset }),
    };
    vi.spyOn(workspace, 'openTextDocument').mockResolvedValue(mockDoc as never);
    vi.spyOn(workspace, 'applyEdit').mockResolvedValue(true);

    const blocks: EditBlock[] = [
      { filePath: 'a.ts', searchText: 'const x = 1;', replaceText: 'const x = 2;' },
      { filePath: 'b.ts', searchText: 'not found', replaceText: 'new' },
    ];
    const result = await applyEdits(blocks);
    expect(result.applied).toBe(1);
    expect(result.failed).toBe(1);
  });

  it('handles openTextDocument errors', async () => {
    vi.spyOn(workspace, 'openTextDocument').mockRejectedValue(new Error('file not found'));
    vi.spyOn(workspace, 'applyEdit').mockResolvedValue(true);

    const blocks: EditBlock[] = [{ filePath: 'missing.ts', searchText: 'old', replaceText: 'new' }];
    const result = await applyEdits(blocks);
    expect(result).toEqual({ applied: 0, failed: 1 });
  });
});
