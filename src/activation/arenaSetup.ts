import * as path from 'path';
import { logger } from '../system/logger.js';
import { commands, window, Uri, workspace, ExtensionContext } from 'vscode';
import { EloStore } from '../arena/eloStore.js';
import { openArena, openArenaAgent } from '../arena/arenaCommands.js';
import type { SideCarClient } from '../ollama/client.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import type { ForkReviewDeps } from '../agent/fork/forkReview.js';
import type { MCPManager } from '../agent/mcpManager.js';
import { GitCLI } from '../github/git.js';
import * as os from 'os';
import * as fsPromises from 'fs/promises';
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

      const reviewDeps: ForkReviewDeps = {
        ui: {
          showQuickPick: (items, placeholder) =>
            window.showQuickPick(items, { placeHolder: placeholder }) as Promise<(typeof items)[0] | undefined>,
          showWarningConfirm: (message, confirmLabel) =>
            Promise.resolve(window.showWarningMessage(message, { modal: true }, confirmLabel)),
          showInfo: (msg) => {
            void window.showInformationMessage(msg);
          },
          showError: (msg) => {
            void window.showErrorMessage(msg);
          },
          openDiff: async (left: Uri, right: Uri, title: string) => {
            await commands.executeCommand('vscode.diff', left, right, title);
          },
        },
        mainRoot,
        applyDiff: async (_root: string, diff: string) => {
          const git = new GitCLI(mainRoot);
          return git.applyPatch(diff);
        },
        writeTempFile: async (prefix: string, content: string) => {
          const tmpPath = path.join(os.tmpdir(), `sidecar-arena-${prefix}-${Date.now()}.patch`);
          await fsPromises.writeFile(tmpPath, content, 'utf-8');
          return Uri.file(tmpPath);
        },
      };

      const silentCallbacks = {
        onText: () => undefined,
        onToolCall: () => undefined,
        onToolResult: () => undefined,
        onDone: () => undefined,
      };

      return openArenaAgent(
        { context, createClient, eloStore, preFilledModels: args?.models, preFilledTask: args?.task, mcpManager },
        silentCallbacks,
        reviewDeps,
      );
    }),
  );
}
