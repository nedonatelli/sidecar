import { describe, it, expect, vi } from 'vitest';
import { showDiffPreview } from './diffPreview.js';
import { ProposedContentProvider } from './proposedContentProvider.js';
import { workspace, window } from 'vscode';

describe('showDiffPreview', () => {
  it('returns reject when no workspace folders', async () => {
    const origFolders = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;

    const provider = new ProposedContentProvider();
    const result = await showDiffPreview(
      { filePath: 'app.ts', searchText: 'old', replaceText: 'new' } as never,
      provider,
    );
    expect(result).toBe('reject');

    (workspace as Record<string, unknown>).workspaceFolders = origFolders;
  });

  it('returns accept when user accepts', async () => {
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Accept' as never);

    const provider = new ProposedContentProvider();
    const result = await showDiffPreview(
      { filePath: 'app.ts', searchText: 'old', replaceText: 'new' } as never,
      provider,
    );
    expect(result).toBe('accept');
  });

  it('returns reject when user rejects', async () => {
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue('Reject' as never);

    const provider = new ProposedContentProvider();
    const result = await showDiffPreview(
      { filePath: 'app.ts', searchText: 'old', replaceText: 'new' } as never,
      provider,
    );
    expect(result).toBe('reject');
  });

  it('returns reject when user dismisses dialog', async () => {
    vi.spyOn(window, 'showInformationMessage').mockResolvedValue(undefined as never);

    const provider = new ProposedContentProvider();
    const result = await showDiffPreview(
      { filePath: 'app.ts', searchText: 'old', replaceText: 'new' } as never,
      provider,
    );
    expect(result).toBe('reject');
  });
});
