import { describe, it, expect, vi } from 'vitest';
import { runForkDispatchCommand, type ForkCommandUi, type ForkCommandConfig } from './forkCommands.js';
import type { ForkDispatchBatchResult, dispatchForks as dispatchForksFn } from './forkDispatcher.js';
import type { reviewForkBatch as reviewForkBatchFn } from './forkReview.js';

// ---------------------------------------------------------------------------
// Tests for forkCommands.ts (v0.67 chunk 6).
//
// Drives the end-to-end command flow with injected UI + dispatch +
// review. Covers every cancel path, the disabled gate, the
// dispatched-with-review and dispatched-headless branches.
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<ForkCommandConfig> = {}): ForkCommandConfig {
  return {
    enabled: true,
    defaultCount: 3,
    maxConcurrent: 3,
    ...overrides,
  };
}

function makeFakeUi(): ForkCommandUi & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    showInputBox: [],
    showInfo: [],
    showError: [],
  };
  return {
    calls,
    async showInputBox(prompt, placeholder) {
      calls.showInputBox.push({ prompt, placeholder });
      return undefined;
    },
    showInfo(message) {
      calls.showInfo.push(message);
    },
    showError(message) {
      calls.showError.push(message);
    },
  };
}

function stubClient() {
  return {} as never;
}

function emptyBatch(): ForkDispatchBatchResult {
  return { results: [], elapsedMs: 100 };
}

describe('runForkDispatchCommand — gating', () => {
  it('returns disabled without prompting when fork is off', async () => {
    const ui = makeFakeUi();
    const outcome = await runForkDispatchCommand({
      ui,
      createClient: () => stubClient(),
      config: makeConfig({ enabled: false }),
    });
    expect(outcome.mode).toBe('disabled');
    expect(ui.calls.showInputBox).toHaveLength(0);
    expect(ui.calls.showInfo).toHaveLength(1);
  });
});

