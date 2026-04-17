import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { window, env } from 'vscode';

// Mock child_process.exec so git diff never actually runs. Each test
// configures the mock to drive the specific branch it exercises.
vi.mock('child_process', () => ({ exec: vi.fn() }));
import { exec } from 'child_process';

import { generateCommitMessage } from './commitMessage.js';

type ExecCallback = (err: Error | null, result: { stdout: string; stderr: string }) => void;

function mockClient(overrides: { complete?: () => Promise<string>; throwOnComplete?: boolean } = {}) {
  return {
    updateSystemPrompt: vi.fn(),
    complete: overrides.throwOnComplete
      ? vi.fn().mockRejectedValue(new Error('backend offline'))
      : vi.fn().mockImplementation(overrides.complete ?? (async () => 'feat: add new feature')),
  };
}

/**
 * Install an exec mock that serves stdout by command-string prefix.
 * `commitMessage.ts` calls either `git diff --cached` first, then
 * `git diff` if staged is empty. Tests pass a map keyed by each of
 * those command strings; unmatched commands throw a "command failed"
 * error so we notice regressions that add new git calls.
 */
function installExec(outputs: Record<string, string>, failOnThese: Set<string> = new Set()): void {
  (exec as unknown as ReturnType<typeof vi.fn>).mockImplementation((cmd: string, _opts: unknown, cb?: ExecCallback) => {
    const callback = typeof _opts === 'function' ? (_opts as ExecCallback) : cb;
    for (const key of Object.keys(outputs)) {
      if (cmd.startsWith(key)) {
        if (failOnThese.has(key)) {
          callback?.(new Error(`simulated failure for ${key}`), { stdout: '', stderr: 'fatal: not a git repo' });
          return;
        }
        callback?.(null, { stdout: outputs[key], stderr: '' });
        return;
      }
    }
    callback?.(new Error(`unexpected exec call: ${cmd}`), { stdout: '', stderr: '' });
  });
}

