import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window, commands } from 'vscode';
import { runConflictResolution, createDefaultConflictReviewUi, type ConflictReviewUi } from './conflictReview.js';
import type { ConflictFile } from './conflictDetector.js';

// Mock resolveConflicts — it calls the LLM and can't run in unit tests
vi.mock('./conflictResolver.js', () => ({
  resolveConflicts: vi.fn(),
}));

// Mock fs — avoid real disk operations
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    mkdirSync: vi.fn(),
    promises: {
      ...actual.promises,
      writeFile: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { resolveConflicts } from './conflictResolver.js';
import * as fsModule from 'fs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUi(overrides: Partial<ConflictReviewUi> = {}): ConflictReviewUi {
  return {
    showInfo: vi.fn(),
    showError: vi.fn(),
    showProgress: vi.fn().mockImplementation(async (_title, task) => {
      const ac = new AbortController();
      await task(() => {}, ac.signal);
    }),
    showFilePick: vi.fn().mockResolvedValue(undefined),
    openDiff: vi.fn().mockResolvedValue(undefined),
    showConfirm: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeFile(relativePath: string): ConflictFile {
  return {
    fsPath: `/workspace/${relativePath}`,
    relativePath,
    blocks: [
      {
        index: 0,
        ours: 'a',
        base: null,
        theirs: 'b',
        oursLabel: 'HEAD',
        theirsLabel: 'main',
        startOffset: 0,
        endOffset: 10,
      },
    ],
    originalContent: '<<<<<<< HEAD\na\n=======\nb\n>>>>>>> main',
  };
}

function makeShadow() {
  return {
    path: '/tmp/shadow-test',
    create: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
}

const mockClient = {} as never;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runConflictResolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveConflicts).mockResolvedValue({
      resolvedContent: 'resolved content',
      resolvedBlocks: 1,
      totalBlocks: 1,
    });
  });

  it('returns empty outcome when no conflicted files found', async () => {
    const ui = makeUi();
    const outcome = await runConflictResolution({
      workspaceRoot: '/workspace',
      client: mockClient,
      ui,
      findFiles: async () => [],
    });
    expect(outcome).toEqual({ accepted: [], rejected: [], failed: [] });
    expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('No merge conflicts'));
  });

  it('returns empty outcome and shows error when findFiles throws', async () => {
    const ui = makeUi();
    const outcome = await runConflictResolution({
      workspaceRoot: '/workspace',
      client: mockClient,
      ui,
      findFiles: async () => {
        throw new Error('scan failed');
      },
    });
    expect(outcome).toEqual({ accepted: [], rejected: [], failed: [] });
    expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining('scan failed'));
  });

  it('accepts a file when user chooses Accept', async () => {
    const file = makeFile('src/foo.ts');
    const shadow = makeShadow();
    const ui = makeUi({ showConfirm: vi.fn().mockResolvedValue('Accept') });

    const outcome = await runConflictResolution({
      workspaceRoot: '/workspace',
      client: mockClient,
      ui,
      findFiles: async () => [file],
      createShadow: () => shadow as never,
    });

    expect(outcome.accepted).toContain('src/foo.ts');
    expect(outcome.rejected).toHaveLength(0);
    expect(outcome.failed).toHaveLength(0);
    expect(ui.showInfo).toHaveBeenCalledWith(expect.stringContaining('Resolved 1 file'));
  });

  it('rejects a file when user chooses Skip', async () => {
    const file = makeFile('src/bar.ts');
    const shadow = makeShadow();
    const ui = makeUi({ showConfirm: vi.fn().mockResolvedValue('Skip') });

    const outcome = await runConflictResolution({
      workspaceRoot: '/workspace',
      client: mockClient,
      ui,
      findFiles: async () => [file],
      createShadow: () => shadow as never,
    });

    expect(outcome.rejected).toContain('src/bar.ts');
    expect(outcome.accepted).toHaveLength(0);
  });

  it('records failure when writeFile throws on accept', async () => {
    const file = makeFile('src/broken.ts');
    const shadow = makeShadow();
    const ui = makeUi({ showConfirm: vi.fn().mockResolvedValue('Accept') });
    vi.mocked(fsModule.promises.writeFile)
      .mockResolvedValueOnce(undefined) // shadow write
      .mockRejectedValueOnce(new Error('permission denied')); // main write

    const outcome = await runConflictResolution({
      workspaceRoot: '/workspace',
      client: mockClient,
      ui,
      findFiles: async () => [file],
      createShadow: () => shadow as never,
    });

    expect(outcome.failed).toHaveLength(1);
    expect(outcome.failed[0].error).toContain('permission denied');
    expect(ui.showError).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
  });

  it('disposes shadow workspace even when an error occurs mid-review', async () => {
    const file = makeFile('src/thing.ts');
    const shadow = makeShadow();
    // openDiff throws to simulate a mid-review crash
    const ui = makeUi({ openDiff: vi.fn().mockRejectedValue(new Error('diff failed')) });

    await expect(
      runConflictResolution({
        workspaceRoot: '/workspace',
        client: mockClient,
        ui,
        findFiles: async () => [file],
        createShadow: () => shadow as never,
      }),
    ).rejects.toThrow('diff failed');

    expect(shadow.dispose).toHaveBeenCalled();
  });

  it('returns early when progress signal is aborted before any file is resolved', async () => {
    const file = makeFile('src/aborted.ts');
    const ui = makeUi({
      showProgress: vi.fn().mockImplementation(async (_title, task) => {
        const ac = new AbortController();
        ac.abort(); // abort immediately
        await task(() => {}, ac.signal);
      }),
    });

    const outcome = await runConflictResolution({
      workspaceRoot: '/workspace',
      client: mockClient,
      ui,
      findFiles: async () => [file],
    });

    expect(outcome).toEqual({ accepted: [], rejected: [], failed: [] });
  });

  it('calls resolveConflicts for each conflicted file', async () => {
    const files = [makeFile('a.ts'), makeFile('b.ts')];
    const shadow = makeShadow();
    const ui = makeUi({ showConfirm: vi.fn().mockResolvedValue('Skip') });

    await runConflictResolution({
      workspaceRoot: '/workspace',
      client: mockClient,
      ui,
      findFiles: async () => files,
      createShadow: () => shadow as never,
    });

    expect(resolveConflicts).toHaveBeenCalledTimes(2);
  });

  it('does not show info when all files are rejected', async () => {
    const file = makeFile('src/only.ts');
    const shadow = makeShadow();
    const ui = makeUi({ showConfirm: vi.fn().mockResolvedValue('Skip') });

    await runConflictResolution({
      workspaceRoot: '/workspace',
      client: mockClient,
      ui,
      findFiles: async () => [file],
      createShadow: () => shadow as never,
    });

    expect(ui.showInfo).not.toHaveBeenCalledWith(expect.stringContaining('Resolved'));
  });

  it('opens a diff for each resolved file', async () => {
    const files = [makeFile('x.ts'), makeFile('y.ts')];
    const shadow = makeShadow();
    const ui = makeUi({ showConfirm: vi.fn().mockResolvedValue('Skip') });

    await runConflictResolution({
      workspaceRoot: '/workspace',
      client: mockClient,
      ui,
      findFiles: async () => files,
      createShadow: () => shadow as never,
    });

    expect(ui.openDiff).toHaveBeenCalledTimes(2);
  });
});

