import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window } from 'vscode';
import { reviewCurrentChanges } from './reviewer.js';

function mockClient() {
  return {
    updateSystemPrompt: vi.fn(),
    complete: vi.fn().mockResolvedValue('## Review\n- No issues found'),
  };
}

describe('reviewCurrentChanges', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('shows warning when no workspace folder', async () => {
    const warnSpy = vi.spyOn(window, 'showWarningMessage').mockResolvedValue(undefined as never);
    const vsc = await import('vscode');
    const origFolders = vsc.workspace.workspaceFolders;
    (vsc.workspace as Record<string, unknown>).workspaceFolders = undefined;

    await reviewCurrentChanges(mockClient() as never);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No workspace'));

    (vsc.workspace as Record<string, unknown>).workspaceFolders = origFolders;
  });
});
