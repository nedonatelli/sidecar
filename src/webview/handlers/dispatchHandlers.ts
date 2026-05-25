/**
 * Webview message dispatch table, extracted from `ChatViewProvider`.
 *
 * `buildDispatchHandlers` returns a map of command → handler so the
 * provider's `dispatch()` method stays a one-liner. Accepting all
 * dependencies as explicit parameters (state, bgManager, globalState,
 * postMessage, setModel) makes every handler testable in isolation
 * without a real WebviewView or ExtensionContext.
 */

import { commands, env, Uri } from 'vscode';
import { getConfig } from '../../config/settings.js';
import { computeUnifiedDiff } from '../../agent/diff.js';
import type { BackgroundAgentManager } from '../../agent/backgroundAgent.js';
import type { ChatState } from '../chatState.js';
import type { WebviewMessage, ExtensionMessage } from '../chatWebview.js';
import type { ExtensionContext } from 'vscode';
import {
  handleUserMessage,
  handleUserMessageWithImages,
  handleAttachFile,
  handleAttachActiveFile,
  handleDroppedPaths,
  handleSaveCodeBlock,
  handleCreateFile,
  handleRunCommand,
  handleMoveFile,
  handleUndoChanges,
  handleExportChat,
  handleGenerateCommit,
  handleRevertFile,
  handleAcceptAllChanges,
  handleDeleteMessage,
  handleEditMessage,
  handleRegenerateResponse,
  isPlanApproval,
  isPlanRejection,
  isUndoRequest,
  isCommitRequest,
  isShowDiffRequest,
} from './chatHandlers.js';
import { handleRequestFileCompletion } from './fileHandlers.js';
import { handleGitHubCommand } from './githubHandlers.js';
import { loadModels, handleInstallModel } from './modelHandlers.js';
import {
  handleExecutePlan,
  handleRevisePlan,
  handleBatch,
  handleSpec,
  handleGenerateDoc,
  handleResume,
  handleGenerateTests,
  handleScaffold,
  handleExplainToolDecision,
  handleInit,
  handleCompactContext,
} from './agentHandlers.js';
import {
  handleInsight,
  handleUsage,
  handleContext,
  handleLint,
  handleDeps,
  handleAudit,
  handleInsights,
  handleMcpStatus,
  handleListMemories,
  handleSearchMemories,
  handleToggleVerbose,
  handleListSkills,
  handleGetSkillsForMenu,
} from './infoHandlers.js';
import {
  handleSaveSession,
  handleLoadSession,
  handleDeleteSession,
  handleListSessions,
  handleBranchSession,
  handleResearchCommand,
} from './sessionHandlers.js';
import { handleNotebookStart, handleNotebookExit } from './notebookHandlers.js';

export interface HandlerDeps {
  state: ChatState;
  bgManager: BackgroundAgentManager;
  globalState: ExtensionContext['globalState'];
  postMessage: (msg: ExtensionMessage) => void;
  /** Called by the `changeModel` handler — injected so callers can swap in a mock. */
  setModel: (model: string) => Promise<void>;
}

/** Whitelist of VS Code commands the webview's empty-state card may invoke. */
const ALLOWED_EXTENSION_COMMANDS = new Set([
  'sidecar.setApiKey',
  'sidecar.switchBackend',
  'sidecar.showSpend',
  'sidecar.discoverModels',
  'sidecar.clearChat',
  'sidecar.exportChat',
  'workbench.action.quickOpen',
]);

/**
 * Build the full command→handler dispatch map for the chat webview.
 * Every dependency comes through `HandlerDeps` so handlers can be
 * exercised in unit tests by injecting stubs.
 */
