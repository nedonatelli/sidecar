import {
  workspace,
  env,
  commands,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
  ExtensionContext,
  Uri,
  CancellationToken,
} from 'vscode';
import { ChatState } from './chatState.js';
import { getChatWebviewHtml, type WebviewMessage, type ExtensionMessage } from './chatWebview.js';
import type { TerminalManager } from '../terminal/manager.js';
import type { ProposedContentProvider } from '../edits/proposedContentProvider.js';
import type { AgentLogger } from '../agent/logger.js';
import type { MCPManager } from '../agent/mcpManager.js';
import type { WorkspaceIndex } from '../config/workspaceIndex.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import type { SkillLoader } from '../agent/skillLoader.js';
import type { InlineEditProvider } from '../edits/inlineEditProvider.js';
import { getConfig } from '../config/settings.js';

// Handler modules
import {
  handleUserMessage,
  handleUserMessageWithImages,
  handleAttachFile,
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
} from './handlers/chatHandlers.js';
import { handleGitHubCommand } from './handlers/githubHandlers.js';
import { loadModels, handleInstallModel } from './handlers/modelHandlers.js';
import {
  handleExecutePlan,
  handleRevisePlan,
  handleBatch,
  handleInsight,
  handleSpec,
  handleGenerateDoc,
  handleUsage,
  handleContext,
  handleGenerateTests,
  handleLint,
  handleDeps,
  handleScaffold,
} from './handlers/agentHandlers.js';
import {
  handleSaveSession,
  handleLoadSession,
  handleDeleteSession,
  handleListSessions,
} from './handlers/sessionHandlers.js';

export class ChatViewProvider implements WebviewViewProvider {
  private webviewView: WebviewView | undefined;
  private state: ChatState;
  // Retained for potential future use (proposed diff views)
  private readonly _contentProvider: ProposedContentProvider;

  constructor(
    private readonly context: ExtensionContext,
    terminalManager: TerminalManager,
    contentProvider: ProposedContentProvider,
    agentLogger: AgentLogger,
    mcpManager: MCPManager,
    workspaceIndex?: WorkspaceIndex,
    sidecarDir?: SidecarDir,
    skillLoader?: SkillLoader,
    inlineEditProvider?: InlineEditProvider,
  ) {
    this._contentProvider = contentProvider;
    this.state = new ChatState(context, terminalManager, agentLogger, mcpManager, (msg) => this.postMessage(msg));
    if (workspaceIndex) {
      this.state.workspaceIndex = workspaceIndex;
    }
    if (sidecarDir) {
      this.state.sidecarDir = sidecarDir;
    }
    if (skillLoader) {
      this.state.skillLoader = skillLoader;
    }
    this.state.contentProvider = contentProvider;
    if (inlineEditProvider) {
      this.state.inlineEditProvider = inlineEditProvider;
    }
  }

  resolveWebviewView(
    webviewView: WebviewView,
    _context: WebviewViewResolveContext,
    _token: CancellationToken,
  ): void | Thenable<void> {
    this.webviewView = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [Uri.joinPath(this.context.extensionUri, 'media')],
    };

    webviewView.webview.html = getChatWebviewHtml(webviewView.webview, this.context.extensionUri);

    webviewView.webview.onDidReceiveMessage(
      async (msg: WebviewMessage) => {
        try {
          await this.dispatch(msg);
        } catch (err: unknown) {
          const text = err instanceof Error ? err.message : String(err);
          this.state.postMessage({ command: 'error', content: text });
        }
      },
      undefined,
      this.context.subscriptions,
    );

    // Auto-save conversation when the webview panel is disposed (e.g. VS Code closed)
    webviewView.onDidDispose(() => {
      this.state.autoSave();
    });

    // Restore chat history
    if (this.state.messages.length === 0) {
      this.state.messages = this.state.loadHistory();
    }
    if (this.state.messages.length > 0) {
      this.postMessage({ command: 'init', messages: this.state.messages });
    }

    loadModels(this.state);
    // Show "plan" in dropdown if plan mode is enabled, otherwise show the approval mode
    const config = getConfig();
    this.postMessage({
      command: 'setAgentMode',
      agentMode: config.planMode ? 'plan' : config.agentMode,
    });