describe('runForkDispatchCommand — prompt flow', () => {
  it('prompts the user when preFilledTask is absent and cancels on dismiss', async () => {
    const ui = makeFakeUi(); // showInputBox returns undefined by default
    const outcome = await runForkDispatchCommand({
      ui,
      createClient: () => stubClient(),
      config: makeConfig(),
    });
    expect(outcome.mode).toBe('cancelled');
    if (outcome.mode === 'cancelled') expect(outcome.reason).toBe('task-cancelled');
    expect(ui.calls.showInputBox).toHaveLength(1);
  });

  it('skips the prompt when preFilledTask is supplied (slash-command path)', async () => {
    const ui = makeFakeUi();
    const dispatch = vi.fn().mockResolvedValue(emptyBatch());
    const outcome = await runForkDispatchCommand({
      ui,
      createClient: () => stubClient(),
      config: makeConfig(),
      preFilledTask: 'refactor the auth middleware',
      dispatch: dispatch as unknown as typeof dispatchForksFn,
    });
    expect(ui.calls.showInputBox).toHaveLength(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(outcome.mode).toBe('dispatched');
  });

  it('cancels when the task is whitespace only', async () => {
    const ui = makeFakeUi();
    ui.showInputBox = (async () => '   ') as ForkCommandUi['showInputBox'];
    const outcome = await runForkDispatchCommand({
      ui,
      createClient: () => stubClient(),
      config: makeConfig(),
    });
    expect(outcome.mode).toBe('cancelled');
    if (outcome.mode === 'cancelled') expect(outcome.reason).toBe('empty-task');
  });

  it('trims whitespace from the resolved task before dispatch', async () => {
    const ui = makeFakeUi();
    ui.showInputBox = (async () => '  refactor  ') as ForkCommandUi['showInputBox'];
    const dispatch = vi.fn().mockResolvedValue(emptyBatch());
    await runForkDispatchCommand({
      ui,
      createClient: () => stubClient(),
      config: makeConfig(),
      dispatch: dispatch as unknown as typeof dispatchForksFn,
    });
    const callArgs = dispatch.mock.calls[0];
    expect(callArgs[2].task).toBe('refactor');
  });
});

describe('runForkDispatchCommand — dispatch', () => {
  it('passes config-driven numForks + maxConcurrent into dispatchForks', async () => {
    const ui = makeFakeUi();
    const dispatch = vi.fn().mockResolvedValue(emptyBatch());
    await runForkDispatchCommand({
      ui,
      createClient: () => stubClient(),
      config: makeConfig({ defaultCount: 5, maxConcurrent: 2 }),
      preFilledTask: 'task',
      dispatch: dispatch as unknown as typeof dispatchForksFn,
    });
    const callArgs = dispatch.mock.calls[0];
    expect(callArgs[2].numForks).toBe(5);
    expect(callArgs[2].maxConcurrent).toBe(2);
  });

  it('surfaces a summary toast with success/failure counts + elapsed seconds', async () => {
    const ui = makeFakeUi();
    const batch: ForkDispatchBatchResult = {
      results: [
        {
          forkId: 'fork-0',
          index: 0,
          label: 'Fork 1',
          success: true,
          output: '',
          charsConsumed: 0,
          sandbox: { mode: 'shadow', applied: false, reason: 'deferred' },
          durationMs: 1000,
        },
        {
          forkId: 'fork-1',
          index: 1,
          label: 'Fork 2',
          success: false,
          errorMessage: 'kaboom',
          output: '',
          charsConsumed: 0,
          sandbox: { mode: 'direct', applied: false, reason: 'apply-failed' },
          durationMs: 0,
        },
      ],
      elapsedMs: 1500,
    };
    await runForkDispatchCommand({
      ui,
      createClient: () => stubClient(),
      config: makeConfig(),
      preFilledTask: 'task',
      dispatch: vi.fn().mockResolvedValue(batch) as unknown as typeof dispatchForksFn,
    });
    const summary = ui.calls.showInfo[0] as string;
    expect(summary).toMatch(/1 succeeded/);
    expect(summary).toMatch(/1 failed/);
    expect(summary).toMatch(/1\.5s/);
  });

  it('triggers reviewForkBatch when reviewDeps is supplied', async () => {
    const ui = makeFakeUi();
    const batch = emptyBatch();
    const review = vi.fn().mockResolvedValue({
      winnerIndex: 0,
      appliedOk: true,
      skippedLabels: [],
    });
    const outcome = await runForkDispatchCommand({
      ui,
      createClient: () => stubClient(),
      config: makeConfig(),
      preFilledTask: 'task',
      dispatch: vi.fn().mockResolvedValue(batch) as unknown as typeof dispatchForksFn,
      review: review as unknown as typeof reviewForkBatchFn,
      reviewDeps: {
        ui: {
          showQuickPick: async () => undefined,
          showWarningConfirm: async () => undefined,
          showInfo: () => undefined,
          showError: () => undefined,
          openDiff: async () => undefined,
        },
        mainRoot: '/ws',
      },
    });
    expect(review).toHaveBeenCalledTimes(1);
    if (outcome.mode === 'dispatched') {
      expect(outcome.review?.winnerIndex).toBe(0);
      expect(outcome.review?.appliedOk).toBe(true);
    }
  });

  it('skips review when reviewDeps is omitted (headless caller)', async () => {
    const ui = makeFakeUi();
    const review = vi.fn();
    const outcome = await runForkDispatchCommand({
      ui,
      createClient: () => stubClient(),
      config: makeConfig(),
      preFilledTask: 'task',
      dispatch: vi.fn().mockResolvedValue(emptyBatch()) as unknown as typeof dispatchForksFn,
      review: review as unknown as typeof reviewForkBatchFn,
    });
    expect(review).not.toHaveBeenCalled();
    if (outcome.mode === 'dispatched') expect(outcome.review).toBeUndefined();
  });

  it('re-throws dispatcher failures after surfacing the error', async () => {
    const ui = makeFakeUi();
    const dispatch = vi.fn().mockRejectedValue(new Error('backend down'));
    await expect(
      runForkDispatchCommand({
        ui,
        createClient: () => stubClient(),
        config: makeConfig(),
        preFilledTask: 'task',
        dispatch: dispatch as unknown as typeof dispatchForksFn,
      }),
    ).rejects.toThrow(/backend down/);
    expect(ui.calls.showError[0]).toMatch(/backend down/);
  });
});
