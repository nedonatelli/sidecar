import { describe, it, expect, vi } from 'vitest';
import { Uri } from 'vscode';
import {
  filesTouchedByDiff,
  planFacetReview,
  reviewFacetBatch,
  type FacetReviewUi,
  type FacetReviewDeps,
} from './facetReview.js';
import type { FacetDispatchBatchResult, FacetDispatchResult } from './facetDispatcher.js';

// ---------------------------------------------------------------------------
// Tests for facetReview.ts (v0.66 chunk 3.6).
//
// The planner is pure and covered directly. The review loop uses an
// injectable UI so we can drive the user-choice sequence without
// touching `window.*` at all.
// ---------------------------------------------------------------------------

const GIT_DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`;

const MULTI_FILE_DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1 +1 @@
-old
+new
`;

function makeResult(
  facetId: string,
  pendingDiff?: string,
  overrides: Partial<FacetDispatchResult> = {},
): FacetDispatchResult {
  return {
    facetId,
    output: '',
    success: true,
    charsConsumed: 0,
    sandbox: pendingDiff
      ? { mode: 'shadow', applied: false, reason: 'deferred', pendingDiff, shadowId: `s-${facetId}` }
      : { mode: 'shadow', applied: false, reason: 'empty-diff', shadowId: `s-${facetId}` },
    durationMs: 1,
    ...overrides,
  };
}

function makeBatch(results: FacetDispatchResult[]): FacetDispatchBatchResult {
  return { results, rpcWireTrace: [] };
}

function makeFakeUi(): FacetReviewUi & { quickPickSequence: Array<unknown>; calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { showInfo: [], showError: [], openDiff: [] };
  return {
    calls,
    quickPickSequence: [],
    async showQuickPick<T extends { label: string }>(items: T[]) {
      const next = this.quickPickSequence.shift();
      if (next === undefined) return undefined;
      if (typeof next === 'number') return items[next as number] as T;
      // Match by label fragment.
      const needle = String(next);
      return items.find((i) => i.label.includes(needle));
    },
    showInfo(msg) {
      calls.showInfo.push(msg);
    },
    showError(msg) {
      calls.showError.push(msg);
    },
    async openDiff(left, right, title) {
      calls.openDiff.push({ left, right, title });
    },
  };
}

