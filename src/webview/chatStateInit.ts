/**
 * Subsystem initialization extracted from `ChatViewProvider` constructor.
 *
 * `initializeChatSubsystems` wires all optional services (documentation
 * indexer, agent memory, pinned memory, audit log) onto a `ChatState`
 * instance and constructs the `BackgroundAgentManager`. Keeping this logic
 * in a standalone function makes it testable without a real webview context.
 */

import { window, commands, workspace } from 'vscode';
import { BackgroundAgentManager } from '../agent/backgroundAgent.js';
import { notifyBgComplete } from '../agent/bgNotifier.js';
import { ContextProviderManager } from '../context/contextProviderManager.js';
import { DocumentationIndexer } from '../config/documentationIndexer.js';
import { SidecarMdIndex } from '../agent/sidecarMdIndex.js';
import { AgentMemory } from '../agent/agentMemory.js';
import { PinnedMemoryStore } from '../agent/memory/pinnedMemory.js';
import { TeamMemoryStore } from '../agent/memory/teamMemory.js';
import { AuditLog } from '../agent/auditLog.js';
import type { AgentLogger } from '../agent/logger.js';
import type { MCPManager } from '../agent/mcpManager.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import type { SideCarConfig } from '../config/settings.js';
import type { ChatState } from './chatState.js';
import type { ExtensionMessage } from './chatWebview.js';

/**
 * Wire optional subsystems onto `state` and return the constructed
 * `BackgroundAgentManager`. The manager is returned (not assigned onto
 * state) because it's owned directly by `ChatViewProvider` and must be
 * disposed separately from the `ChatState` lifecycle.
 */
export function initializeChatSubsystems(
  state: ChatState,
  config: SideCarConfig,
  sidecarDir: SidecarDir | undefined,
  agentLogger: AgentLogger,
  mcpManager: MCPManager,
  postMessage: (msg: ExtensionMessage) => void,
): BackgroundAgentManager {
  if (config.contextProviders?.length) {
    const root = workspace.workspaceFolders?.[0]?.uri.fsPath ?? '';
    state.contextProviderManager = new ContextProviderManager(config.contextProviders, undefined, root);
  }

  if (config.enableDocumentationRAG) {
    state.documentationIndexer = new DocumentationIndexer();
    state.documentationIndexer.initialize().catch((err) => {
      console.warn('Failed to initialize documentation indexer:', err);
    });
  }

  if (config.sidecarMdMode === 'retrieval' && sidecarDir) {
    state.sidecarMdIndex = new SidecarMdIndex(sidecarDir);
    state.sidecarMdIndex.restore().catch((err) => {
      console.warn('Failed to restore SIDECAR.md index:', err);
    });
  }

  if (config.enableAgentMemory && sidecarDir) {
    state.agentMemory = new AgentMemory(sidecarDir.getPath());
    state.agentMemory.load().catch((err) => {
      console.warn('Failed to load agent memory:', err);
    });
  }

  if (config.pinnedMemoryEnabled && sidecarDir) {
    state.pinnedMemoryStore = new PinnedMemoryStore(sidecarDir.getPath());
    state.pinnedMemoryStore.load().catch((err) => {
      console.warn('Failed to load pinned memory:', err);
    });
  }

  if (sidecarDir) {
    state.teamMemoryStore = new TeamMemoryStore(sidecarDir.getPath());
    state.teamMemoryStore.load().catch((err) => {
      console.warn('Failed to load team memory:', err);
    });
  }

  if (sidecarDir) {
    const sessionId = state.agentMemory?.getSessionId() || `s-${Date.now()}`;
    state.auditLog = new AuditLog(sidecarDir, sessionId, config.model, config.agentMode);
  }

  return new BackgroundAgentManager(
    {
      onStatusChange: (run) => postMessage({ command: 'bgStatusUpdate', bgRun: run }),
      onOutput: (runId, chunk) => postMessage({ command: 'bgOutput', bgRunId: runId, content: chunk }),
      onComplete: (run) => {
        postMessage({ command: 'bgComplete', bgRun: run });
        const summary =
          run.status === 'completed'
            ? `Background task **"${run.task}"** completed (${run.toolCalls} tool calls).\n\n${run.output.slice(0, 500)}${run.output.length > 500 ? '…' : ''}`
            : `Background task **"${run.task}"** failed: ${run.error}`;
        postMessage({ command: 'assistantMessage', content: summary });
        postMessage({ command: 'done' });
        notifyBgComplete(run, {
          showInformationMessage: window.showInformationMessage.bind(window),
          showErrorMessage: window.showErrorMessage.bind(window),
          executeCommand: commands.executeCommand.bind(commands),
        });
      },
    },
    agentLogger,
    mcpManager,
  );
}
