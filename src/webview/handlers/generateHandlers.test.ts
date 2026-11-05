import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGenerateCommit, handleRegenSection } from './generateHandlers.js';

// ---------------------------------------------------------------------------
// GitCLI mock — hoisted so the factory can close over the shared spies
// ---------------------------------------------------------------------------

const gitMockChanged = vi.fn();
const gitMockUntracked = vi.fn();
const gitMockDiffPaths = vi.fn();
const gitMockStage = vi.fn();
const gitMockCommit = vi.fn();

vi.mock('../../github/git.js', () => ({
  GitCLI: class {
    changedPaths(...args: unknown[]) {
      return gitMockChanged(...args);
    }
    listUntracked(...args: unknown[]) {
      return gitMockUntracked(...args);
    }
    diffPaths(...args: unknown[]) {
      return gitMockDiffPaths(...args);
    }
    stage(...args: unknown[]) {
      return gitMockStage(...args);
    }
    commit(...args: unknown[]) {
      return gitMockCommit(...args);
    }
  },
}));

// ---------------------------------------------------------------------------
// handleGenerateCommit
// ---------------------------------------------------------------------------

describe('handleGenerateCommit', () => {
  function makeState() {
    return {
      postMessage: vi.fn(),
      requestConfirm: vi.fn().mockResolvedValue('Commit'),
      client: {
        updateConnection: vi.fn(),
        updateModel: vi.fn(),
        complete: vi.fn().mockResolvedValue('feat: add feature\n\n- detail one'),
      },
    };
  }
  const contents = (state: ReturnType<typeof makeState>) =>
    state.postMessage.mock.calls
      .map((c) => c[0] as { command: string; content?: string })
      .filter((m) => m.command === 'assistantMessage')
      .map((m) => m.content ?? '');

  beforeEach(() => {
    for (const m of [gitMockChanged, gitMockUntracked, gitMockDiffPaths, gitMockStage, gitMockCommit]) m.mockReset();
    gitMockChanged.mockResolvedValue({ staged: [], unstaged: ['src/app.ts'] });
    gitMockUntracked.mockResolvedValue([]);
    gitMockDiffPaths.mockResolvedValue('diff --git a/src/app.ts b/src/app.ts\n+added line');
    gitMockCommit.mockResolvedValue('[main abc1234] feat: add feature');
  });

  it('posts an error when no workspace folder is open', async () => {
    const { workspace } = await import('vscode');
    const origFolders = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;

    const state = makeState();
    await handleGenerateCommit(state as never);
    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('No workspace') }),
    );

    (workspace as Record<string, unknown>).workspaceFolders = origFolders;
  });

  it('posts "No changes to commit" when nothing changed', async () => {
    gitMockChanged.mockResolvedValue({ staged: [], unstaged: [] });

    const state = makeState();
    await handleGenerateCommit(state as never);

    expect(contents(state)).toContain('No changes to commit.');
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'done' }));
    expect(state.client.complete).not.toHaveBeenCalled();
  });

  it('asks first, then stages the listed files by name and commits', async () => {
    gitMockUntracked.mockResolvedValue(['src/new.ts']);

    const state = makeState();
    await handleGenerateCommit(state as never);

    const [title, actions, opts] = state.requestConfirm.mock.calls[0];
    expect(title).toBe('Commit 2 files?');
    expect(actions).toEqual(['Commit']);
    expect(opts).toMatchObject({ modal: true });
    expect(opts.detail).toContain('feat: add feature');
    expect(opts.detail).toContain('src/app.ts\nsrc/new.ts');
    expect(gitMockStage).toHaveBeenCalledWith(['src/app.ts', 'src/new.ts']);
    expect(contents(state).some((c) => c.includes('[main abc1234]'))).toBe(true);
  });

  it('stages and commits nothing when the user dismisses the prompt', async () => {
    const state = makeState();
    state.requestConfirm.mockResolvedValue(undefined); // Esc or close
    await handleGenerateCommit(state as never);

    expect(gitMockStage).not.toHaveBeenCalled();
    expect(gitMockCommit).not.toHaveBeenCalled();
    expect(contents(state).some((c) => c.includes('Commit cancelled'))).toBe(true);
  });

  it('leaves credential files out of the commit and out of the prompt, and says so', async () => {
    gitMockChanged.mockResolvedValue({ staged: [], unstaged: ['src/app.ts', 'config/secrets.yml'] });
    gitMockUntracked.mockResolvedValue(['.env']);

    const state = makeState();
    await handleGenerateCommit(state as never);

    expect(gitMockStage).toHaveBeenCalledWith(['src/app.ts']);
    expect(gitMockDiffPaths).toHaveBeenCalledWith(['src/app.ts'], false);
    const prompt = state.client.complete.mock.calls[0][0][0].content as string;
    expect(prompt).not.toContain('.env');
    const note = contents(state).at(-1) ?? '';
    expect(note).toContain('config/secrets.yml');
    expect(note).toContain('.env');
  });

  it('commits only what is already staged, without staging more', async () => {
    gitMockChanged.mockResolvedValue({ staged: ['src/a.ts'], unstaged: ['src/b.ts'] });
    gitMockUntracked.mockResolvedValue(['src/c.ts']);

    const state = makeState();
    await handleGenerateCommit(state as never);

    expect(state.requestConfirm.mock.calls[0][0]).toBe('Commit 1 file (already staged)?');
    expect(gitMockDiffPaths).toHaveBeenCalledWith(['src/a.ts'], true);
    expect(gitMockStage).not.toHaveBeenCalled();
    expect(gitMockCommit).toHaveBeenCalled();
  });

  it('strips markdown fences from the model-generated commit message', async () => {
    const state = makeState();
    state.client.complete = vi.fn().mockResolvedValue('```\nfeat: clean commit\n```');
    await handleGenerateCommit(state as never);

    expect(gitMockCommit).toHaveBeenCalledWith('feat: clean commit');
  });

  it('posts an error when git fails', async () => {
    gitMockChanged.mockRejectedValue(new Error('git not found'));

    const state = makeState();
    await handleGenerateCommit(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('git not found') }),
    );
  });

  it('posts an error when git.commit() throws', async () => {
    gitMockCommit.mockRejectedValue(new Error('nothing to commit'));

    const state = makeState();
    await handleGenerateCommit(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('nothing to commit') }),
    );
  });
});

