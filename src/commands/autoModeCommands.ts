import * as path from 'path';
import { window, commands, workspace, ExtensionContext } from 'vscode';
import { getConfig } from '../config/settings.js';
import { runAutoMode, AutoModeStatusBar } from '../agent/autoMode/dispatcher.js';
import { appendFailureLogEntry } from '../agent/autoMode/failureLog.js';
import { runDraftPullRequest, type DraftPrConfig, type DraftPrUi } from '../review/draftPullRequest.js';
import type { SideCarClient } from '../ollama/client.js';
import type { MCPManager } from '../agent/mcpManager.js';
import type { AgentLogger } from '../agent/logger.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import type { ChatViewProvider } from '../webview/chatView.js';
import { chatStreamCallbacks } from '../webview/chatStream.js';

export interface AutoModeCommandDeps {
  createClient: () => SideCarClient;
  getMcpManager: () => MCPManager;
  getAgentLogger: () => AgentLogger;
  getSidecarDir: () => SidecarDir | undefined;
  getChatProvider: () => ChatViewProvider | undefined;
}

/**
 * Register startAutoMode and stopAutoMode commands.
 * Returns the AutoModeStatusBar so the caller can push it to subscriptions.
 * Extracted from extension.ts to keep the entry point under 150 lines.
 */
export function registerAutoModeCommands(context: ExtensionContext, deps: AutoModeCommandDeps): AutoModeStatusBar {
  const { createClient, getMcpManager, getAgentLogger, getSidecarDir, getChatProvider } = deps;

  let autoModeAbortController: AbortController | null = null;
  const autoModeStatusBar = new AutoModeStatusBar();

  context.subscriptions.push(
    commands.registerCommand('sidecar.startAutoMode', async () => {
      if (autoModeAbortController) {
        void window.showWarningMessage('SideCar: Auto Mode is already running.');
        return;
      }

      const cfg = getConfig();
      const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        void window.showErrorMessage('SideCar: No workspace folder open.');
        return;
      }

      const backlogPath = cfg.autoModeBacklogPath.startsWith('.')
        ? path.join(workspaceRoot, cfg.autoModeBacklogPath)
        : cfg.autoModeBacklogPath;

      // This run's own controller. A stopped run can still be finishing when
      // a new one starts, and its onSessionEnd cleared the NEW run's
      // controller -- Stop then did nothing (#115). Only the run that owns the
      // controller clears it.
      const controller = new AbortController();
      autoModeAbortController = controller;
      const signal = controller.signal;

      void runAutoMode(
        createClient(),
        {
          backlogPath,
          maxTasksPerSession: cfg.autoModeMaxTasksPerSession,
          maxRuntimeMs: cfg.autoModeMaxRuntimeMinutes * 60_000,
          haltOnFailure: cfg.autoModeHaltOnFailure,
          interTaskCooldownMs: cfg.autoModeInterTaskCooldownSeconds * 1000,
          mcpManager: getMcpManager(),
          logger: getAgentLogger(),
          abortSignal: signal,
        },
        {
          // Loading on before each task's first chunk, done after it (chatStream.ts).
          ...chatStreamCallbacks((m) => getChatProvider()?.notify(m), { postDoneOnDone: true }),
        },
        {
          onTaskStart: (item, n, total) => {
            autoModeStatusBar.show(n, total);
            getChatProvider()?.notify({
              command: 'autoModeTaskUpdate',
              autoModeTask: { taskN: n, total, text: item.text, status: 'running' },
            });
          },
          onTaskDone: (item, n, total) => {
            getChatProvider()?.notify({
              command: 'autoModeTaskUpdate',
              autoModeTask: { taskN: n, total, text: item.text, status: 'done' },
            });
          },
          onTaskError: (item, err) => {
            const errorMessage = err instanceof Error ? err.message : String(err);
            getChatProvider()?.notify({
              command: 'autoModeTaskUpdate',
              autoModeTask: { taskN: 0, total: 0, text: item.text, status: 'error', errorMessage },
            });
            const dir = getSidecarDir();
            if (dir?.isReady()) {
              const logPath = path.join(dir.getPath('logs'), 'auto-mode-failures.md');
              void appendFailureLogEntry(logPath, { taskText: item.text, errorMessage });
            }
          },
          onSessionEnd: (result) => {
            if (autoModeAbortController === controller) {
              autoModeAbortController = null;
              autoModeStatusBar.hide();
            }
            getChatProvider()?.notify({
              command: 'autoModeDone',
              autoModeResult: {
                stoppedReason: result.stoppedReason,
                tasksSucceeded: result.tasksSucceeded,
                tasksFailed: result.tasksFailed,
              },
            });
            const freshCfg = getConfig();
            if (result.stoppedReason === 'completed' && freshCfg.autoModeAutoOpenPR && workspaceRoot) {
              const headlessUi: DraftPrUi = {
                showInputBox: (_prompt, value) => Promise.resolve(value),
                showConfirm: (_message, _options) => Promise.resolve('Submit'),
                showInfo: (msg) => getChatProvider()?.notify({ command: 'assistantMessage', content: msg }),
                showError: (msg) => getChatProvider()?.notify({ command: 'error', content: msg }),
                openPreview: async () => {},
              };
              const prConfig: DraftPrConfig = {
                draftByDefault: true,
                baseBranch: 'auto',
                template: 'auto',
              };
              void runDraftPullRequest({
                ui: headlessUi,
                client: createClient(),
                cwd: workspaceRoot,
                config: prConfig,
              });
            }
          },
        },
      );
    }),
    commands.registerCommand('sidecar.stopAutoMode', () => {
      if (!autoModeAbortController) {
        void window.showInformationMessage('SideCar: Auto Mode is not running.');
        return;
      }
      autoModeAbortController.abort();
      autoModeAbortController = null;
      autoModeStatusBar.hide();
      void window.showInformationMessage('SideCar: Auto Mode stopped.');
    }),
  );

  return autoModeStatusBar;
}
