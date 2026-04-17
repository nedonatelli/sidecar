import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { window, workspace } from 'vscode';

vi.mock('child_process', () => ({ exec: vi.fn() }));
import { exec } from 'child_process';

import { summarizePR } from './prSummary.js';

type ExecCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

function mockClient(overrides: { complete?: () => Promise<string>; throwOnComplete?: boolean } = {}) {
  return {
    updateSystemPrompt: vi.fn(),
    complete: overrides.throwOnComplete
      ? vi.fn().mockRejectedValue(new Error('backend offline'))
      : vi.fn().mockImplementation(overrides.complete ?? (async () => '## PR Title\n\nSummary here.')),
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

describe('summarizePR', () => {
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
      await summarizePR(client as never);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No workspace'));
      expect(client.complete).not.toHaveBeenCalled();

      (workspace as Record<string, unknown>).workspaceFolders = original;
    });

    it('shows "no changes" when both HEAD and staged diffs are empty', async () => {
      installExec({ 'git diff HEAD': '', 'git diff --cached': '' });
      const infoSpy = vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);

      const client = mockClient();
      await summarizePR(client as never);

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('No changes'));
      expect(client.complete).not.toHaveBeenCalled();
    });

    it('surfaces an error when git diff fails', async () => {
      installExec({ 'git diff HEAD': '' }, new Set(['git diff HEAD']));
      const errSpy = vi.spyOn(window, 'showErrorMessage').mockResolvedValue(undefined as never);

      const client = mockClient();
      await summarizePR(client as never);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to get git diff'));
    });
  });

  describe('happy path', () => {
    it('uses HEAD diff when present and skips the staged fallback', async () => {
      installExec({ 'git diff HEAD': 'diff --git a/foo b/foo\n+committed change\n' });
      const client = mockClient();
      await summarizePR(client as never);

      expect(client.complete).toHaveBeenCalledOnce();
      const promptArg = client.complete.mock.calls[0][0] as Array<{ content: string }>;
      expect(promptArg[0].content).toContain('+committed change');
      expect(promptArg[0].content).toContain('suggested PR title');
    });

    it('falls back to staged diff when HEAD diff is empty', async () => {
      installExec({
        'git diff HEAD': '',
        'git diff --cached': 'diff --git a/baz b/baz\n+staged only\n',
      });
      const client = mockClient();
      await summarizePR(client as never);

      const promptArg = client.complete.mock.calls[0][0] as Array<{ content: string }>;
      expect(promptArg[0].content).toContain('+staged only');
    });

    it('opens the generated summary as a markdown document', async () => {
      installExec({ 'git diff HEAD': 'diff content\n' });
      const openSpy = vi.spyOn(workspace, 'openTextDocument').mockResolvedValue({ id: 'doc-1' } as never);
      const showSpy = vi.spyOn(window, 'showTextDocument').mockResolvedValue(undefined as never);

      const client = mockClient({ complete: async () => 'PR summary body' });
      await summarizePR(client as never);

      expect(openSpy).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'PR summary body', language: 'markdown' }),
      );
      expect(showSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'doc-1' }),
        expect.objectContaining({ preview: true }),
      );
    });

    it('truncates very large diffs before sending to the model', async () => {
      const hugeDiff = 'x'.repeat(35_000);
      installExec({ 'git diff HEAD': hugeDiff });

      const client = mockClient();
      await summarizePR(client as never);

      const promptArg = client.complete.mock.calls[0][0] as Array<{ content: string }>;
      expect(promptArg[0].content).toContain('... (diff truncated)');
    });

    it('shows an error when the client throws during complete()', async () => {
      installExec({ 'git diff HEAD': 'diff content\n' });
      const errSpy = vi.spyOn(window, 'showErrorMessage').mockResolvedValue(undefined as never);

      const client = mockClient({ throwOnComplete: true });
      await summarizePR(client as never);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('PR summary failed'));
    });
  });
});
