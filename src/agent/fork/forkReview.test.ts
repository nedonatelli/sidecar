import { describe, it, expect, vi } from 'vitest';
import { Uri } from 'vscode';
import { planForkReview, reviewForkBatch, type ForkReviewUi } from './forkReview.js';
import type { ForkDispatchBatchResult, ForkResult } from './forkDispatcher.js';

// ---------------------------------------------------------------------------
// Tests for forkReview.ts (v0.67 chunk 5).
//
// Pick-the-winner review flow — planForkReview classifies the batch
// into reviewable / skipped; reviewForkBatch drives the QuickPick →
// diff view → confirm → git apply sequence. Both use an injectable
// UI so tests don't touch window.*.
// ---------------------------------------------------------------------------

const SIMPLE_DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1 +1 @@
-old
+new
`;

function makeResult(
  forkId: string,
  index: number,
  pendingDiff?: string,
  overrides: Partial<ForkResult> = {},
): ForkResult {
  return {
    forkId,
    index,
    label: `Fork ${index + 1}`,
    success: true,
    output: '',
    charsConsumed: 0,
    durationMs: 1000 + index * 100,
    sandbox: pendingDiff
      ? { mode: 'shadow', applied: false, reason: 'deferred', pendingDiff, shadowId: `s-${forkId}` }
      : { mode: 'shadow', applied: false, reason: 'empty-diff', shadowId: `s-${forkId}` },
    ...overrides,
  };
}

function makeBatch(results: ForkResult[]): ForkDispatchBatchResult {
  return { results, elapsedMs: 5000 };
}

function makeFakeUi(): ForkReviewUi & {
  calls: Record<string, unknown[]>;
  quickPickResponse?: unknown;
  confirmResponse?: string | undefined;
} {
  const calls: Record<string, unknown[]> = {
    showQuickPick: [],
    showWarningConfirm: [],
    showInfo: [],
    showError: [],
    openDiff: [],
  };
  const ui: ForkReviewUi & {
    calls: Record<string, unknown[]>;
    quickPickResponse?: unknown;
    confirmResponse?: string | undefined;
  } = {
    calls,
    async showQuickPick<T extends { label: string }>(items: T[], placeholder: string) {
      calls.showQuickPick.push({ items, placeholder });
      if (typeof ui.quickPickResponse === 'string') {
        return items.find((i) => i.label.includes(ui.quickPickResponse as string));
      }
      return ui.quickPickResponse as T | undefined;
    },
    async showWarningConfirm(message: string, confirmLabel: string) {
      calls.showWarningConfirm.push({ message, confirmLabel });
      return ui.confirmResponse;
    },
    showInfo(message) {
      calls.showInfo.push(message);
    },
    showError(message) {
      calls.showError.push(message);
    },
    async openDiff(left, right, title) {
      calls.openDiff.push({ left, right, title });
    },
  };
  return ui;
}

describe('planForkReview', () => {
  it('routes a fork with pendingDiff into reviewable', () => {
    const plan = planForkReview(makeBatch([makeResult('fork-0', 0, SIMPLE_DIFF)]));
    expect(plan.reviewable).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
    expect(plan.reviewable[0].files).toEqual(['src/a.ts']);
  });

  it('routes a failed fork into skipped with its error message', () => {
    const plan = planForkReview(
      makeBatch([makeResult('fork-0', 0, undefined, { success: false, errorMessage: 'backend down' })]),
    );
    expect(plan.reviewable).toHaveLength(0);
    expect(plan.skipped).toEqual([{ forkId: 'fork-0', label: 'Fork 1', reason: 'backend down' }]);
  });

  it('routes a successful but empty-diff fork into skipped with its sandbox reason', () => {
    const plan = planForkReview(makeBatch([makeResult('fork-0', 0)]));
    expect(plan.reviewable).toHaveLength(0);
    expect(plan.skipped[0].reason).toBe('empty-diff');
  });
});

describe('reviewForkBatch — nothing to review', () => {
  it('surfaces an info toast and returns winnerIndex: null on empty-diff-only batch', async () => {
    const ui = makeFakeUi();
    const out = await reviewForkBatch(makeBatch([makeResult('fork-0', 0)]), {
      ui,
      mainRoot: '/ws',
    });
    expect(out.winnerIndex).toBeNull();
    expect(out.appliedOk).toBe(false);
    expect(ui.calls.showInfo).toHaveLength(1);
  });
});

describe('reviewForkBatch — cancel paths', () => {
  it('returns winnerIndex: null when the picker is dismissed', async () => {
    const ui = makeFakeUi(); // quickPickResponse defaults to undefined
    const out = await reviewForkBatch(makeBatch([makeResult('fork-0', 0, SIMPLE_DIFF)]), {
      ui,
      mainRoot: '/ws',
    });
    expect(out.winnerIndex).toBeNull();
    expect(out.appliedOk).toBe(false);
  });

  it('returns winnerIndex: null when the confirmation modal is dismissed (non-Apply response)', async () => {
    const applyDiff = vi.fn();
    const ui = makeFakeUi();
    ui.quickPickResponse = 'Fork 1';
    ui.confirmResponse = undefined; // user hit Esc / Cancel
    const out = await reviewForkBatch(makeBatch([makeResult('fork-0', 0, SIMPLE_DIFF)]), {
      ui,
      mainRoot: '/ws',
      applyDiff,
      writeTempFile: async () => Uri.file('/tmp/fake'),
    });
    expect(out.winnerIndex).toBeNull();
    expect(applyDiff).not.toHaveBeenCalled();
    // Diff was still shown pre-confirmation.
    expect(ui.calls.openDiff).toHaveLength(1);
  });
});

describe('reviewForkBatch — apply path', () => {
  it('applies the winner and returns winnerIndex + appliedOk on success', async () => {
    const applyDiff = vi.fn().mockResolvedValue('ok');
    const ui = makeFakeUi();
    ui.quickPickResponse = 'Fork 2';
    ui.confirmResponse = 'Apply';

    const out = await reviewForkBatch(
      makeBatch([
        makeResult('fork-0', 0, SIMPLE_DIFF),
        makeResult('fork-1', 1, SIMPLE_DIFF),
        makeResult('fork-2', 2, SIMPLE_DIFF),
      ]),
      {
        ui,
        mainRoot: '/ws',
        applyDiff,
        writeTempFile: async () => Uri.file('/tmp/fake'),
      },
    );

    expect(out.winnerIndex).toBe(1); // Fork 2 is index 1
    expect(out.appliedOk).toBe(true);
    expect(applyDiff).toHaveBeenCalledTimes(1);
    expect(applyDiff).toHaveBeenCalledWith('/ws', SIMPLE_DIFF);
    // Info toast confirms the apply.
    expect(ui.calls.showInfo.some((m) => String(m).includes('Applied'))).toBe(true);
  });

  it('records failed apply with the thrown error and returns appliedOk: false', async () => {
    const applyDiff = vi.fn().mockRejectedValue(new Error('patch does not apply'));
    const ui = makeFakeUi();
    ui.quickPickResponse = 'Fork 1';
    ui.confirmResponse = 'Apply';

    const out = await reviewForkBatch(makeBatch([makeResult('fork-0', 0, SIMPLE_DIFF)]), {
      ui,
      mainRoot: '/ws',
      applyDiff,
      writeTempFile: async () => Uri.file('/tmp/fake'),
    });

    expect(out.winnerIndex).toBe(0);
    expect(out.appliedOk).toBe(false);
    expect(out.errorMessage).toBe('patch does not apply');
    expect(ui.calls.showError).toHaveLength(1);
  });
});

describe('reviewForkBatch — skipped-label reporting', () => {
  it('passes labels of failed + empty-diff forks back to the caller', async () => {
    const ui = makeFakeUi();
    ui.quickPickResponse = 'Fork 1';
    ui.confirmResponse = 'Apply';

    const out = await reviewForkBatch(
      makeBatch([
        makeResult('fork-0', 0, SIMPLE_DIFF), // reviewable
        makeResult('fork-1', 1), // empty diff → skipped
        makeResult('fork-2', 2, undefined, { success: false, errorMessage: 'crashed' }), // failed → skipped
      ]),
      {
        ui,
        mainRoot: '/ws',
        applyDiff: vi.fn().mockResolvedValue('ok'),
        writeTempFile: async () => Uri.file('/tmp/fake'),
      },
    );

    expect([...out.skippedLabels].sort()).toEqual(['Fork 2', 'Fork 3']);
  });
});
