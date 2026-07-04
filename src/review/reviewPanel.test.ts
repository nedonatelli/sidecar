import { describe, it, expect, vi, beforeEach } from 'vitest';
import { window } from 'vscode';
import { reviewForkBatchWithPanel, reviewFacetBatchWithPanel } from './reviewPanel.js';
import type { ForkDispatchBatchResult, ForkResult } from '../agent/fork/forkDispatcher.js';
import type { FacetDispatchBatchResult, FacetDispatchResult } from '../agent/facets/facetDispatcher.js';
import type { ForkReviewDeps } from '../agent/fork/forkReview.js';
import type { FacetReviewDeps } from '../agent/facets/facetReview.js';

// The default applyPatch path constructs a real GitCLI; every test injects
// `deps.applyDiff` instead, but mock GitCLI so an accidental default path can
// never shell out to a real repo.
vi.mock('../github/git.js', () => ({
  GitCLI: vi.fn().mockImplementation(() => ({
    applyPatch: vi.fn().mockRejectedValue(new Error('GitCLI should not be reached — inject applyDiff')),
  })),
}));

// ---------------------------------------------------------------------------
// Fake webview panel: captures the ext→panel posts and lets the test drive
// panel→ext messages (as the real inline JS would) and simulate a user close.
// ---------------------------------------------------------------------------

type PanelMsg = { command: string; [k: string]: unknown };

function makeFakePanel() {
  const posted: PanelMsg[] = [];
  let receiveCb: ((m: PanelMsg) => void) | undefined;
  let disposeCb: (() => void) | undefined;

  const panel = {
    webview: {
      html: '',
      onDidReceiveMessage: (cb: (m: PanelMsg) => void) => {
        receiveCb = cb;
        return { dispose: vi.fn() };
      },
      postMessage: (m: PanelMsg) => {
        posted.push(m);
        return Promise.resolve(true);
      },
    },
    onDidDispose: (cb: () => void) => {
      disposeCb = cb;
      return { dispose: vi.fn() };
    },
    dispose: vi.fn(() => {
      disposeCb?.();
      // A disposed webview can no longer deliver messages to the extension.
      receiveCb = undefined;
    }),
    reveal: vi.fn(),
  };

  return {
    panel,
    posted,
    /** Simulate the webview posting a message back to the extension. */
    send: async (m: PanelMsg) => {
      receiveCb?.(m);
      // Let the async onMsg handler (apply → resolve) settle.
      await Promise.resolve();
      await Promise.resolve();
    },
    /** Simulate the user closing the panel tab (fires onDidDispose). */
    userClose: () => disposeCb?.(),
  };
}

function makeForkDeps(applyDiff: ForkReviewDeps['applyDiff']): ForkReviewDeps {
  return {
    ui: {
      showQuickPick: vi.fn(),
      showWarningConfirm: vi.fn(),
      showInfo: vi.fn(),
      showError: vi.fn(),
      openDiff: vi.fn(),
    },
    mainRoot: '/main',
    applyDiff,
  };
}

function makeFacetDeps(applyDiff: FacetReviewDeps['applyDiff']): FacetReviewDeps {
  return {
    ui: {
      showQuickPick: vi.fn(),
      showWarningConfirm: vi.fn(),
      showInfo: vi.fn(),
      showError: vi.fn(),
      openDiff: vi.fn(),
    } as unknown as FacetReviewDeps['ui'],
    mainRoot: '/main',
    applyDiff,
  };
}

const DIFF_A = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n';

function forkResult(over: Partial<ForkResult> & { forkId: string; index: number }): ForkResult {
  return {
    label: `Fork ${over.index + 1}`,
    success: true,
    output: 'summary',
    charsConsumed: 100,
    durationMs: 500,
    sandbox: { mode: 'shadow', applied: false, pendingDiff: DIFF_A },
    ...over,
  } as unknown as ForkResult;
}

function facetResult(over: Partial<FacetDispatchResult> & { facetId: string }): FacetDispatchResult {
  return {
    output: 'summary',
    success: true,
    charsConsumed: 100,
    durationMs: 500,
    sandbox: { mode: 'shadow', applied: false, pendingDiff: DIFF_A },
    ...over,
  } as unknown as FacetDispatchResult;
}

const ctx = {} as never;

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Fork review
// ---------------------------------------------------------------------------

