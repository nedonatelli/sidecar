import { describe, it, expect, vi } from 'vitest';
import {
  runFacetDispatchCommand,
  type FacetCommandUi,
  type FacetCommandDeps,
  type FacetCommandConfig,
} from './facetCommands.js';
import { buildFacetRegistry, mergeWithBuiltInFacets } from './facetRegistry.js';
import type { FacetDispatchBatchResult } from './facetDispatcher.js';
import type { LoadFacetsOutcome } from './facetDiskLoader.js';

// ---------------------------------------------------------------------------
// Tests for facetCommands.ts (v0.66 chunk 3.5b).
//
// Drives the command-palette flow through a fake UI + injected
// `loadRegistry`/`dispatch`. Only the dispatch path uses the real
// facet registry; the actual dispatcher is stubbed because these tests
// cover wiring, not facet behavior (covered by facetDispatcher.test.ts).
// ---------------------------------------------------------------------------

function makeRegistryOutcome(): LoadFacetsOutcome {
  return {
    registry: buildFacetRegistry(mergeWithBuiltInFacets([])),
    errors: [],
  };
}

function makeConfig(overrides: Partial<FacetCommandConfig> = {}): FacetCommandConfig {
  return {
    enabled: true,
    maxConcurrent: 2,
    rpcTimeoutMs: 30_000,
    ...overrides,
  };
}