describe('createDefaultConflictReviewUi', () => {
  it('returns a ui with all required methods', () => {
    const ui = createDefaultConflictReviewUi();
    expect(typeof ui.showInfo).toBe('function');
    expect(typeof ui.showError).toBe('function');
    expect(typeof ui.showProgress).toBe('function');
    expect(typeof ui.showFilePick).toBe('function');
    expect(typeof ui.openDiff).toBe('function');
    expect(typeof ui.showConfirm).toBe('function');
  });

  it('showInfo calls vscode.window.showInformationMessage', () => {
    const spy = vi.spyOn(window, 'showInformationMessage').mockReturnValue(undefined as never);
    const ui = createDefaultConflictReviewUi();
    ui.showInfo('hello');
    expect(spy).toHaveBeenCalledWith('hello');
    vi.restoreAllMocks();
  });

  it('showError calls vscode.window.showErrorMessage', () => {
    const spy = vi.spyOn(window, 'showErrorMessage').mockReturnValue(undefined as never);
    const ui = createDefaultConflictReviewUi();
    ui.showError('oops');
    expect(spy).toHaveBeenCalledWith('oops');
    vi.restoreAllMocks();
  });

  it('showFilePick delegates to window.showQuickPick', async () => {
    const spy = vi.spyOn(window, 'showQuickPick').mockResolvedValue(undefined as never);
    const items = [{ label: 'src/foo.ts', relativePath: 'src/foo.ts' }];
    await createDefaultConflictReviewUi().showFilePick(items, 'pick a file');
    expect(spy).toHaveBeenCalledWith(items, { placeHolder: 'pick a file' });
    vi.restoreAllMocks();
  });

  it('openDiff executes vscode.diff command', async () => {
    const spy = vi.spyOn(commands, 'executeCommand').mockResolvedValue(undefined);
    const { Uri } = await import('vscode');
    const before = Uri.file('/workspace/src/a.ts');
    const after = Uri.file('/tmp/a.ts');
    await createDefaultConflictReviewUi().openDiff(before, after, 'Conflict diff');
    expect(spy).toHaveBeenCalledWith('vscode.diff', before, after, 'Conflict diff');
    vi.restoreAllMocks();
  });

  it('showConfirm delegates to window.showInformationMessage', async () => {
    const spy = vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Accept' as never);
    const result = await createDefaultConflictReviewUi().showConfirm('Apply changes?', ['Accept', 'Skip']);
    expect(spy).toHaveBeenCalledWith('Apply changes?', 'Accept', 'Skip');
    expect(result).toBe('Accept');
    vi.restoreAllMocks();
  });

  it('showProgress calls vscode.window.withProgress', async () => {
    const spy = vi.spyOn(window, 'withProgress').mockImplementation(async (_opts, task) => {
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      };
      return task({ report: vi.fn() } as never, token as never);
    });
    const taskFn = vi.fn().mockResolvedValue('done');
    await createDefaultConflictReviewUi().showProgress('Resolving…', taskFn);
    expect(spy).toHaveBeenCalled();
    expect(taskFn).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