describe('reviewForkBatchWithPanel', () => {
  it('returns null outcome and shows info when nothing is reviewable', async () => {
    const batch: ForkDispatchBatchResult = {
      results: [forkResult({ forkId: 'fork-0', index: 0, success: false, errorMessage: 'boom' })],
    } as unknown as ForkDispatchBatchResult;
    const deps = makeForkDeps(vi.fn());

    const outcome = await reviewForkBatchWithPanel(batch, deps, ctx);

    expect(deps.ui.showInfo).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ winnerIndex: null, appliedOk: false, skippedLabels: ['Fork 1'] });
    expect(deps.applyDiff).not.toHaveBeenCalled();
  });

  it('posts init with the reviewable items on ready', async () => {
    const fake = makeFakePanel();
    vi.spyOn(window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
    const batch: ForkDispatchBatchResult = {
      results: [forkResult({ forkId: 'fork-0', index: 0 })],
    } as unknown as ForkDispatchBatchResult;

    void reviewForkBatchWithPanel(batch, makeForkDeps(vi.fn().mockResolvedValue('')), ctx);
    await fake.send({ command: 'ready' });

    const init = fake.posted.find((m) => m.command === 'init');
    expect(init).toBeDefined();
    expect(init!.mode).toBe('fork');
    const items = init!.items as Array<{ id: string; linesAdded: number; linesRemoved: number }>;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('fork-0');
    expect(items[0].linesAdded).toBe(1);
    expect(items[0].linesRemoved).toBe(1);
  });

  it('applies the chosen fork and resolves with its index on success', async () => {
    const fake = makeFakePanel();
    vi.spyOn(window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
    const applyDiff = vi.fn().mockResolvedValue('applied');
    const batch: ForkDispatchBatchResult = {
      results: [
        forkResult({ forkId: 'fork-0', index: 0 }),
        forkResult({ forkId: 'fork-1', index: 1 }),
      ],
    } as unknown as ForkDispatchBatchResult;

    const p = reviewForkBatchWithPanel(batch, makeForkDeps(applyDiff), ctx);
    await fake.send({ command: 'ready' });
    await fake.send({ command: 'applyFork', forkId: 'fork-1' });
    const outcome = await p;

    expect(applyDiff).toHaveBeenCalledWith('/main', DIFF_A);
    expect(outcome).toEqual({ winnerIndex: 1, appliedOk: true, skippedLabels: [] });
    expect(fake.posted).toContainEqual({ command: 'applyResult', id: 'fork-1', ok: true });
    expect(fake.panel.dispose).toHaveBeenCalled();
  });

  it('reports the failure and stays open (does not resolve) when apply throws', async () => {
    const fake = makeFakePanel();
    vi.spyOn(window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
    const applyDiff = vi.fn().mockRejectedValue(new Error('patch conflict'));
    const batch: ForkDispatchBatchResult = {
      results: [forkResult({ forkId: 'fork-0', index: 0 })],
    } as unknown as ForkDispatchBatchResult;

    const p = reviewForkBatchWithPanel(batch, makeForkDeps(applyDiff), ctx);
    await fake.send({ command: 'ready' });
    await fake.send({ command: 'applyFork', forkId: 'fork-0' });

    expect(fake.posted).toContainEqual({
      command: 'applyResult',
      id: 'fork-0',
      ok: false,
      errorMessage: 'patch conflict',
    });
    // The panel is still open — dismissing now yields the cancelled outcome.
    await fake.send({ command: 'dismiss' });
    const outcome = await p;
    expect(outcome).toEqual({ winnerIndex: null, appliedOk: false, skippedLabels: [] });
  });

  it('resolves as cancelled on dismiss without applying anything', async () => {
    const fake = makeFakePanel();
    vi.spyOn(window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
    const applyDiff = vi.fn();
    const batch: ForkDispatchBatchResult = {
      results: [forkResult({ forkId: 'fork-0', index: 0 })],
    } as unknown as ForkDispatchBatchResult;

    const p = reviewForkBatchWithPanel(batch, makeForkDeps(applyDiff), ctx);
    await fake.send({ command: 'ready' });
    await fake.send({ command: 'dismiss' });
    const outcome = await p;

    expect(applyDiff).not.toHaveBeenCalled();
    expect(outcome).toEqual({ winnerIndex: null, appliedOk: false, skippedLabels: [] });
  });

  it('resolves as cancelled when the user closes the panel', async () => {
    const fake = makeFakePanel();
    vi.spyOn(window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
    const batch: ForkDispatchBatchResult = {
      results: [forkResult({ forkId: 'fork-0', index: 0 })],
    } as unknown as ForkDispatchBatchResult;

    const p = reviewForkBatchWithPanel(batch, makeForkDeps(vi.fn()), ctx);
    await fake.send({ command: 'ready' });
    fake.userClose();
    const outcome = await p;

    expect(outcome).toEqual({ winnerIndex: null, appliedOk: false, skippedLabels: [] });
  });

  it('ignores a second apply after one already resolved (double-resolve guard)', async () => {
    const fake = makeFakePanel();
    vi.spyOn(window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
    const applyDiff = vi.fn().mockResolvedValue('applied');
    const batch: ForkDispatchBatchResult = {
      results: [
        forkResult({ forkId: 'fork-0', index: 0 }),
        forkResult({ forkId: 'fork-1', index: 1 }),
      ],
    } as unknown as ForkDispatchBatchResult;

    const p = reviewForkBatchWithPanel(batch, makeForkDeps(applyDiff), ctx);
    await fake.send({ command: 'ready' });
    await fake.send({ command: 'applyFork', forkId: 'fork-0' });
    // Panel is disposed after the first resolve; a stray second message + close
    // must not change the settled outcome.
    await fake.send({ command: 'applyFork', forkId: 'fork-1' });
    fake.userClose();
    const outcome = await p;

    expect(outcome.winnerIndex).toBe(0);
    expect(applyDiff).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Facet review
// ---------------------------------------------------------------------------

describe('reviewFacetBatchWithPanel', () => {
  it('returns an empty outcome and shows info when there are no entries', async () => {
    // planFacetReview treats any non-empty pendingDiff as reviewable regardless
    // of success, so an "empty" facet must carry no diff.
    const batch: FacetDispatchBatchResult = {
      results: [
        facetResult({
          facetId: 'f0',
          success: false,
          errorMessage: 'boom',
          sandbox: { mode: 'shadow', applied: false, reason: 'no-diff' } as never,
        }),
      ],
    } as unknown as FacetDispatchBatchResult;
    const deps = makeFacetDeps(vi.fn());

    const outcome = await reviewFacetBatchWithPanel(batch, deps, ctx);

    expect(deps.ui.showInfo).toHaveBeenCalledOnce();
    expect(outcome).toEqual({ applied: [], rejected: [], failed: [], cancelledRemaining: [] });
    expect(deps.applyDiff).not.toHaveBeenCalled();
  });

  it('accepts a facet and records it as applied', async () => {
    const fake = makeFakePanel();
    vi.spyOn(window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
    const applyDiff = vi.fn().mockResolvedValue('applied');
    const batch: FacetDispatchBatchResult = {
      results: [facetResult({ facetId: 'f0' }), facetResult({ facetId: 'f1' })],
    } as unknown as FacetDispatchBatchResult;

    const p = reviewFacetBatchWithPanel(batch, makeFacetDeps(applyDiff), ctx);
    await fake.send({ command: 'ready' });
    await fake.send({ command: 'acceptFacet', facetId: 'f0' });
    await fake.send({ command: 'dismiss' });
    const outcome = await p;

    expect(applyDiff).toHaveBeenCalledWith('/main', DIFF_A);
    expect(outcome.applied).toEqual(['f0']);
    expect(outcome.cancelledRemaining).toEqual(['f1']);
    expect(fake.posted).toContainEqual({ command: 'applyResult', id: 'f0', ok: true });
  });

  it('records a facet whose apply throws as failed, not applied', async () => {
    const fake = makeFakePanel();
    vi.spyOn(window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
    const applyDiff = vi.fn().mockRejectedValue(new Error('conflict'));
    const batch: FacetDispatchBatchResult = {
      results: [facetResult({ facetId: 'f0' })],
    } as unknown as FacetDispatchBatchResult;

    const p = reviewFacetBatchWithPanel(batch, makeFacetDeps(applyDiff), ctx);
    await fake.send({ command: 'ready' });
    await fake.send({ command: 'acceptFacet', facetId: 'f0' });
    await fake.send({ command: 'dismiss' });
    const outcome = await p;

    expect(outcome.applied).toEqual([]);
    expect(outcome.failed).toEqual([{ facetId: 'f0', error: 'conflict' }]);
    expect(fake.posted).toContainEqual({ command: 'applyResult', id: 'f0', ok: false, errorMessage: 'conflict' });
  });

  it('rejects a facet without applying its diff', async () => {
    const fake = makeFakePanel();
    vi.spyOn(window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
    const applyDiff = vi.fn();
    const batch: FacetDispatchBatchResult = {
      results: [facetResult({ facetId: 'f0' })],
    } as unknown as FacetDispatchBatchResult;

    const p = reviewFacetBatchWithPanel(batch, makeFacetDeps(applyDiff), ctx);
    await fake.send({ command: 'ready' });
    await fake.send({ command: 'rejectFacet', facetId: 'f0' });
    await fake.send({ command: 'dismiss' });
    const outcome = await p;

    expect(applyDiff).not.toHaveBeenCalled();
    expect(outcome.rejected).toEqual(['f0']);
    expect(outcome.applied).toEqual([]);
  });

  it('leaves skipped facets in cancelledRemaining on dismiss', async () => {
    const fake = makeFakePanel();
    vi.spyOn(window, 'createWebviewPanel').mockReturnValue(fake.panel as never);
    const applyDiff = vi.fn().mockResolvedValue('applied');
    const batch: FacetDispatchBatchResult = {
      results: [facetResult({ facetId: 'f0' }), facetResult({ facetId: 'f1' })],
    } as unknown as FacetDispatchBatchResult;

    const p = reviewFacetBatchWithPanel(batch, makeFacetDeps(applyDiff), ctx);
    await fake.send({ command: 'ready' });
    await fake.send({ command: 'acceptFacet', facetId: 'f0' });
    await fake.send({ command: 'skipFacet', facetId: 'f1' });
    await fake.send({ command: 'dismiss' });
    const outcome = await p;

    expect(outcome.applied).toEqual(['f0']);
    expect(outcome.cancelledRemaining).toEqual(['f1']);
  });
});
