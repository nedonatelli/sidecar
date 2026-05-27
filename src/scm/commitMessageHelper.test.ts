import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { window, extensions } from 'vscode';

import { suggestCommitMessage } from './commitMessageHelper.js';

function makeRepo(diffResult = 'diff --git a/src/index.ts b/src/index.ts\n+++ updated line') {
  return {
    inputBox: { value: '' },
    diff: vi.fn().mockResolvedValue(diffResult),
  };
}

async function* makeStream(chunks: string[]) {
  for (const text of chunks) {
    yield { type: 'text', text };
  }
}

function makeClient(chunks = ['feat(scope): add feature']) {
  return {
    streamChat: vi.fn().mockImplementation(() => makeStream(chunks)),
  };
}

describe('suggestCommitMessage', () => {
  beforeEach(() => {
    vi.spyOn(window, 'showErrorMessage').mockResolvedValue(undefined as never);
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);
    vi.spyOn(window, 'withProgress').mockImplementation((async (
      _opts: unknown,
      task: (p: unknown, t: unknown) => Promise<unknown>,
    ) => {
      const token = { onCancellationRequested: vi.fn() };
      return task({}, token);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows error and returns when the git extension is not installed', async () => {
    vi.mocked(extensions.getExtension).mockReturnValue(undefined);

    await suggestCommitMessage(() => makeClient() as never);

    expect(window.showErrorMessage).toHaveBeenCalledWith('SideCar: git extension not found.');
    expect(window.withProgress).not.toHaveBeenCalled();
  });

  it('shows error and returns when no git repository is open', async () => {
    vi.mocked(extensions.getExtension).mockReturnValue({
      exports: { getAPI: () => ({ repositories: [] }) },
    } as never);

    await suggestCommitMessage(() => makeClient() as never);

    expect(window.showErrorMessage).toHaveBeenCalledWith('SideCar: no git repository found.');
    expect(window.withProgress).not.toHaveBeenCalled();
  });

  it('shows info message and returns when there are no staged changes', async () => {
    const repo = makeRepo('   ');
    vi.mocked(extensions.getExtension).mockReturnValue({
      exports: { getAPI: () => ({ repositories: [repo] }) },
    } as never);

    await suggestCommitMessage(() => makeClient() as never);

    expect(window.showInformationMessage).toHaveBeenCalledWith('SideCar: No staged changes.');
    expect(window.withProgress).not.toHaveBeenCalled();
  });

  it('streams from the client and sets inputBox.value to the trimmed result', async () => {
    const repo = makeRepo();
    vi.mocked(extensions.getExtension).mockReturnValue({
      exports: { getAPI: () => ({ repositories: [repo] }) },
    } as never);
    const client = makeClient(['feat(api): ', 'add retry logic', '  ']);

    await suggestCommitMessage(() => client as never);

    expect(window.withProgress).toHaveBeenCalledOnce();
    expect(client.streamChat).toHaveBeenCalledOnce();
    expect(repo.inputBox.value).toBe('feat(api): add retry logic');
  });

  it('truncates the diff to 400 chars in the prompt', async () => {
    // Distinguishable head vs tail so containment checks are unambiguous
    const diff = 'A'.repeat(400) + 'B'.repeat(200);
    const repo = makeRepo(diff);
    vi.mocked(extensions.getExtension).mockReturnValue({
      exports: { getAPI: () => ({ repositories: [repo] }) },
    } as never);
    const client = makeClient(['msg']);

    await suggestCommitMessage(() => client as never);

    const [[messages]] = vi.mocked(client.streamChat).mock.calls;
    const promptText = (messages[0].content[0] as { text: string }).text;
    expect(promptText).toContain('A'.repeat(400));
    expect(promptText).not.toContain('B');
  });

  it('ignores non-text stream events', async () => {
    const repo = makeRepo();
    vi.mocked(extensions.getExtension).mockReturnValue({
      exports: { getAPI: () => ({ repositories: [repo] }) },
    } as never);
    const client = {
      streamChat: vi.fn().mockImplementation(async function* () {
        yield { type: 'thinking', thinking: 'hmm' };
        yield { type: 'text', text: 'fix: correct typo' };
        yield { type: 'tool_use', name: 'noop' };
      }),
    };

    await suggestCommitMessage(() => client as never);

    expect(repo.inputBox.value).toBe('fix: correct typo');
  });

  it('passes the staged diff to repo.diff(true)', async () => {
    const repo = makeRepo();
    vi.mocked(extensions.getExtension).mockReturnValue({
      exports: { getAPI: () => ({ repositories: [repo] }) },
    } as never);

    await suggestCommitMessage(() => makeClient() as never);

    expect(repo.diff).toHaveBeenCalledWith(true);
  });
});
