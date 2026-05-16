import * as vscode from 'vscode';
import type { SideCarClient } from '../ollama/client.js';
import type { EloStore } from './eloStore.js';
import { ArenaPanel } from './arenaPanel.js';
import type { ForkReviewDeps } from '../agent/fork/forkReview.js';
import type { AgentCallbacks } from '../agent/loop.js';

// ---------------------------------------------------------------------------
// Arena commands — chat mode + agent mode entry points.
//
// `openArena`: QuickPick model selection → open / reveal ArenaPanel.
// `openArenaAgent`: QuickPick model + task → dispatch forks with model
//   overrides (agent mode) → record ELO winner from fork review outcome.
//
// Both are extracted from the registration site so they're injectable
// and testable without VS Code APIs.
// ---------------------------------------------------------------------------

export interface ArenaCommandDeps {
  context: vscode.ExtensionContext;
  createClient: () => SideCarClient;
  eloStore: EloStore;
  /** Pre-filled models from `/arena` slash command. Skip QuickPick when set. */
  preFilledModels?: string[];
  /** Pre-filled task for agent mode. */
  preFilledTask?: string;
}

// ---------------------------------------------------------------------------
// Chat arena
// ---------------------------------------------------------------------------

export async function openArena(deps: ArenaCommandDeps): Promise<void> {
  const client = deps.createClient();
  let models = deps.preFilledModels;

  if (!models || models.length < 2) {
    models = await pickModels(client);
    if (!models) return; // cancelled
  }

  ArenaPanel.create(deps.context, client, deps.eloStore, models, () => pickModels(client));
}

// ---------------------------------------------------------------------------
// Agent arena (model-vs-model using Fork dispatcher with model overrides)
// ---------------------------------------------------------------------------

export async function openArenaAgent(
  deps: ArenaCommandDeps,
  callbacks: AgentCallbacks,
  reviewDeps: ForkReviewDeps,
): Promise<void> {
  const client = deps.createClient();

  let models = deps.preFilledModels;
  if (!models || models.length < 2) {
    models = await pickModels(client, { minCount: 2, label: 'agent arena' });
    if (!models) return;
  }

  const task =
    deps.preFilledTask ??
    (await vscode.window.showInputBox({
      prompt: 'Task for model arena (agent mode)',
      placeHolder: 'e.g. "add input validation to the login form"',
    }));
  if (!task?.trim()) return;

  // Lazy-import to avoid loading the heavy fork dispatcher at activate time.
  const { dispatchForks } = await import('../agent/fork/forkDispatcher.js');
  const { reviewForkBatch } = await import('../agent/fork/forkReview.js');

  const ctrl = new AbortController();
  const labels = models.map((m) => shortLabel(m));

  const batch = await dispatchForks(client, callbacks, {
    task: task.trim(),
    numForks: models.length,
    maxConcurrent: models.length,
    signal: ctrl.signal,
    labels,
    // Per-fork model overrides: each fork runs with its own model.
    agentOptions: {
      approvalMode: 'autonomous',
    },
    modelOverrides: models,
  });

  const review = await reviewForkBatch(batch, reviewDeps);

  // Record ELO if the user picked a winner.
  if (review.winnerIndex !== null && review.appliedOk) {
    const winnerIdx = review.winnerIndex;
    const winner = models[winnerIdx];
    const losers = models.filter((_, i) => i !== winnerIdx);
    if (winner && losers.length > 0) {
      await deps.eloStore.recordWin(winner, losers);
      void vscode.window.showInformationMessage(
        `Arena: ${shortLabel(winner)} wins! ELO → ${deps.eloStore.getRating(winner)}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function pickModels(
  client: SideCarClient,
  opts: { minCount?: number; label?: string } = {},
): Promise<string[] | undefined> {
  const { minCount = 2 } = opts;
  let installedNames: string[] = [];
  try {
    const installed = await client.listInstalledModels();
    installedNames = installed.map((m) => m.name);
  } catch {
    // Backend unreachable — let the user type model names manually.
  }

  // If we have models, show a multi-select QuickPick.
  if (installedNames.length > 0) {
    const items: vscode.QuickPickItem[] = installedNames.map((name) => ({
      label: name,
      picked: false,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: `Pick at least ${minCount} models to compare`,
      title: 'SideCar Arena — select models',
    });

    if (!picked || picked.length < minCount) {
      if (picked && picked.length > 0 && picked.length < minCount) {
        void vscode.window.showWarningMessage(`Arena needs at least ${minCount} models.`);
      }
      return undefined;
    }
    return picked.map((p) => p.label);
  }

  // Fallback: free-text entry (comma-separated).
  const input = await vscode.window.showInputBox({
    prompt: 'Enter model names separated by commas',
    placeHolder: 'e.g. llama3.2:3b, qwen3:8b',
    validateInput: (v) => {
      const parts = v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      return parts.length >= minCount ? null : `Enter at least ${minCount} model names`;
    },
  });
  if (!input) return undefined;
  const models = input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return models.length >= minCount ? models : undefined;
}

function shortLabel(model: string): string {
  const parts = model.split(':');
  if (parts.length < 2) return model;
  const tag = parts[1].split('-')[0];
  return `${parts[0]}:${tag}`;
}