describe('generateCommitMessage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.mocked(exec as unknown as ReturnType<typeof vi.fn>).mockReset();
    // window.withProgress in the mock executes the task immediately; keep
    // that default but let each test spy on it.
    vi.spyOn(window, 'withProgress').mockImplementation((async (
      _opts: unknown,
      task: (progress: unknown) => Promise<unknown>,
    ) => task({})) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('guard rails', () => {
    it('shows a warning when no workspace folder is open', async () => {
      const warnSpy = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);
      const vsc = await import('vscode');
      const original = vsc.workspace.workspaceFolders;
      (vsc.workspace as Record<string, unknown>).workspaceFolders = undefined;

      const client = mockClient();
      await generateCommitMessage(client as never);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No workspace'));
      expect(client.complete).not.toHaveBeenCalled();

      (vsc.workspace as Record<string, unknown>).workspaceFolders = original;
    });

    it('shows "no changes" when both staged and unstaged diffs are empty', async () => {
      installExec({ 'git diff --cached': '', 'git diff': '' });
      const infoSpy = vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);

      const client = mockClient();
      await generateCommitMessage(client as never);

      expect(infoSpy).toHaveBeenCalledWith(expect.stringContaining('No changes to commit'));
      expect(client.complete).not.toHaveBeenCalled();
    });

    it('surfaces an error when git diff fails', async () => {
      installExec({ 'git diff --cached': '' }, new Set(['git diff --cached']));
      const errSpy = vi.spyOn(window, 'showErrorMessage').mockResolvedValue(undefined as never);

      const client = mockClient();
      await generateCommitMessage(client as never);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to get git diff'));
      expect(client.complete).not.toHaveBeenCalled();
    });
  });

  describe('happy path', () => {
    it('uses the staged diff when one is present and skips the unstaged probe', async () => {
      installExec({
        'git diff --cached': 'diff --git a/foo b/foo\n+staged line\n',
      });
      // When staged is non-empty, commitMessage.ts never calls `git diff`
      // for unstaged — verify by NOT adding a stub for that command.
      vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Copy to Clipboard' as never);
      vi.spyOn(env.clipboard, 'writeText').mockResolvedValue();

      const client = mockClient();
      await generateCommitMessage(client as never);

      expect(client.complete).toHaveBeenCalledOnce();
      // The diff that reaches the prompt should contain the staged content.
      const promptArg = client.complete.mock.calls[0][0] as Array<{ content: string }>;
      expect(promptArg[0].content).toContain('+staged line');
    });

    it('falls back to unstaged diff when staged is empty', async () => {
      installExec({
        'git diff --cached': '',
        'git diff': 'diff --git a/bar b/bar\n+unstaged line\n',
      });
      vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);

      const client = mockClient();
      await generateCommitMessage(client as never);

      expect(client.complete).toHaveBeenCalledOnce();
      const promptArg = client.complete.mock.calls[0][0] as Array<{ content: string }>;
      expect(promptArg[0].content).toContain('+unstaged line');
    });

    it('strips code fences from the generated message and appends Co-Authored-By', async () => {
      installExec({ 'git diff --cached': 'diff content\n' });
      vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Copy to Clipboard' as never);
      const clipSpy = vi.spyOn(env.clipboard, 'writeText').mockResolvedValue();

      const client = mockClient({
        complete: async () => '```\nfeat: cleaned up\n\n- bullet point\n```',
      });
      await generateCommitMessage(client as never);

      const written = clipSpy.mock.calls[0][0];
      expect(written).toMatch(/^feat: cleaned up\n\n- bullet point/);
      expect(written).not.toContain('```');
      expect(written).toContain('Co-Authored-By: SideCar');
    });

    it('copies verbatim on Copy to Clipboard action', async () => {
      installExec({ 'git diff --cached': 'diff content\n' });
      vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Copy to Clipboard' as never);
      const clipSpy = vi.spyOn(env.clipboard, 'writeText').mockResolvedValue();

      const client = mockClient({ complete: async () => 'fix: direct copy' });
      await generateCommitMessage(client as never);

      expect(clipSpy).toHaveBeenCalledOnce();
      expect(clipSpy.mock.calls[0][0]).toContain('fix: direct copy');
    });

    it('prompts for edit on Edit & Copy action and copies the edited value', async () => {
      installExec({ 'git diff --cached': 'diff content\n' });
      vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Edit & Copy' as never);
      vi.spyOn(window, 'showInputBox').mockResolvedValue('fix: edited by user' as never);
      const clipSpy = vi.spyOn(env.clipboard, 'writeText').mockResolvedValue();

      const client = mockClient({ complete: async () => 'fix: original suggestion' });
      await generateCommitMessage(client as never);

      expect(clipSpy).toHaveBeenCalledWith('fix: edited by user');
    });

    it('does not copy when the user dismisses the Edit & Copy prompt', async () => {
      installExec({ 'git diff --cached': 'diff content\n' });
      vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Edit & Copy' as never);
      vi.spyOn(window, 'showInputBox').mockResolvedValue(undefined as never); // user cancels
      const clipSpy = vi.spyOn(env.clipboard, 'writeText').mockResolvedValue();

      const client = mockClient();
      await generateCommitMessage(client as never);

      expect(clipSpy).not.toHaveBeenCalled();
    });

    it('truncates very large diffs before sending to the model', async () => {
      const hugeDiff = 'x'.repeat(20_000);
      installExec({ 'git diff --cached': hugeDiff });
      vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);

      const client = mockClient();
      await generateCommitMessage(client as never);

      const promptArg = client.complete.mock.calls[0][0] as Array<{ content: string }>;
      expect(promptArg[0].content).toContain('... (truncated)');
      // The prompt-level content should be shorter than the raw huge diff
      // plus boilerplate — proving truncation happened.
      expect(promptArg[0].content.length).toBeLessThan(hugeDiff.length);
    });

    it('shows an error when the client throws during complete()', async () => {
      installExec({ 'git diff --cached': 'diff content\n' });
      const errSpy = vi.spyOn(window, 'showErrorMessage').mockResolvedValue(undefined as never);

      const client = mockClient({ throwOnComplete: true });
      await generateCommitMessage(client as never);

      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('Failed'));
    });
  });
});