    // Show onboarding card on first launch (no history, never dismissed)
    if (this.state.messages.length === 0 && !this.context.globalState.get('sidecar.onboardingComplete', false)) {
      this.postMessage({ command: 'onboarding' });
    }
  }

  /** Handler map for O(1) command dispatch instead of linear switch. */
  private handlers: Record<string, (msg: WebviewMessage) => void | Promise<void>> = {
    userMessage: async (msg) => {
      if (msg.images && msg.images.length > 0) {
        handleUserMessageWithImages(this.state, msg.text || '', msg.images);
        await handleUserMessage(this.state, '');
      } else {
        await handleUserMessage(this.state, msg.text || '');
      }
    },
    abort: () => this.state.abort(),
    changeModel: async (msg) => {
      const cfg = getConfig();
      this.state.client.updateConnection(cfg.baseUrl, cfg.apiKey);
      this.state.client.updateModel(msg.model || 'llama3');
      const { modelSupportsTools } = await import('../ollama/ollamaBackend.js');
      const supports = modelSupportsTools(msg.model || '');
      this.postMessage({ command: 'setCurrentModel', currentModel: msg.model, supportsTools: supports });
      workspace.getConfiguration('sidecar').update('model', msg.model, true);
    },
    changeAgentMode: async (msg) => {
      const selectedMode = msg.agentMode;
      if (selectedMode === 'plan') {
        // Plan mode selected — enable plan mode and set to cautious approval
        await workspace.getConfiguration('sidecar').update('planMode', true, true);
        await workspace.getConfiguration('sidecar').update('agentMode', 'cautious', true);
        this.postMessage({ command: 'setAgentMode', agentMode: 'plan' });
        this.state.postMessage({
          command: 'assistantMessage',
          content: `Plan mode enabled. For each request, I'll generate a structured plan for your approval before executing any changes.`,
        });
      } else {
        // Normal mode selected — disable plan mode and use the selected approval mode
        await workspace.getConfiguration('sidecar').update('planMode', false, true);
        await workspace.getConfiguration('sidecar').update('agentMode', selectedMode, true);
        this.postMessage({ command: 'setAgentMode', agentMode: selectedMode });
        if (selectedMode === 'autonomous') {
          this.state.resolveAllConfirms('Allow');
        }
      }
    },
    confirmResponse: (msg) => this.state.resolveConfirm(msg.confirmId || '', msg.confirmed ? msg.text : undefined),
    installModel: (msg) => handleInstallModel(this.state, msg.model || ''),
    cancelInstall: () => this.state.cancelInstall(),
    attachFile: () => handleAttachFile(this.state),
    saveCodeBlock: (msg) => handleSaveCodeBlock(msg.code || '', msg.language),
    createFile: (msg) => handleCreateFile(this.state, msg.code || '', msg.filePath || ''),
    runCommand: async (msg) => {
      const output = await handleRunCommand(this.state, msg.text || '');
      if (output !== null) {
        this.postMessage({ command: 'commandResult', content: output });
      }
    },
    moveFile: (msg) => handleMoveFile(this.state, msg.sourcePath || '', msg.destPath || ''),
    github: (msg) => handleGitHubCommand(this.state, msg),
    newChat: () => this.state.clearChat(),
    undoChanges: () => handleUndoChanges(this.state),
    exportChat: () => handleExportChat(this.state),
    executePlan: () => handleExecutePlan(this.state),
    revisePlan: (msg) => handleRevisePlan(this.state, msg.text || ''),
    batch: (msg) => handleBatch(this.state, msg.text || ''),
    saveSession: (msg) => handleSaveSession(this.state, msg.text || 'Untitled'),
    loadSession: (msg) => handleLoadSession(this.state, msg.text || ''),
    deleteSession: (msg) => handleDeleteSession(this.state, msg.text || ''),
    listSessions: () => handleListSessions(this.state),
    insight: () => handleInsight(this.state),
    spec: (msg) => handleSpec(this.state, msg.text || ''),
    generateDoc: () => handleGenerateDoc(this.state),
    openExternal: (msg) => {
      if (msg.url) env.openExternal(Uri.parse(msg.url));
    },
    openSettings: async () => {
      await commands.executeCommand('workbench.action.openSettings', 'sidecar');
    },
    scanStaged: async () => {
      await commands.executeCommand('sidecar.scanStaged');
    },
    usage: () => handleUsage(this.state),
    context: () => handleContext(this.state),
    generateTests: () => handleGenerateTests(this.state),
    lint: (msg) => handleLint(this.state, msg.text),
    deps: () => handleDeps(this.state),
    scaffold: (msg) => handleScaffold(this.state, msg.text || ''),
    generateCommit: () => handleGenerateCommit(this.state),
    revertFile: (msg) => handleRevertFile(this.state, msg.filePath || ''),
    acceptAllChanges: () => handleAcceptAllChanges(this.state),
    deleteMessage: (msg) => handleDeleteMessage(this.state, msg.index ?? -1),
    toggleVerbose: () => {
      const current = getConfig().verboseMode;
      workspace.getConfiguration('sidecar').update('verboseMode', !current, true);
      const label = !current ? 'on' : 'off';
      this.state.postMessage({
        command: 'assistantMessage',
        content: `Verbose mode ${label}. ${!current ? 'Agent reasoning will be shown during runs.' : 'Agent reasoning hidden.'}`,
      });
      this.state.postMessage({ command: 'done' });
    },
    togglePlanMode: () => {
      const current = getConfig().planMode;
      workspace.getConfiguration('sidecar').update('planMode', !current, true);
      const label = !current ? 'ON' : 'OFF';
      this.state.postMessage({
        command: 'assistantMessage',
        content: !current
          ? `Plan mode ${label}. The agent will generate a structured plan before executing any tools. You can review, revise, or execute the plan.`
          : `Plan mode ${label}. The agent will execute tasks directly.`,
      });
      this.state.postMessage({ command: 'done' });
    },
    compactContext: async () => {
      const msgCount = this.state.messages.length;
      if (msgCount < 4) {
        this.state.postMessage({
          command: 'assistantMessage',
          content: 'Context is already minimal — nothing to compact.',
        });
        this.state.postMessage({ command: 'done' });
        return;
      }

      this.state.postMessage({
        command: 'assistantMessage',
        content: 'Compacting conversation context...',
      });

      try {
        const { ConversationSummarizer } = await import('../agent/conversationSummarizer.js');
        const summarizer = new ConversationSummarizer(this.state.client);
        const result = await summarizer.summarize(this.state.messages, {
          keepRecentTurns: 2,
          minCharsToSave: 500,
          maxSummaryLength: 1200,
          summaryTimeoutMs: 15000,
        });

        if (result.freedChars > 0) {
          this.state.messages.splice(0, this.state.messages.length, ...result.messages);
          this.state.saveHistory();
          const tokensFreed = Math.round(result.freedChars / 4);
          this.state.postMessage({
            command: 'assistantMessage',
            content: `Compacted: ${result.metadata.turnsSummarized}/${result.metadata.turnsCount} turns summarized, ~${tokensFreed} tokens freed. The conversation context is now smaller and the model will respond faster.`,
          });
        } else {
          this.state.postMessage({
            command: 'assistantMessage',
            content: 'Context is already compact — not enough old turns to summarize.',
          });
        }
      } catch (err) {
        this.state.postMessage({
          command: 'assistantMessage',
          content: `Compaction failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      this.state.postMessage({ command: 'done' });
    },
    listSkills: () => {
      const list = this.state.skillLoader?.listFormatted() || 'No skills loaded.';
      this.state.postMessage({ command: 'assistantMessage', content: list });
      this.state.postMessage({ command: 'done' });
    },
    getSkillsForMenu: () => {
      const skills = this.state.skillLoader?.getAll() || [];
      const items = skills.map((s) => ({ id: s.id, name: s.name, description: s.description }));
      this.state.postMessage({ command: 'skillsMenu', skills: items });
    },
    showSystemPrompt: () =>
      import('./handlers/chatHandlers.js').then(({ handleShowSystemPrompt }) => handleShowSystemPrompt(this.state)),
    reconnect: () => import('./handlers/chatHandlers.js').then(({ handleReconnect }) => handleReconnect(this.state)),
    dismissOnboarding: () => {
      this.context.globalState.update('sidecar.onboardingComplete', true);
    },
  };

  private async dispatch(msg: WebviewMessage): Promise<void> {
    const handler = this.handlers[msg.command];
    if (handler) await handler(msg);
  }

  public clearChat(): void {
    this.state.clearChat();
  }

  public autoSave(): void {
    this.state.autoSave();
  }

  /** Abort any running agent loops. Call on extension deactivate. */
  public abort(): void {
    this.state.abort();
  }

  public async undoChanges(): Promise<void> {
    await handleUndoChanges(this.state);
  }

  public async exportChat(): Promise<void> {
    await handleExportChat(this.state);
  }

  public async sendCodeAction(action: string, code: string, fileName: string): Promise<void> {
    const prompt = `${action} this code from ${fileName}:\n\`\`\`\n${code}\n\`\`\``;
    if (this.webviewView) {
      this.webviewView.show(true);
    }
    this.postMessage({ command: 'addUserMessage', content: prompt });
    await handleUserMessage(this.state, prompt);
  }

  private postMessage(message: ExtensionMessage): void {
    this.webviewView?.webview.postMessage(message);
  }
}
