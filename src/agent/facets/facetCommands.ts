import { window } from 'vscode';
import { type LoadFacetsOutcome } from './facetDiskLoader.js';
import { dispatchFacets, type FacetDispatchBatchResult } from './facetDispatcher.js';
import type { FacetDefinition } from './facetLoader.js';
import type { SideCarClient } from '../../ollama/client.js';
import type { AgentCallbacks } from '../loop.js';

// ---------------------------------------------------------------------------
// Facet command entry point (v0.66 chunk 3.5b).
//
// Minimal command-palette MVP: pick one or more facets via QuickPick,
// prompt for a task via InputBox, then dispatch the batch through
// `dispatchFacets` and surface per-facet success/failure to the user.
// The full sidebar Expert Panel (multi-select with progress tiles,
// RPC wire-trace tab, diff-aware merge UI) is chunk 3.5c / 3.6.
//
// The handler is extracted from extension.ts so it's testable through
// an injectable `FacetCommandUi` — tests can drive the flow without
// stubbing `window.*`.
// ---------------------------------------------------------------------------

export interface FacetCommandUi {
  /**
   * Multi-select picker. Returns the selected items or undefined on cancel.
   */
  showMultiSelectPick<T extends { label: string }>(items: T[], placeholder: string): Promise<T[] | undefined>;
  /** Free-form text prompt. Returns the user's input or undefined on cancel. */
  showInputBox(prompt: string, placeholder?: string): Promise<string | undefined>;
  /** Pick one item — used for loader-error drill-down. */
  showQuickPick<T extends { label: string }>(items: T[], placeholder: string): Promise<T | undefined>;
  /** Fire-and-forget info toast. */
  showInfo(message: string): void;
  /** Fire-and-forget error toast. */
  showError(message: string): void;
}

/**
 * Environment the command needs. In production this is wired from
 * `extension.ts`; tests supply in-memory stand-ins.
 */
export interface FacetCommandDeps {
  /** UI surface — real shim in production, fake in tests. */
  ui: FacetCommandUi;
  /** Loads the merged facet registry (built-ins + disk). */
  loadRegistry: () => Promise<LoadFacetsOutcome>;
  /** Fresh `SideCarClient`. Tests pass a stub. */
  createClient: () => SideCarClient;
  /** Abort signal source for the batch — defaults to a never-aborted signal. */
  signal?: AbortSignal;
  /** Runs the dispatch. Indirection lets tests assert inputs without spinning up real facets. */
  dispatch?: typeof dispatchFacets;
  /** Callback sink for LLM output during facet runs. Tests pass a recorder. */
  callbacks?: AgentCallbacks;
  /** Config values from `sidecar.facets.*`. */
  config: FacetCommandConfig;
}

export interface FacetCommandConfig {
  /** `sidecar.facets.enabled`. */
  readonly enabled: boolean;
  /** `sidecar.facets.maxConcurrent`. */
  readonly maxConcurrent: number;
  /** `sidecar.facets.rpcTimeoutMs`. */
  readonly rpcTimeoutMs: number;
}

/**
 * Returned from `runFacetDispatchCommand` so `extension.ts` and tests
 * can inspect why a run did or didn't happen. `mode === 'cancelled'`
 * covers every no-op path (disabled, user cancelled a prompt, no
 * facets selected, empty task); `mode === 'dispatched'` carries the
 * batch result for downstream surfaces.
 */
export type FacetCommandOutcome =
  | {
      mode: 'disabled';
      message: string;
    }
  | {
      mode: 'cancelled';
      reason: 'no-facets-selected' | 'empty-task' | 'registry-empty' | 'picker-cancelled' | 'task-cancelled';
    }
  | {
      mode: 'dispatched';
      task: string;
      facetIds: readonly string[];
      batch: FacetDispatchBatchResult;
    };

/**
 * Drive the facet dispatch flow end-to-end. Safe to call when facets
 * are disabled — returns a `disabled` outcome without touching the
 * UI beyond a single info toast.
 */