function makeFakeUi(): FacetCommandUi & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = {
    showMultiSelectPick: [],
    showInputBox: [],
    showQuickPick: [],
    showInfo: [],
    showError: [],
  };
  return {
    calls,
    async showMultiSelectPick(items, placeholder) {
      calls.showMultiSelectPick.push({ items, placeholder });
      return undefined;
    },
    async showInputBox(prompt, placeholder) {
      calls.showInputBox.push({ prompt, placeholder });
      return undefined;
    },
    async showQuickPick(items, placeholder) {
      calls.showQuickPick.push({ items, placeholder });
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
  return {} as unknown as FacetCommandDeps['createClient'] extends () => infer T ? T : never;
}

describe('runFacetDispatchCommand — gating', () => {
  it('returns disabled without prompting when facets are off', async () => {
    const ui = makeFakeUi();
    const outcome = await runFacetDispatchCommand({
      ui,
      loadRegistry: async () => makeRegistryOutcome(),
      createClient: () => stubClient(),
      config: makeConfig({ enabled: false }),
    });
    expect(outcome.mode).toBe('disabled');
    expect(ui.calls.showMultiSelectPick).toHaveLength(0);
    expect(ui.calls.showInfo).toHaveLength(1);
  });

  it('reports registry-empty when no built-ins and no disk facets are available', async () => {
    const ui = makeFakeUi();
    const emptyRegistry: LoadFacetsOutcome = {
      registry: {
        all: [],
        get: () => undefined,
        has: () => false,
        layers: () => [],
      },
      errors: [],
    };
    const outcome = await runFacetDispatchCommand({
      ui,
      loadRegistry: async () => emptyRegistry,
      createClient: () => stubClient(),
      config: makeConfig(),
    });
    expect(outcome.mode).toBe('cancelled');
    if (outcome.mode === 'cancelled') expect(outcome.reason).toBe('registry-empty');
    expect(ui.calls.showError).toHaveLength(1);
  });
});

describe('runFacetDispatchCommand — prompt flow', () => {
  it('cancels when the multi-select picker is dismissed', async () => {
    const ui = makeFakeUi();
    const outcome = await runFacetDispatchCommand({
      ui,
      loadRegistry: async () => makeRegistryOutcome(),
      createClient: () => stubClient(),
      config: makeConfig(),
    });
    expect(outcome.mode).toBe('cancelled');
    if (outcome.mode === 'cancelled') expect(outcome.reason).toBe('picker-cancelled');
  });

  it('cancels when no facets are selected from the picker', async () => {
    const ui = makeFakeUi();
    ui.showMultiSelectPick = (async () => []) as FacetCommandUi['showMultiSelectPick'];
    const outcome = await runFacetDispatchCommand({
      ui,
      loadRegistry: async () => makeRegistryOutcome(),
      createClient: () => stubClient(),
      config: makeConfig(),
    });
    expect(outcome.mode).toBe('cancelled');
    if (outcome.mode === 'cancelled') expect(outcome.reason).toBe('no-facets-selected');
  });

  it('cancels when the input box is dismissed', async () => {
    const ui = makeFakeUi();
    ui.showMultiSelectPick = (async () => [
      { label: 'General Coder', id: 'general-coder' },
    ]) as FacetCommandUi['showMultiSelectPick'];
    ui.showInputBox = async () => undefined;
    const outcome = await runFacetDispatchCommand({
      ui,
      loadRegistry: async () => makeRegistryOutcome(),
      createClient: () => stubClient(),
      config: makeConfig(),
    });
    expect(outcome.mode).toBe('cancelled');
    if (outcome.mode === 'cancelled') expect(outcome.reason).toBe('task-cancelled');
  });

  it('cancels when the task is whitespace only', async () => {
    const ui = makeFakeUi();
    ui.showMultiSelectPick = (async () => [
      { label: 'General Coder', id: 'general-coder' },
    ]) as FacetCommandUi['showMultiSelectPick'];
    ui.showInputBox = async () => '   ';
    const outcome = await runFacetDispatchCommand({
      ui,
      loadRegistry: async () => makeRegistryOutcome(),
      createClient: () => stubClient(),
      config: makeConfig(),
    });
    expect(outcome.mode).toBe('cancelled');
    if (outcome.mode === 'cancelled') expect(outcome.reason).toBe('empty-task');
  });
});

describe('runFacetDispatchCommand — dispatch', () => {
  it('invokes dispatchFacets with the selected ids + trimmed task + config', async () => {
    const ui = makeFakeUi();
    ui.showMultiSelectPick = (async () => [
      { label: 'General Coder', id: 'general-coder' },
      { label: 'Test Author', id: 'test-author' },
    ]) as FacetCommandUi['showMultiSelectPick'];
    ui.showInputBox = async () => '  draft the unit tests  ';

    const batch: FacetDispatchBatchResult = {
      results: [
        {
          facetId: 'general-coder',
          output: '',
          success: true,
          charsConsumed: 0,
          sandbox: { mode: 'shadow', applied: false },
          durationMs: 0,
        },
        {
          facetId: 'test-author',
          output: '',
          success: false,
          errorMessage: 'kaboom',
          charsConsumed: 0,
          sandbox: { mode: 'shadow', applied: false },
          durationMs: 0,
        },
      ],
      rpcWireTrace: [],
    };

    const dispatch = vi.fn().mockResolvedValue(batch);
    const outcome = await runFacetDispatchCommand({
      ui,
      loadRegistry: async () => makeRegistryOutcome(),
      createClient: () => stubClient(),
      config: makeConfig({ maxConcurrent: 4, rpcTimeoutMs: 5_000 }),
      dispatch: dispatch as unknown as typeof import('./facetDispatcher.js').dispatchFacets,
    });

    expect(outcome.mode).toBe('dispatched');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const callArgs = dispatch.mock.calls[0];
    expect(callArgs[2]).toEqual(['general-coder', 'test-author']);
    expect(callArgs[4]).toMatchObject({
      task: 'draft the unit tests',
      maxConcurrent: 4,
      rpcTimeoutMs: 5_000,
    });
    // Summary toast fires once with both counts.
    const info = ui.calls.showInfo[0] as string;
    expect(info).toMatch(/1 succeeded/);
    expect(info).toMatch(/1 failed/);
  });

  it('surfaces loader errors via showError before prompting', async () => {
    const ui = makeFakeUi();
    ui.showMultiSelectPick = async () => undefined;

    const outcome = await runFacetDispatchCommand({
      ui,
      loadRegistry: async () => ({
        registry: buildFacetRegistry(mergeWithBuiltInFacets([])),
        errors: [{ filePath: '/ws/.sidecar/facets/bad.md', reason: 'missing-frontmatter', message: 'x' }],
      }),
      createClient: () => stubClient(),
      config: makeConfig(),
    });

    expect(outcome.mode).toBe('cancelled');
    expect(ui.calls.showError[0]).toMatch(/missing-frontmatter/);
  });

  it('re-throws dispatcher failures after surfacing the error', async () => {
    const ui = makeFakeUi();
    ui.showMultiSelectPick = (async () => [
      { label: 'General Coder', id: 'general-coder' },
    ]) as FacetCommandUi['showMultiSelectPick'];
    ui.showInputBox = async () => 'do a thing';

    const dispatch = vi.fn().mockRejectedValue(new Error('backend down'));

    await expect(
      runFacetDispatchCommand({
        ui,
        loadRegistry: async () => makeRegistryOutcome(),
        createClient: () => stubClient(),
        config: makeConfig(),
        dispatch: dispatch as unknown as typeof import('./facetDispatcher.js').dispatchFacets,
      }),
    ).rejects.toThrow(/backend down/);

    expect(ui.calls.showError[0]).toMatch(/backend down/);
  });
});