// ---------------------------------------------------------------------------
// handleRegenSection
// ---------------------------------------------------------------------------

describe('handleRegenSection', () => {
  function makeState(completeResult = 'rewritten text') {
    return {
      postMessage: vi.fn(),
      client: { complete: vi.fn().mockResolvedValue(completeResult) },
    };
  }

  it('is a no-op when selectedText is empty or whitespace-only', async () => {
    const state = makeState();
    await handleRegenSection(state as never, '   ', '', 0);
    expect(state.client.complete).not.toHaveBeenCalled();
    expect(state.postMessage).not.toHaveBeenCalled();
  });

  it('posts regenSectionResult with the trimmed model output', async () => {
    const state = makeState('  trimmed output  ');
    await handleRegenSection(state as never, 'original section', '', 2);

    expect(state.postMessage).toHaveBeenCalledWith({
      command: 'regenSectionResult',
      msgIndex: 2,
      originalText: 'original section',
      newText: 'trimmed output',
    });
  });

  it('uses "more clearly and concisely" prompt when no instruction is given', async () => {
    const state = makeState('rewrite');
    await handleRegenSection(state as never, 'some text', '', 0);

    const prompt = (state.client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0][0].content as string;
    expect(prompt).toContain('more clearly and concisely');
    expect(prompt).not.toContain('Instruction:');
  });

  it('uses "Instruction: <text>" prompt when an instruction is given', async () => {
    const state = makeState('rewrite');
    await handleRegenSection(state as never, 'some text', 'make it shorter', 0);

    const prompt = (state.client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0][0].content as string;
    expect(prompt).toContain('Instruction: make it shorter');
    expect(prompt).not.toContain('more clearly and concisely');
  });

  it('includes the selectedText verbatim in the prompt', async () => {
    const state = makeState('ok');
    await handleRegenSection(state as never, 'The quick brown fox', 'simplify', 1);

    const prompt = (state.client.complete as ReturnType<typeof vi.fn>).mock.calls[0][0][0].content as string;
    expect(prompt).toContain('The quick brown fox');
  });

  it('passes the correct msgIndex back in the result', async () => {
    const state = makeState('new text');
    await handleRegenSection(state as never, 'old', '', 7);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'regenSectionResult', msgIndex: 7 }),
    );
  });

  it('passes originalText back unchanged in the result', async () => {
    const state = makeState('replacement');
    await handleRegenSection(state as never, 'exact original content', '', 0);

    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ originalText: 'exact original content' }));
  });

  it('posts an error when client.complete throws', async () => {
    const state = {
      postMessage: vi.fn(),
      client: { complete: vi.fn().mockRejectedValue(new Error('model offline')) },
    };
    await handleRegenSection(state as never, 'some section', '', 0);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('model offline') }),
    );
  });

  it('requests a 1024-token completion', async () => {
    const state = makeState('ok');
    await handleRegenSection(state as never, 'text', '', 0);

    expect(state.client.complete).toHaveBeenCalledWith(expect.any(Array), 1024);
  });
});