export async function runFacetDispatchCommand(deps: FacetCommandDeps): Promise<FacetCommandOutcome> {
  if (!deps.config.enabled) {
    const message = 'SideCar Facets are disabled. Enable `sidecar.facets.enabled` to dispatch specialists.';
    deps.ui.showInfo(message);
    return { mode: 'disabled', message };
  }

  const outcome = await deps.loadRegistry();
  reportLoaderErrors(deps.ui, outcome);

  const registry = outcome.registry;
  const all = registry.all;
  if (all.length === 0) {
    deps.ui.showError('No facets available — built-in catalog is empty.');
    return { mode: 'cancelled', reason: 'registry-empty' };
  }

  const picks = await deps.ui.showMultiSelectPick(all.map(facetToPickItem), 'Select one or more facets to dispatch');
  if (picks === undefined) {
    return { mode: 'cancelled', reason: 'picker-cancelled' };
  }
  if (picks.length === 0) {
    deps.ui.showInfo('No facets selected — nothing to dispatch.');
    return { mode: 'cancelled', reason: 'no-facets-selected' };
  }
  const facetIds = picks.map((p) => p.id);

  const task = await deps.ui.showInputBox(
    'Task for the selected facets',
    'e.g. "Audit the auth middleware for CSRF gaps"',
  );
  if (task === undefined) {
    return { mode: 'cancelled', reason: 'task-cancelled' };
  }
  const trimmed = task.trim();
  if (trimmed.length === 0) {
    deps.ui.showInfo('Empty task — nothing to dispatch.');
    return { mode: 'cancelled', reason: 'empty-task' };
  }

  const dispatch = deps.dispatch ?? dispatchFacets;
  const client = deps.createClient();
  const signal = deps.signal ?? new AbortController().signal;
  const callbacks = deps.callbacks ?? silentCallbacks();

  try {
    const batch = await dispatch(client, registry, facetIds, callbacks, {
      task: trimmed,
      signal,
      maxConcurrent: deps.config.maxConcurrent,
      rpcTimeoutMs: deps.config.rpcTimeoutMs,
    });
    summarizeBatch(deps.ui, batch);
    return { mode: 'dispatched', task: trimmed, facetIds, batch };
  } catch (err) {
    deps.ui.showError(`Facet dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FacetPickItem {
  label: string;
  description?: string;
  detail?: string;
  id: string;
}

function facetToPickItem(facet: FacetDefinition): FacetPickItem {
  const sourceTag = facet.source === 'builtin' ? '' : ` · ${facet.source}`;
  return {
    label: facet.displayName,
    description: `${facet.id}${sourceTag}`,
    detail: facet.preferredModel ? `model: ${facet.preferredModel}` : undefined,
    id: facet.id,
  };
}

function reportLoaderErrors(ui: FacetCommandUi, outcome: LoadFacetsOutcome): void {
  if (outcome.errors.length === 0) return;
  const summary = outcome.errors
    .slice(0, 3)
    .map((e) => `${e.filePath}: ${e.reason}`)
    .join(' · ');
  const suffix = outcome.errors.length > 3 ? ` (+${outcome.errors.length - 3} more)` : '';
  ui.showError(`Facet load issues: ${summary}${suffix}`);
}

function summarizeBatch(ui: FacetCommandUi, batch: FacetDispatchBatchResult): void {
  const ok = batch.results.filter((r) => r.success).length;
  const failed = batch.results.length - ok;
  const pieces = [`${ok} succeeded`];
  if (failed > 0) pieces.push(`${failed} failed`);
  ui.showInfo(`Facets: ${pieces.join(', ')}.`);
}

function silentCallbacks(): AgentCallbacks {
  return {
    onText: () => undefined,
    onToolCall: () => undefined,
    onToolResult: () => undefined,
    onDone: () => undefined,
  };
}

/**
 * Production UI adapter. Used by `extension.ts` to wire the palette
 * command. Tests substitute their own `FacetCommandUi`.
 */
export function createDefaultFacetCommandUi(): FacetCommandUi {
  return {
    async showMultiSelectPick(items, placeholder) {
      const picked = await window.showQuickPick(items, {
        placeHolder: placeholder,
        canPickMany: true,
      });
      return picked as typeof items | undefined;
    },
    async showInputBox(prompt, placeholder) {
      return window.showInputBox({ prompt, placeHolder: placeholder });
    },
    async showQuickPick(items, placeholder) {
      return window.showQuickPick(items, { placeHolder: placeholder });
    },
    showInfo(message) {
      void window.showInformationMessage(message);
    },
    showError(message) {
      void window.showErrorMessage(message);
    },
  };
}
