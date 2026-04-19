import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleReviewModeTool, computePendingOverlay, REVIEW_OVERLAY_TOOLS } from './reviewModeHandler.js';
import type { ToolUseContentBlock } from '../../ollama/types.js';
import type { PendingEditStore } from '../pendingEdits.js';

// The vscode mock (src/__mocks__/vscode.ts) sets workspaceFolders[0].uri.fsPath
// to '/mock-workspace' and joinPath returns '{base.fsPath}/{segment}'.
// workspace.fs.readFile always resolves with Buffer.from('mock file content').
// All absolute paths in these tests use '/mock-workspace/' as the root so
// lookups in handleReviewModeTool agree with what the mock Uri.joinPath returns.

const ROOT = '/mock-workspace';

function makeToolUse(name: string, input: Record<string, unknown> = {}): ToolUseContentBlock {
  return { type: 'tool_use', id: 'tu1', name, input };
}

function makePendingStore(
  entries: Array<{ filePath: string; originalContent: string | null; newContent: string }>,
): PendingEditStore {
  const map = new Map(entries.map((e) => [e.filePath, e]));
  return {
    get: vi.fn((absPath: string) => map.get(absPath) ?? undefined),
    record: vi.fn(),
    getAll: vi.fn(() => entries),
    has: vi.fn((absPath: string) => map.has(absPath)),
    clear: vi.fn(),
  } as unknown as PendingEditStore;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// handleReviewModeTool
// ---------------------------------------------------------------------------

describe('handleReviewModeTool — read_file', () => {
  it('returns pending content when the file is in the store', async () => {
    const store = makePendingStore([
      { filePath: `${ROOT}/src/foo.ts`, originalContent: 'old', newContent: 'pending content' },
    ]);
    const result = await handleReviewModeTool(makeToolUse('read_file', { path: 'src/foo.ts' }), store);
    expect(result).not.toBeNull();
    expect(result!.content).toBe('pending content');
    expect(result!.is_error).toBeFalsy();
  });

  it('returns null (fall-through) when the file is not pending', async () => {
    const store = makePendingStore([]);
    const result = await handleReviewModeTool(makeToolUse('read_file', { path: 'src/bar.ts' }), store);
    expect(result).toBeNull();
  });

  it('returns null when path is missing', async () => {
    const store = makePendingStore([]);
    const result = await handleReviewModeTool(makeToolUse('read_file', {}), store);
    expect(result).toBeNull();
  });
});

describe('handleReviewModeTool — write_file', () => {
  it('records to the pending store and returns a queued message', async () => {
    const store = makePendingStore([]);
    const result = await handleReviewModeTool(
      makeToolUse('write_file', { path: 'src/new.ts', content: 'export const x = 1;' }),
      store,
    );
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Pending write queued for review');
    expect(result!.content).toContain('src/new.ts');
    expect(store.record).toHaveBeenCalledOnce();
    const [absPath, , newContent, op] = (store.record as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(absPath).toContain('src/new.ts');
    expect(newContent).toBe('export const x = 1;');
    expect(op).toBe('write_file');
  });

  it('returns null when path or content is missing', async () => {
    const store = makePendingStore([]);
    expect(await handleReviewModeTool(makeToolUse('write_file', { path: 'x.ts' }), store)).toBeNull();
    expect(await handleReviewModeTool(makeToolUse('write_file', { content: 'x' }), store)).toBeNull();
  });
});

describe('handleReviewModeTool — edit_file', () => {
  it('applies search/replace to existing pending content', async () => {
    const store = makePendingStore([
      {
        filePath: `${ROOT}/src/foo.ts`,
        originalContent: 'original',
        newContent: 'const x = 1;\nconst y = 2;',
      },
    ]);
    const result = await handleReviewModeTool(
      makeToolUse('edit_file', { path: 'src/foo.ts', search: 'const x = 1;', replace: 'const x = 42;' }),
      store,
    );
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Pending edit queued');
    const recorded = (store.record as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(recorded[2]).toContain('const x = 42;');
  });

  it('falls back to disk content when the file is not yet pending', async () => {
    // workspace.fs.readFile mock always returns 'mock file content'.
    // With no pending entry, edit_file should use that as the base.
    const store = makePendingStore([]);
    const result = await handleReviewModeTool(
      makeToolUse('edit_file', { path: 'src/exists.ts', search: 'mock file content', replace: 'updated' }),
      store,
    );
    expect(result).not.toBeNull();
    expect(result!.content).toContain('Pending edit queued');
  });

  it('returns an error when the search text is not found in the base content', async () => {
    const store = makePendingStore([
      {
        filePath: `${ROOT}/src/foo.ts`,
        originalContent: 'base',
        newContent: 'const value = "unchanged";',
      },
    ]);
    const result = await handleReviewModeTool(
      makeToolUse('edit_file', { path: 'src/foo.ts', search: 'nonexistent text', replace: 'new' }),
      store,
    );
    expect(result!.is_error).toBe(true);
    expect(result!.content).toContain('Search text not found');
  });
});

describe('handleReviewModeTool — other tools', () => {
  it('returns null for grep (overlay path, not intercept)', async () => {
    const store = makePendingStore([]);
    const result = await handleReviewModeTool(makeToolUse('grep', { pattern: 'foo' }), store);
    expect(result).toBeNull();
  });

  it('returns null for run_command', async () => {
    const store = makePendingStore([]);
    const result = await handleReviewModeTool(makeToolUse('run_command', { command: 'ls' }), store);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// computePendingOverlay
// ---------------------------------------------------------------------------

describe('computePendingOverlay', () => {
  it('returns empty string when the store is empty', () => {
    const store = makePendingStore([]);
    expect(computePendingOverlay(makeToolUse('grep', { pattern: 'foo' }), store)).toBe('');
  });

  it('grep: returns matching lines from pending files', () => {
    const store = makePendingStore([
      {
        filePath: `${ROOT}/src/foo.ts`,
        originalContent: null,
        newContent: 'const result = compute();\n// TODO later',
      },
    ]);
    const overlay = computePendingOverlay(makeToolUse('grep', { pattern: 'TODO' }), store);
    expect(overlay).toContain('⚠ Pending edits');
    expect(overlay).toContain('TODO later');
  });

  it('grep: returns empty when pattern does not match any pending file', () => {
    const store = makePendingStore([
      { filePath: `${ROOT}/src/foo.ts`, originalContent: null, newContent: 'no match here' },
    ]);
    const overlay = computePendingOverlay(makeToolUse('grep', { pattern: 'xyz_missing' }), store);
    expect(overlay).toBe('');
  });

  it('search_files: lists pending files matching the glob', () => {
    const store = makePendingStore([
      { filePath: `${ROOT}/src/alpha.ts`, originalContent: 'old', newContent: 'new' },
      { filePath: `${ROOT}/src/beta.md`, originalContent: null, newContent: '# doc' },
    ]);
    const overlay = computePendingOverlay(makeToolUse('search_files', { pattern: '**/*.ts' }), store);
    expect(overlay).toContain('src/alpha.ts');
    expect(overlay).not.toContain('beta.md');
  });

  it('list_directory: lists pending files in the requested directory', () => {
    const store = makePendingStore([
      { filePath: `${ROOT}/src/alpha.ts`, originalContent: null, newContent: 'x' },
      { filePath: `${ROOT}/src/nested/beta.ts`, originalContent: null, newContent: 'y' },
    ]);
    const overlay = computePendingOverlay(makeToolUse('list_directory', { path: 'src' }), store);
    expect(overlay).toContain('alpha.ts');
    // Nested file should not appear — list_directory is non-recursive
    expect(overlay).not.toContain('beta.ts');
  });

  it('returns empty for tools not in the overlay set', () => {
    const store = makePendingStore([{ filePath: `${ROOT}/src/foo.ts`, originalContent: null, newContent: 'x' }]);
    const overlay = computePendingOverlay(makeToolUse('run_command', { command: 'ls' }), store);
    expect(overlay).toBe('');
  });
});

describe('REVIEW_OVERLAY_TOOLS', () => {
  it('contains grep, search_files, list_directory', () => {
    expect(REVIEW_OVERLAY_TOOLS.has('grep')).toBe(true);
    expect(REVIEW_OVERLAY_TOOLS.has('search_files')).toBe(true);
    expect(REVIEW_OVERLAY_TOOLS.has('list_directory')).toBe(true);
  });
});
