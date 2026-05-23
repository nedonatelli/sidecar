import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleGenerateCommit, handleRegenSection } from './generateHandlers.js';

// ---------------------------------------------------------------------------
// GitCLI mock — hoisted so the factory can close over the shared spies
// ---------------------------------------------------------------------------

const gitMockStatus = vi.fn();
const gitMockDiff = vi.fn();
const gitMockStage = vi.fn();
const gitMockCommit = vi.fn();

vi.mock('../../github/git.js', () => ({
  GitCLI: class {
    status(...args: unknown[]) {
      return gitMockStatus(...args);
    }
    diff(...args: unknown[]) {
      return gitMockDiff(...args);
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
      client: {
        updateConnection: vi.fn(),
        updateModel: vi.fn(),
        complete: vi.fn().mockResolvedValue('feat: add feature\n\n- detail one'),
      },
    };
  }

  beforeEach(() => {
    gitMockStatus.mockReset();
    gitMockDiff.mockReset();
    gitMockStage.mockReset();
    gitMockCommit.mockReset();
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

  it('posts "No changes to commit" when the working tree is clean', async () => {
    gitMockStatus.mockResolvedValue('Working tree clean.');

    const state = makeState();
    await handleGenerateCommit(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: 'No changes to commit.' }),
    );
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'done' }));
  });

  it('posts "No diff found" when status is dirty but diff is empty', async () => {
    gitMockStatus.mockResolvedValue('M  src/app.ts');
    gitMockDiff.mockResolvedValue({ diff: 'No diff output.' });

    const state = makeState();
    await handleGenerateCommit(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'assistantMessage', content: expect.stringContaining('No diff found') }),
    );
  });

  it('commits and posts the commit result on the happy path', async () => {
    gitMockStatus.mockResolvedValue('M  src/app.ts');
    gitMockDiff.mockResolvedValue({ diff: 'diff --git a/src/app.ts b/src/app.ts\n+added line' });
    gitMockStage.mockResolvedValue(undefined);
    gitMockCommit.mockResolvedValue('[main abc1234] feat: add feature');

    const state = makeState();
    await handleGenerateCommit(state as never);

    const assistantCalls = state.postMessage.mock.calls.filter(
      (c) => (c[0] as { command: string }).command === 'assistantMessage',
    );
    const contents = assistantCalls.map((c) => (c[0] as { content: string }).content);
    expect(contents.some((c) => c.includes('[main abc1234]'))).toBe(true);
    expect(state.postMessage).toHaveBeenCalledWith(expect.objectContaining({ command: 'done' }));
  });

  it('strips markdown fences from the model-generated commit message', async () => {
    gitMockStatus.mockResolvedValue('M  src/app.ts');
    gitMockDiff.mockResolvedValue({ diff: 'diff --git a/src/app.ts b/src/app.ts\n+line' });
    gitMockStage.mockResolvedValue(undefined);
    gitMockCommit.mockResolvedValue('[main xyz] feat: clean');
    (makeState().client.complete as ReturnType<typeof vi.fn>) = vi.fn();

    // Return a message wrapped in a markdown code block as models sometimes do
    const state = makeState();
    state.client.complete = vi.fn().mockResolvedValue('```\nfeat: clean commit\n```');
    await handleGenerateCommit(state as never);

    // The commit call should receive the stripped text
    expect(gitMockCommit).toHaveBeenCalledWith('feat: clean commit');
  });

  it('posts an error when git.status() throws', async () => {
    gitMockStatus.mockRejectedValue(new Error('git not found'));

    const state = makeState();
    await handleGenerateCommit(state as never);

    expect(state.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'error', content: expect.stringContaining('git not found') }),
    );
  });

  it('posts an error when git.commit() throws', async () => {
    gitMockStatus.mockResolvedValue('M  src/app.ts');
    gitMockDiff.mockResolvedValue({ diff: 'diff --git a/src/app.ts b/src/app.ts\n+line' });
    gitMockStage.mockResolvedValue(undefined);
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