export function buildDispatchHandlers(
  deps: HandlerDeps,
): Record<string, (msg: WebviewMessage) => void | Promise<void>> {
  const { state, bgManager, globalState, postMessage, setModel } = deps;

  return {
    userMessage: async (msg) => {
      if (msg.images && msg.images.length > 0) {
        handleUserMessageWithImages(state, msg.text || '', msg.images);
        await handleUserMessage(state, '');
        return;
      }
      const text = msg.text || '';

      // /branch [name] — fork current conversation into a new named thread.
      const branchMatch = text.match(/^\/branch(?:\s+(.+))?$/i);
      if (branchMatch) {
        await handleBranchSession(state, branchMatch[1]);
        return;
      }

      // /research [observe <note>] — quick research capture or project switcher.
      const researchMatch = text.match(/^\/research(?:\s+(.+))?$/is);
      if (researchMatch) {
        await handleResearchCommand(state, researchMatch[1]);
        return;
      }
      if (state.pendingPlan) {
        if (isPlanApproval(text)) {
          await handleExecutePlan(state);
          return;
        }
        if (isPlanRejection(text)) {
          state.pendingPlan = null;
          state.pendingPlanMessages = [];
          state.postMessage({
            command: 'assistantMessage',
            content: '\n\nPlan rejected. What would you like to do instead?',
          });
          state.postMessage({ command: 'done' });
          return;
        }
        await handleRevisePlan(state, text);
        return;
      }
      if (isUndoRequest(text)) {
        await handleUndoChanges(state);
        return;
      }
      if (isCommitRequest(text)) {
        await handleGenerateCommit(state);
        return;
      }
      if (isShowDiffRequest(text)) {
        if (state.changelog.hasChanges()) {
          const changes = await state.changelog.getChangeSummary();
          const summaryItems = changes
            .map((c) => ({
              filePath: c.filePath,
              diff: computeUnifiedDiff(c.filePath, c.original, c.current),
              isNew: c.original === null,
              isDeleted: c.current === null,
            }))
            .filter((item) => item.diff.length > 0);
          if (summaryItems.length > 0) {
            state.postMessage({ command: 'changeSummary', changeSummary: summaryItems });
            return;
          }
        }
        state.postMessage({ command: 'assistantMessage', content: 'No changes recorded in this session.' });
        state.postMessage({ command: 'done' });
        return;
      }
      await handleUserMessage(state, text);
    },

    abort: () => state.abort(),

    changeModel: async (msg) => {
      await setModel(msg.model || 'llama3');
    },

    changeAgentMode: async (msg) => {
      if (!msg.agentMode) return;
      const BUILT_IN_MODES = new Set(['cautious', 'autonomous', 'manual', 'plan', 'review', 'audit']);
      const modeConfig = getConfig();
      const validMode =
        BUILT_IN_MODES.has(msg.agentMode) || modeConfig.customModes.some((m) => m.name === msg.agentMode);
      if (!validMode) return;
      await import('vscode').then(({ workspace }) =>
        workspace.getConfiguration('sidecar').update('agentMode', msg.agentMode, true),
      );
      postMessage({
        command: 'setAgentMode',
        agentMode: msg.agentMode,
        customModes: modeConfig.customModes.map((m) => ({ name: m.name, description: m.description })),
      });
      if (msg.agentMode === 'autonomous') {
        state.resolveAllConfirms('Allow');
      }
    },

    confirmResponse: (msg) => state.resolveConfirm(msg.confirmId || '', msg.confirmed ? msg.text : undefined),
    clarifyResponse: (msg) => state.resolveClarification(msg.confirmId || '', msg.text),
    installModel: (msg) => handleInstallModel(state, msg.model || ''),
    cancelInstall: () => state.cancelInstall(),
    attachFile: () => handleAttachFile(state),
    attachActiveFile: () => handleAttachActiveFile(state),
    droppedPaths: (msg) => handleDroppedPaths(state, msg.paths || []),
    saveCodeBlock: (msg) => handleSaveCodeBlock(msg.code || '', msg.language),
    createFile: (msg) => handleCreateFile(state, msg.code || '', msg.filePath || ''),

    runCommand: async (msg) => {
      const output = await handleRunCommand(state, msg.text || '');
      if (output !== null) {
        postMessage({ command: 'commandResult', content: output });
      }
    },

    moveFile: (msg) => handleMoveFile(state, msg.sourcePath || '', msg.destPath || ''),
    github: (msg) => handleGitHubCommand(state, msg),
    newChat: () => state.clearChat(),
    undoChanges: () => handleUndoChanges(state),
    exportChat: () => handleExportChat(state),
    executePlan: () => handleExecutePlan(state),
    revisePlan: (msg) => handleRevisePlan(state, msg.text || ''),
    batch: (msg) => handleBatch(state, msg.text || ''),
    saveSession: (msg) => handleSaveSession(state, msg.text || 'Untitled'),
    loadSession: (msg) => handleLoadSession(state, msg.text || ''),
    deleteSession: (msg) => handleDeleteSession(state, msg.text || ''),
    listSessions: () => handleListSessions(state),
    branchSession: (msg) => handleBranchSession(state, msg.text),
    insight: () => handleInsight(state),
    spec: (msg) => handleSpec(state, msg.text || ''),
    generateDoc: () => handleGenerateDoc(state),

    openExternal: (msg) => {
      if (!msg.url) return;
      const parsed = Uri.parse(msg.url);
      if (parsed.scheme !== 'https' && parsed.scheme !== 'http') return;
      env.openExternal(parsed);
    },

    openSettings: async () => {
      await commands.executeCommand('workbench.action.openSettings', 'sidecar');
    },

    switchBackend: async (msg) => {
      await commands.executeCommand('sidecar.switchBackend', msg.profileId);
    },

    kickstandLoad: async (msg) => {
      if (msg.modelId) {
        const { handleKickstandLoadModel } = await import('./modelHandlers.js');
        await handleKickstandLoadModel(state, msg.modelId);
      }
    },

    kickstandUnload: async (msg) => {
      if (msg.modelId) {
        const { handleKickstandUnloadModel } = await import('./modelHandlers.js');
        await handleKickstandUnloadModel(state, msg.modelId);
      }
    },

    deleteModel: async (msg) => {
      if (msg.model) {
        const { handleDeleteModel } = await import('./modelHandlers.js');
        await handleDeleteModel(state, msg.model);
      }
    },

    reviewChanges: async () => {
      await commands.executeCommand('sidecar.reviewChanges');
    },
    prSummary: async () => {
      await commands.executeCommand('sidecar.summarizePR');
    },
    createDraftPR: async () => {
      await commands.executeCommand('sidecar.pr.create');
    },
    analyzeCi: async () => {
      await commands.executeCommand('sidecar.ci.analyze');
    },
    reviewPrComments: async () => {
      await commands.executeCommand('sidecar.pr.reviewComments');
    },
    respondPrComments: async () => {
      await commands.executeCommand('sidecar.pr.respond');
    },
    markPrReady: async () => {
      await commands.executeCommand('sidecar.pr.markReady');
    },
    checkPrCi: async () => {
      await commands.executeCommand('sidecar.pr.checkCi');
    },
    commitMessage: async () => {
      await commands.executeCommand('sidecar.generateCommitMessage');
    },

    listMemories: () => handleListMemories(state),
    searchMemories: (msg) => handleSearchMemories(state, msg.text || ''),

    scanStaged: async () => {
      await commands.executeCommand('sidecar.scanStaged');
    },

    usage: () => handleUsage(state),
    resume: () => handleResume(state),
    context: () => handleContext(state),
    generateTests: () => handleGenerateTests(state),
    lint: (msg) => handleLint(state, msg.text),
    deps: () => handleDeps(state),
    scaffold: (msg) => handleScaffold(state, msg.text || ''),
    audit: (msg) => handleAudit(state, msg.text || ''),
    insights: () => handleInsights(state),
    explainToolDecision: (msg) => handleExplainToolDecision(state, msg.toolCallId || ''),
    mcpStatus: () => handleMcpStatus(state),
    initProject: () => handleInit(state),

    bgStart: (msg) => {
      const task = msg.text?.trim();
      if (task) {
        const id = bgManager.start(task);
        postMessage({ command: 'assistantMessage', content: `Background agent **${id}** started: "${task}"` });
        postMessage({ command: 'done' });
      }
    },

    arenaStart: async (msg) => {
      const { commands } = await import('vscode');
      await commands.executeCommand('sidecar.arena.open', {
        models: msg.models && msg.models.length >= 2 ? msg.models : undefined,
      });
    },

    arenaAgentStart: async (msg) => {
      const task = msg.text?.trim();
      if (!task) return;
      const { commands } = await import('vscode');
      await commands.executeCommand('sidecar.arena.agent', { task });
    },

    forkStart: async (msg) => {
      const task = msg.text?.trim();
      if (!task) return;
      const { runForkDispatchCommand, createDefaultForkCommandUi } = await import('../../agent/fork/forkCommands.js');
      const { createDefaultForkReviewUi, getWorkspaceMainRoot } = await import('../../agent/fork/forkReview.js');
      const { getConfig: cfg } = await import('../../config/settings.js');
      const { createClient } = await import('../../ollama/factory.js');
      const config = cfg();
      const mainRoot = getWorkspaceMainRoot();
      await runForkDispatchCommand({
        ui: createDefaultForkCommandUi(),
        createClient,
        config: {
          enabled: config.forkEnabled,
          defaultCount: config.forkDefaultCount,
          maxConcurrent: config.forkMaxConcurrent,
        },
        preFilledTask: task,
        reviewDeps: mainRoot ? { ui: createDefaultForkReviewUi(), mainRoot } : undefined,
        onBatchProgress: (state) =>
          postMessage({
            command: 'batchProgress',
            batchProgress: {
              kind: 'forks',
              task: state.task,
              items: state.items,
              doneCount: state.done,
              totalCount: state.total,
            },
          }),
      });
    },

    bgStop: (msg) => {
      bgManager.stop(msg.text || '');
    },
    bgList: () => postMessage({ command: 'bgList', bgRuns: bgManager.list() }),
    bgExpand: (msg) => {
      const run = bgManager.get(msg.text || '');
      if (run) postMessage({ command: 'bgComplete', bgRun: run });
    },

    notebookStart: () => handleNotebookStart(state),
    notebookExit: () => handleNotebookExit(state),
    generateCommit: () => handleGenerateCommit(state),
    revertFile: (msg) => handleRevertFile(state, msg.filePath || ''),
    acceptAllChanges: () => handleAcceptAllChanges(state),
    deleteMessage: (msg) => handleDeleteMessage(state, msg.index ?? -1),
    editMessage: (msg) => handleEditMessage(state, msg.index ?? -1, msg.text ?? ''),
    toggleVerbose: () => handleToggleVerbose(state),
    compactContext: () => handleCompactContext(state),
    listSkills: () => handleListSkills(state),
    getSkillsForMenu: () => handleGetSkillsForMenu(state),

    showSystemPrompt: () =>
      import('./chatHandlers.js').then(({ handleShowSystemPrompt }) => handleShowSystemPrompt(state)),
    reconnect: () => import('./chatHandlers.js').then(({ handleReconnect }) => handleReconnect(state)),
    refreshModels: () => import('./modelHandlers.js').then(({ loadModels }) => loadModels(state)),
    restartOllama: () => import('./chatHandlers.js').then(({ handleRestartOllama }) => handleRestartOllama(state)),

    dismissOnboarding: () => {
      globalState.update('sidecar.onboardingComplete', true);
    },

    executeExtensionCommand: async (msg) => {
      const commandId = msg.commandId;
      const args = msg.args ?? [];
      if (!commandId || !ALLOWED_EXTENSION_COMMANDS.has(commandId)) {
        state.postMessage({
          command: 'error',
          content: `Refused to execute command from webview: ${commandId ?? '(missing)'}`,
        });
        return;
      }
      await commands.executeCommand(commandId, ...args);
    },

    steerEnqueue: (msg) => {
      const queue = state.currentSteerQueue;
      if (!queue) return;
      const trimmed = (msg.text || '').trim();
      if (!trimmed) return;
      try {
        queue.enqueue(trimmed, msg.steerUrgency ?? 'nudge');
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        state.postMessage({ command: 'error', content: `Steer rejected: ${text}` });
      }
    },

    steerCancel: (msg) => {
      state.currentSteerQueue?.cancel(msg.steerId || '');
    },

    steerEdit: (msg) => {
      if (!(msg.text || '').trim()) return;
      try {
        state.currentSteerQueue?.edit(msg.steerId || '', msg.text || '');
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        state.postMessage({ command: 'error', content: `Steer edit rejected: ${text}` });
      }
    },

    stopAutoMode: () => void commands.executeCommand('sidecar.stopAutoMode'),

    requestFileCompletion: () => handleRequestFileCompletion(state),

    regenerateResponse: () => handleRegenerateResponse(state),

    regenSection: async (msg) => {
      const { handleRegenSection } = await import('./chatHandlers.js');
      await handleRegenSection(state, msg.selectedText || '', msg.instruction || '', msg.msgIndex ?? -1);
    },

    // Primary path: webview recorded audio and decoded to PCM Float32 in-browser.
    voiceAudio: async (msg) => {
      const { handleVoiceAudio } = await import('./voiceHandlers.js');
      await handleVoiceAudio(msg, state.postMessage);
    },

    // Fallback path: getUserMedia was blocked in the webview; opens an
    // external browser recording page served by a local HTTP server.
    startVoice: async () => {
      const { handleStartVoice } = await import('./voiceHandlers.js');
      await handleStartVoice(state.postMessage);
    },

    // loadModels is not a webview command but kept here for discoverability;
    // it fires from resolveWebviewView, not from the dispatch table.
    _loadModels: () => loadModels(state),
  };
}
