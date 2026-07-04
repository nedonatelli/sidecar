import * as path from 'path';
import { logger } from '../system/logger.js';
import { commands, workspace, ExtensionContext } from 'vscode';
import { EloStore } from '../arena/eloStore.js';
import { openArena, openArenaAgent } from '../arena/arenaCommands.js';
import type { SideCarClient } from '../ollama/client.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import { createDefaultForkReviewUi } from '../agent/fork/forkReview.js';
import type { ForkReviewDeps } from '../agent/fork/forkReview.js';
import { silentCallbacks } from '../agent/diffReview/shared.js';
import type { MCPManager } from '../agent/mcpManager.js';
import * as os from 'os';
import { getConfig } from '../config/settings.js';

/**
 * Register the two arena commands:
 *   sidecar.arena.open  — chat-mode side-by-side comparison
 *   sidecar.arena.agent — agent-mode (fork dispatch with model overrides)
 *
 * The EloStore is created once per session and shared across both commands
 * so ratings accumulate across chat and agent runs.
 */
export function registerArenaCommands(
  context: ExtensionContext,
  createClient: () => SideCarClient,
  sidecarDir: SidecarDir | undefined,
  mcpManager?: MCPManager,
): void {
  const config = getConfig();
  if (!config.arenaEnabled) return;

  const eloPath = sidecarDir
    ? sidecarDir.getPath('arena', 'elo.json')
    : path.join(os.homedir(), '.sidecar', 'arena', 'elo.json');

  const eloStore = new EloStore(eloPath);
  eloStore.load().catch((err) => {
    logger.warn('[SideCar Arena] Failed to load ELO store:', err);
  });

  context.subscriptions.push(
    commands.registerCommand('sidecar.arena.open', () => {
      const cfg = getConfig();
      const defaultModels = cfg.arenaDefaultModels.length >= 2 ? cfg.arenaDefaultModels : undefined;
      return openArena({ context, createClient, eloStore, preFilledModels: defaultModels });
    }),

    commands.registerCommand('sidecar.arena.agent', async (args?: { models?: string[]; task?: string }) => {
      const mainRoot = workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';

      // Use the canonical fork-review UI + the default staged apply-to-main path
      // (diffReview/shared.ts) so Arena winners land exactly like Fork/Facets do —
      // no bespoke unstaged apply that diverges from the single source of truth.
      const reviewDeps: ForkReviewDeps = { ui: createDefaultForkReviewUi(), mainRoot };

      return openArenaAgent(
        { context, createClient, eloStore, preFilledModels: args?.models, preFilledTask: args?.task, mcpManager },
        silentCallbacks(),
        reviewDeps,
      );
    }),
  );
}
