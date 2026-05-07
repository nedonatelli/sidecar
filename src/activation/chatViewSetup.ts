import { window, commands, languages, ExtensionContext } from 'vscode';
import { getConfig } from '../config/settings.js';
import { ChatViewProvider } from '../webview/chatView.js';
import { TerminalErrorWatcher } from '../terminal/errorWatcher.js';
import { registerJsDocSync } from '../docs/jsDocSyncProvider.js';
import { registerReadmeSync } from '../docs/readmeSyncProvider.js';
import { registerReviewPanel } from '../agent/reviewPanel.js';
import { registerPinnedMemoryView } from '../views/pinnedMemoryView.js';
import { registerBackgroundAgentsView } from '../views/backgroundAgentsView.js';
import { registerMcpServersView } from '../views/mcpServersView.js';
import { registerSessionsView } from '../views/sessionsView.js';
import { registerEditTimelineView } from '../views/editTimelineView.js';
import { InlineEditProvider } from '../edits/inlineEditProvider.js';
import { PendingEditDecorationProvider } from '../edits/pendingEditDecorationProvider.js';
import type { TerminalManager } from '../terminal/manager.js';
import type { ProposedContentProvider } from '../edits/proposedContentProvider.js';
import type { AgentLogger } from '../agent/logger.js';
import type { MCPManager } from '../agent/mcpManager.js';
import type { WorkspaceIndex } from '../config/workspaceIndex.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import type { SkillLoader } from '../agent/skillLoader.js';

export interface ChatViewSetupDeps {
  terminalManager: TerminalManager;
  proposedContentProvider: ProposedContentProvider;
  agentLogger: AgentLogger;
  mcpManager: MCPManager;
  workspaceIndex: WorkspaceIndex;
  sidecarDir: SidecarDir;
  skillLoader: SkillLoader;
}

/**
 * Create and wire the ChatViewProvider plus all dependent view registrations
 * (inline edit ghost text, diff review panel, pinned memory, pending decorations,
 * terminal error watcher, JSDoc/README sync).
 * Returns the initialized ChatViewProvider.
 * Extracted from extension.ts to keep the entry point under 150 lines.
 */
export function setupChatView(context: ExtensionContext, deps: ChatViewSetupDeps): ChatViewProvider {
  const { terminalManager, proposedContentProvider, agentLogger, mcpManager, workspaceIndex, sidecarDir, skillLoader } =
    deps;

  const inlineEditProvider = new InlineEditProvider();
  context.subscriptions.push(inlineEditProvider);
  context.subscriptions.push(languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineEditProvider));

  context.subscriptions.push(
    commands.registerCommand('sidecar.onInlineEditAccepted', () => {
      inlineEditProvider.accept();
    }),
  );

  const chatProvider = new ChatViewProvider(
    context,
    terminalManager,
    proposedContentProvider,
    agentLogger,
    mcpManager,
    workspaceIndex,
    sidecarDir,
    skillLoader,
    inlineEditProvider,
  );
  context.subscriptions.push(
    window.registerWebviewViewProvider('sidecar.chatView', chatProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
  );

  context.subscriptions.push(registerJsDocSync());
  context.subscriptions.push(registerReadmeSync());
  context.subscriptions.push(registerReviewPanel(context, chatProvider.pendingEditStore, proposedContentProvider));
  context.subscriptions.push(registerPinnedMemoryView(context, chatProvider.state.pinnedMemoryStore));
  context.subscriptions.push(registerEditTimelineView(context, chatProvider.state.editTimeline));
  context.subscriptions.push(registerBackgroundAgentsView(context, chatProvider.backgroundAgentManager));
  context.subscriptions.push(registerMcpServersView(context, mcpManager));
  context.subscriptions.push(
    registerSessionsView(context, chatProvider.state.sessionManager, {
      loadSession: (id) => chatProvider.loadSession(id),
      saveCurrentSession: (name) => chatProvider.saveCurrentSession(name),
    }),
  );

  const pendingDecorations = new PendingEditDecorationProvider(chatProvider.pendingEditStore);
  context.subscriptions.push(window.registerFileDecorationProvider(pendingDecorations), pendingDecorations);

  const terminalErrorWatcher = new TerminalErrorWatcher({
    enabled: () => getConfig().terminalErrorInterception,
    ignoredTerminalNames: new Set(['SideCar']),
    onError: async (event) => {
      const truncated = event.commandLine.length > 60 ? event.commandLine.slice(0, 57) + '...' : event.commandLine;
      const choice = await window.showWarningMessage(
        `Command failed (exit ${event.exitCode}): ${truncated}`,
        'Diagnose in chat',
        'Ignore',
      );
      if (choice === 'Diagnose in chat') {
        await chatProvider.diagnoseTerminalError(event);
      }
    },
  });
  context.subscriptions.push(terminalErrorWatcher);

  return chatProvider;
}