describe('filesTouchedByDiff', () => {
  it('extracts git-header paths', () => {
    expect(filesTouchedByDiff(GIT_DIFF)).toEqual(['src/a.ts']);
  });

  it('returns multiple files from a multi-file diff', () => {
    expect(filesTouchedByDiff(MULTI_FILE_DIFF).sort()).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('falls back to +++ lines when git headers are absent', () => {
    const patch = `--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-a\n+b\n`;
    expect(filesTouchedByDiff(patch)).toEqual(['src/x.ts']);
  });
});

describe('planFacetReview', () => {
  it('routes failed facets to skipped with their error message', () => {
    const batch = makeBatch([makeResult('coder', undefined, { success: false, errorMessage: 'boom' })]);
    const plan = planFacetReview(batch);
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped).toEqual([{ facetId: 'coder', reason: 'boom' }]);
  });

  it('routes empty-diff facets to skipped with their sandbox reason', () => {
    const batch = makeBatch([makeResult('coder')]);
    const plan = planFacetReview(batch);
    expect(plan.entries).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('empty-diff');
  });

  it('computes overlaps across facets touching the same file', () => {
    const batch = makeBatch([
      makeResult('a', GIT_DIFF),
      makeResult('b', GIT_DIFF),
      makeResult(
        'c',
        `diff --git a/unrelated.ts b/unrelated.ts\n--- a/unrelated.ts\n+++ b/unrelated.ts\n@@ -1 +1 @@\n-x\n+y\n`,
      ),
    ]);
    const plan = planFacetReview(batch);
    expect(plan.entries).toHaveLength(3);
    const a = plan.entries.find((e) => e.facetId === 'a')!;
    const b = plan.entries.find((e) => e.facetId === 'b')!;
    const c = plan.entries.find((e) => e.facetId === 'c')!;
    expect(a.overlapsWith).toEqual(['b']);
    expect(b.overlapsWith).toEqual(['a']);
    expect(c.overlapsWith).toEqual([]);
  });
});

describe('reviewFacetBatch', () => {
  it('returns empty outcome + info toast when nothing is reviewable', async () => {
    const ui = makeFakeUi();
    const outcome = await reviewFacetBatch(makeBatch([makeResult('empty')]), {
      ui,
      mainRoot: '/ws',
    });
    expect(outcome.applied).toEqual([]);
    expect(ui.calls.showInfo).toHaveLength(1);
  });

  it('applies a single facet via the default diff path when user clicks accept', async () => {
    const applyDiff = vi.fn().mockResolvedValue('applied');
    const ui = makeFakeUi();
    // Sequence: pick facet "coder", then click "Accept".
    ui.quickPickSequence = ['coder', 'Accept'];

    const outcome = await reviewFacetBatch(makeBatch([makeResult('coder', GIT_DIFF)]), {
      ui,
      mainRoot: '/ws',
      applyDiff,
    });

    expect(applyDiff).toHaveBeenCalledTimes(1);
    expect(applyDiff).toHaveBeenCalledWith('/ws', GIT_DIFF);
    expect(outcome.applied).toEqual(['coder']);
    expect(outcome.rejected).toEqual([]);
    expect(outcome.failed).toEqual([]);
  });

  it('rejects a facet without calling applyDiff', async () => {
    const applyDiff = vi.fn();
    const ui = makeFakeUi();
    ui.quickPickSequence = ['coder', 'Reject'];
    const outcome = await reviewFacetBatch(makeBatch([makeResult('coder', GIT_DIFF)]), {
      ui,
      mainRoot: '/ws',
      applyDiff,
    });
    expect(applyDiff).not.toHaveBeenCalled();
    expect(outcome.rejected).toEqual(['coder']);
  });

  it('records failed apply with the thrown error message', async () => {
    const applyDiff = vi.fn().mockRejectedValue(new Error('patch does not apply'));
    const ui = makeFakeUi();
    ui.quickPickSequence = ['coder', 'Accept'];
    const outcome = await reviewFacetBatch(makeBatch([makeResult('coder', GIT_DIFF)]), {
      ui,
      mainRoot: '/ws',
      applyDiff,
    });
    expect(outcome.applied).toEqual([]);
    expect(outcome.failed).toEqual([{ facetId: 'coder', error: 'patch does not apply' }]);
    expect(ui.calls.showError).toHaveLength(1);
  });

  it('keeps facets in pending on Skip and returns them as cancelledRemaining when the user dismisses', async () => {
    const applyDiff = vi.fn();
    const ui = makeFakeUi();
    // Pick "coder", then Skip, then dismiss the top-level picker (undefined).
    ui.quickPickSequence = ['coder', 'Skip'];
    const outcome = await reviewFacetBatch(makeBatch([makeResult('coder', GIT_DIFF)]), {
      ui,
      mainRoot: '/ws',
      applyDiff,
    });
    expect(outcome.applied).toEqual([]);
    expect(outcome.rejected).toEqual([]);
    expect(outcome.cancelledRemaining).toEqual(['coder']);
  });

  it('stops the loop when the facet picker is dismissed', async () => {
    const applyDiff = vi.fn();
    const ui = makeFakeUi();
    // Dismiss immediately (empty sequence).
    const outcome = await reviewFacetBatch(makeBatch([makeResult('a', GIT_DIFF), makeResult('b', GIT_DIFF)]), {
      ui,
      mainRoot: '/ws',
      applyDiff,
    });
    expect([...outcome.cancelledRemaining].sort()).toEqual(['a', 'b']);
  });

  it('opens the diff viewer and re-prompts after Show diff', async () => {
    const applyDiff = vi.fn().mockResolvedValue('ok');
    const writeTempFile = vi.fn().mockResolvedValue(Uri.file('/tmp/fake'));
    const ui = makeFakeUi();
    // Pick coder → "Show diff" → (re-prompted) → "Accept".
    ui.quickPickSequence = ['coder', 'Show diff', 'Accept'];

    const outcome = await reviewFacetBatch(makeBatch([makeResult('coder', GIT_DIFF)]), {
      ui,
      mainRoot: '/ws',
      applyDiff,
      writeTempFile,
    } as FacetReviewDeps);

    expect(ui.calls.openDiff).toHaveLength(1);
    expect(writeTempFile).toHaveBeenCalledTimes(2);
    expect(outcome.applied).toEqual(['coder']);
  });

  it('applies multiple facets in the user-chosen order', async () => {
    const applyOrder: string[] = [];
    const applyDiff = vi.fn().mockImplementation(async (_root, diff: string) => {
      applyOrder.push(diff.includes('/a.ts') ? 'a' : 'b');
      return 'ok';
    });
    const ui = makeFakeUi();
    // Pick b → Accept → pick a → Accept.
    ui.quickPickSequence = ['b', 'Accept', 'a', 'Accept'];

    const aDiff = `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-a\n+A\n`;
    const bDiff = `diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-b\n+B\n`;
    const outcome = await reviewFacetBatch(makeBatch([makeResult('a', aDiff), makeResult('b', bDiff)]), {
      ui,
      mainRoot: '/ws',
      applyDiff,
    });

    expect(outcome.applied).toEqual(['b', 'a']);
    expect(applyOrder).toEqual(['b', 'a']);
  });
});
