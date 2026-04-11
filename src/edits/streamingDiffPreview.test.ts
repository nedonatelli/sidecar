import { describe, it, expect, vi } from 'vitest';
import { openDiffPreview } from './streamingDiffPreview.js';
import { ProposedContentProvider } from './proposedContentProvider.js';
import { workspace } from 'vscode';

describe('openDiffPreview', () => {
  it('throws when no workspace folders', async () => {
    const origFolders = workspace.workspaceFolders;
    (workspace as Record<string, unknown>).workspaceFolders = undefined;

    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn();

    await expect(openDiffPreview('app.ts', 'content', provider, confirmFn)).rejects.toThrow('No workspace folder open');

    (workspace as Record<string, unknown>).workspaceFolders = origFolders;
  });

  it('returns a session with update, finalize, and dispose', async () => {
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn().mockResolvedValue('Accept');

    const session = await openDiffPreview('app.ts', 'initial content', provider, confirmFn);

    expect(session.update).toBeDefined();
    expect(session.finalize).toBeDefined();
    expect(session.dispose).toBeDefined();
  });

  it('update changes the proposed content', async () => {
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn().mockResolvedValue('Accept');

    const session = await openDiffPreview('app.ts', 'v1', provider, confirmFn);
    session.update('v2');

    // Verify the provider got updated content
    const uri = { path: '/app.ts' } as never;
    expect(provider.provideTextDocumentContent(uri)).toBe('v2');

    session.dispose();
  });

  it('finalize returns accept when user accepts', async () => {
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn().mockResolvedValue('Accept');

    const session = await openDiffPreview('app.ts', 'content', provider, confirmFn);
    const result = await session.finalize();
    expect(result).toBe('accept');
    session.dispose();
  });

  it('finalize returns reject when user rejects', async () => {
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn().mockResolvedValue('Reject');

    const session = await openDiffPreview('app.ts', 'content', provider, confirmFn);
    const result = await session.finalize();
    expect(result).toBe('reject');
    session.dispose();
  });

  it('dispose cleans up the proposal', async () => {
    const provider = new ProposedContentProvider();
    const confirmFn = vi.fn();

    const session = await openDiffPreview('app.ts', 'content', provider, confirmFn);
    session.dispose();

    const uri = { path: '/app.ts' } as never;
    expect(provider.provideTextDocumentContent(uri)).toBe('');
  });
});
