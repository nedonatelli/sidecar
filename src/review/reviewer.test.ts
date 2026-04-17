import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { window, workspace } from 'vscode';

vi.mock('child_process', () => ({ exec: vi.fn() }));
import { exec } from 'child_process';

import { reviewCurrentChanges } from './reviewer.js';

type ExecCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

function mockClient(overrides: { complete?: () => Promise<string>; throwOnComplete?: boolean } = {}) {
  return {
    updateSystemPrompt: vi.fn(),
    complete: overrides.throwOnComplete
      ? vi.fn().mockRejectedValue(new Error('backend offline'))
      : vi.fn().mockImplementation(overrides.complete ?? (async () => '## Review\n- No issues')),
  };
}

function installExec(outputs: Record<string, string>, failOnThese: Set<string> = new Set()): void {
  (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation((cmd: string, _opts: unknown, cb?: ExecCallback) => {
    const callback = typeof _opts === 'function' ? (_opts as ExecCallback) : cb;
    for (const key of Object.keys(outputs)) {
      if (cmd.startsWith(key)) {
        if (failOnThese.has(key)) {
          callback?.(new Error(`simulated failure for ${key}`), { stdout: '', stderr: 'fatal' });
          return;
        }
        callback?.(null, { stdout: outputs[key], stderr: '' });
        return;
      }
    }
    callback?.(new Error(`unexpected exec call: ${cmd}`), { stdout: '', stderr: '' });
  });
}

describe('reviewCurrentChanges', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(exec as unknown as ReturnType<typeof vi.fn>).mockReset();
    vi.spyOn(window, 'withProgress').mockImplementation((async (
      _opts: unknown,
      task: (progress: unknown) => Promise<unknown>,
    ) => task({})) as never);
    vi.spyOn(workspace, 'openTextDocument').mockResolvedValue({} as never);
    vi.spyOn(window, 'showTextDocument').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('guard rails', () => {
    it('shows a warning when no workspace folder is open', async () => {
      const warnSpy = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);
      const original = workspace.workspaceFolders;
      (workspace as Record<string, unknown>).workspaceFolders = undefined;

      const client = mockClient();
      await reviewCurrentChanges(client as never);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No workspace'));
      expect(client.complete).not.toHaveBeenCalled();

      (workspace as Record<string, unknown>).workspaceFolders = original;
    });

    it('shows "no changes" when both HEAD and staged diffs are empty', async () => {
      installExec({ 'git diff HEAD': '', 'git diff --cached': '' });
      const infoSpy = vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);

      const client = mockClient();
      await reviewCurrentChanges(client as never);

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('No changes to review'));
      expect(client.complete).not.toHaveBeenCalled();
    });

    it('surfaces an error when git diff fails', async () => {
      installExec({ 'git diff HEAD': '' }, new Set(['git diff HEAD']));
      const errSpy = vi.spyOn(window, 'showErrorMessage').mockResolvedValue(undefined as never);

      const client = mockClient();
      await reviewCurrentChanges(client as never);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to get git diff'));
    });
  });

  describe('happy path', () => {
    it('uses HEAD diff when present and sends the review prompt', async () => {
      installExec({ 'git diff HEAD': 'diff --git a/foo b/foo\n+new line\n' });
      const client = mockClient();
      await reviewCurrentChanges(client as never);

      expect(client.complete).toHaveBeenCalledOnce();
      const promptArg = client.complete.mock.calls[0][0] as Array<{ content: string }>;
      expect(promptArg[0].content).toContain('+new line');
      // Sanity-check the review prompt's defining phrase — this is what
      // tells the model to look for bugs/security/perf rather than
      // generating a commit message or PR summary.
      expect(promptArg[0].content).toContain('bugs, security issues');
    });

    it('sets a reviewer-specific system prompt', async () => {
      installExec({ 'git diff HEAD': 'diff content\n' });
      const client = mockClient();
      await reviewCurrentChanges(client as never);

      expect(client.updateSystemPrompt).toHaveBeenCalledWith(expect.stringContaining('code reviewer'));
    });

    it('falls back to staged diff when HEAD diff is empty', async () => {
      installExec({
        'git diff HEAD': '',
        'git diff --cached': 'diff --git a/y b/y\n+staged\n',
      });
      const client = mockClient();
      await reviewCurrentChanges(client as never);

      const promptArg = client.complete.mock.calls[0][0] as Array<{ content: string }>;
      expect(promptArg[0].content).toContain('+staged');
    });

    it('opens the generated review as a markdown document in preview mode', async () => {
      installExec({ 'git diff HEAD': 'diff content\n' });
      const openSpy = vi.spyOn(workspace, 'openTextDocument').mockResolvedValue({ id: 'doc-review' } as never);
      const showSpy = vi.spyOn(window, 'showTextDocument').mockResolvedValue(undefined as never);

      const client = mockClient({ complete: async () => 'Review body' });
      await reviewCurrentChanges(client as never);

      expect(openSpy).toHaveBeenCalledWith(expect.objectContaining({ content: 'Review body', language: 'markdown' }));
      expect(showSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'doc-review' }),
        expect.objectContaining({ preview: true }),
      );
    });

    it('truncates very large diffs before sending to the model', async () => {
      const hugeDiff = 'x'.repeat(35_000);
      installExec({ 'git diff HEAD': hugeDiff });

      const client = mockClient();
      await reviewCurrentChanges(client as never);

      const promptArg = client.complete.mock.calls[0][0] as Array<{ content: string }>;
      expect(promptArg[0].content).toContain('... (diff truncated)');
    });

    it('shows an error when the client throws during complete()', async () => {
      installExec({ 'git diff HEAD': 'diff content\n' });
      const errSpy = vi.spyOn(window, 'showErrorMessage').mockResolvedValue(undefined as never);

      const client = mockClient({ throwOnComplete: true });
      await reviewCurrentChanges(client as never);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Review failed'));
    });
  });
});
