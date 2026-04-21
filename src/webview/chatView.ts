import {
  workspace,
  window,
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
import type { PendingEditStore } from '../agent/pendingEdits.js';
import { getChatWebviewHtml, type WebviewMessage, type ExtensionMessage } from './chatWebview.js';
import type { TerminalManager } from '../terminal/manager.js';
import type { ProposedContentProvider } from '../edits/proposedContentProvider.js';
import type { AgentLogger } from '../agent/logger.js';
import type { MCPManager } from '../agent/mcpManager.js';
import type { WorkspaceIndex } from '../config/workspaceIndex.js';
import type { SidecarDir } from '../config/sidecarDir.js';
import type { SkillLoader } from '../agent/skillLoader.js';
import { CHARS_PER_TOKEN } from '../config/constants.js';
import type { InlineEditProvider } from '../edits/inlineEditProvider.js';
import { getConfig } from '../config/settings.js';
import { DocumentationIndexer } from '../config/documentationIndexer.js';
import { AgentMemory } from '../agent/agentMemory.js';
import { PinnedMemoryStore } from '../agent/memory/pinnedMemory.js';
import { AuditLog } from '../agent/auditLog.js';
import { BackgroundAgentManager } from '../agent/backgroundAgent.js';
import { wrapUntrustedTerminalOutput } from '../agent/injectionScanner.js';

// Handler modules
import {
  handleUserMessage,
  handleUserMessageWithImages,
  handleAttachFile,
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
  handleResume,
  handleContext,
  handleGenerateTests,
  handleLint,
  handleDeps,
  handleScaffold,
  handleAudit,
  handleInsights,
  handleExplainToolDecision,
  handleMcpStatus,
  handleInit,
} from './handlers/agentHandlers.js';
import {
  handleSaveSession,
  handleLoadSession,
  handleDeleteSession,
  handleListSessions,
} from './handlers/sessionHandlers.js';

export class ChatViewProvider implements WebviewViewProvider {
  private webviewView: WebviewView | undefined;
  private _state: ChatState;
  // Retained for potential future use (proposed diff views)
  private readonly _contentProvider: ProposedContentProvider;
  private bgManager: BackgroundAgentManager;

  /** Exposed so the review panel can share the same pending-edit store. */
  get pendingEditStore(): PendingEditStore {
    return this.state.pendingEdits;
  }

  /** Exposed so extension.ts can wire the pinned memory view to the same store instance. */
  get state(): ChatState {
    return this._state;
  }

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
    this._state = new ChatState(context, terminalManager, agentLogger, mcpManager, (msg) => this.postMessage(msg));
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

    // Initialize RAG documentation indexer
    const config = getConfig();
    if (config.enableDocumentationRAG) {
      this.state.documentationIndexer = new DocumentationIndexer();
      // Initialize asynchronously without blocking
      this.state.documentationIndexer.initialize().catch((err) => {
        console.warn('Failed to initialize documentation indexer:', err);
      });
    }

    // Initialize agent memory
    if (config.enableAgentMemory && sidecarDir) {
      this.state.agentMemory = new AgentMemory(sidecarDir.getPath());
      this.state.agentMemory.load().catch((err) => {
        console.warn('Failed to load agent memory:', err);
      });
    }

    // Initialize pinned memory store
    if (config.pinnedMemoryEnabled && sidecarDir) {
      this._state.pinnedMemoryStore = new PinnedMemoryStore(sidecarDir.getPath());
      this._state.pinnedMemoryStore.load().catch((err) => {
        console.warn('Failed to load pinned memory:', err);
      });
    }

    // Initialize audit log
    if (sidecarDir) {
      const sessionId = this.state.agentMemory?.getSessionId() || `s-${Date.now()}`;
      this.state.auditLog = new AuditLog(sidecarDir, sessionId, config.model, config.agentMode);
    }

    // Initialize background agent manager
    this.bgManager = new BackgroundAgentManager(
      {
        onStatusChange: (run) => this.postMessage({ command: 'bgStatusUpdate', bgRun: run }),
        onOutput: (runId, chunk) => this.postMessage({ command: 'bgOutput', bgRunId: runId, content: chunk }),
        onComplete: (run) => {
          this.postMessage({ command: 'bgComplete', bgRun: run });
          const summary =
            run.status === 'completed'
              ? `Background task **"${run.task}"** completed (${run.toolCalls} tool calls).\n\n${run.output.slice(0, 500)}${run.output.length > 500 ? '…' : ''}`
              : `Background task **"${run.task}"** failed: ${run.error}`;
          this.postMessage({ command: 'assistantMessage', content: summary });
          this.postMessage({ command: 'done' });
        },
      },
      agentLogger,
      mcpManager,
    );
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
    const initConfig = getConfig();
    this.postMessage({
      command: 'setAgentMode',
      agentMode: initConfig.agentMode,
      customModes: initConfig.customModes.map((m) => ({ name: m.name, description: m.description })),
    });
    this.pushUiSettings();

    // Re-push UI settings when the user changes chat theme/density/font without
    // reloading the webview.
    this.context.subscriptions.push(
      workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration('sidecar.chatDensity') ||
          e.affectsConfiguration('sidecar.chatFontSize') ||
          e.affectsConfiguration('sidecar.chatAccentColor')
        ) {
          this.pushUiSettings();
        }
        if (e.affectsConfiguration('sidecar.modelRouting')) {
          this.state.refreshModelRouter();
        }
      }),
    );

    // The persistent empty-state welcome card in the webview handles
    // the first-launch experience now — it renders whenever the chat
    // is empty, on every load, and automatically hides when the first
    // message arrives. No need to post an 'onboarding' trigger.
  }

  /**
   * Push chat UI theme settings (density, font size, accent color) to the
   * webview so it can apply them as CSS custom properties.
   */
  private pushUiSettings(): void {
    const cfg = getConfig();
    this.postMessage({
      command: 'uiSettings',
      chatDensity: cfg.chatDensity,
      chatFontSize: cfg.chatFontSize,
      chatAccentColor: cfg.chatAccentColor,
    });
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
      await this.setModel(msg.model || 'llama3');
    },
    changeAgentMode: async (msg) => {
      await workspace.getConfiguration('sidecar').update('agentMode', msg.agentMode, true);
      const modeConfig = getConfig();
      this.postMessage({
        command: 'setAgentMode',
        agentMode: msg.agentMode,
        customModes: modeConfig.customModes.map((m) => ({ name: m.name, description: m.description })),
      });
      if (msg.agentMode === 'autonomous') {
        this.state.resolveAllConfirms('Allow');
      }
    },
    confirmResponse: (msg) => this.state.resolveConfirm(msg.confirmId || '', msg.confirmed ? msg.text : undefined),
    clarifyResponse: (msg) => this.state.resolveClarification(msg.confirmId || '', msg.text),
    installModel: (msg) => handleInstallModel(this.state, msg.model || ''),
    cancelInstall: () => this.state.cancelInstall(),
    attachFile: () => handleAttachFile(this.state),
    droppedPaths: (msg) => handleDroppedPaths(this.state, msg.paths || []),
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
    switchBackend: async (msg) => {
      await commands.executeCommand('sidecar.switchBackend', msg.profileId);
    },
    kickstandLoad: async (msg) => {
      if (msg.modelId) {
        const { handleKickstandLoadModel } = await import('./handlers/modelHandlers.js');
        await handleKickstandLoadModel(this.state, msg.modelId);
      }
    },
    kickstandUnload: async (msg) => {
      if (msg.modelId) {
        const { handleKickstandUnloadModel } = await import('./handlers/modelHandlers.js');
        await handleKickstandUnloadModel(this.state, msg.modelId);
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
    listMemories: async () => {
      if (!this.state.agentMemory) {
        this.state.postMessage({
          command: 'assistantMessage',
          content: 'Agent memory is not enabled. Set `sidecar.enableAgentMemory` to true.\n\n',
        });
        return;
      }
      const memories = this.state.agentMemory.queryAll();
      if (memories.length === 0) {
        this.state.postMessage({ command: 'assistantMessage', content: 'No agent memories stored yet.\n\n' });
        return;
      }
      const byType = new Map<string, number>();
      for (const m of memories) byType.set(m.type, (byType.get(m.type) ?? 0) + 1);
      const stats = this.state.agentMemory.getStats();
      let content = `**Agent Memories** — ${memories.length} entries\n\n`;
      content += `| Type | Count |\n|------|-------|\n`;
      for (const [type, count] of byType) content += `| ${type} | ${count} |\n`;
      content += `\nTotal entries: ${stats.totalCount}. Use \`/memory-search <query>\` to search.\n\n`;
      this.state.postMessage({ command: 'assistantMessage', content });
    },
    searchMemories: async (msg) => {
      if (!this.state.agentMemory || !msg.text) {
        this.state.postMessage({
          command: 'assistantMessage',
          content: 'Agent memory is not enabled or no query provided.\n\n',
        });
        return;
      }
      const results = this.state.agentMemory.search(msg.text, undefined, 10);
      if (results.length === 0) {
        this.state.postMessage({ command: 'assistantMessage', content: `No memories found for "${msg.text}".\n\n` });
        return;
      }
      let content = `**Memory search:** "${msg.text}" — ${results.length} results\n\n`;
      for (const m of results) {
        content += `- **[${m.type}]** ${m.content.slice(0, 120)}${m.content.length > 120 ? '...' : ''} *(used ${m.useCount}x)*\n`;
      }
      content += '\n';
      this.state.postMessage({ command: 'assistantMessage', content });
    },
    scanStaged: async () => {
      await commands.executeCommand('sidecar.scanStaged');
    },
    usage: () => handleUsage(this.state),
    resume: () => handleResume(this.state),
    context: () => handleContext(this.state),
    generateTests: () => handleGenerateTests(this.state),
    lint: (msg) => handleLint(this.state, msg.text),
    deps: () => handleDeps(this.state),
    scaffold: (msg) => handleScaffold(this.state, msg.text || ''),
    audit: (msg) => handleAudit(this.state, msg.text || ''),
    insights: () => handleInsights(this.state),
    explainToolDecision: (msg) => handleExplainToolDecision(this.state, msg.toolCallId || ''),
    mcpStatus: () => handleMcpStatus(this.state),
    initProject: () => handleInit(this.state),
    bgStart: (msg) => {
      const task = msg.text?.trim();
      if (task) {
        const id = this.bgManager.start(task);
        this.postMessage({ command: 'assistantMessage', content: `Background agent **${id}** started: "${task}"` });
        this.postMessage({ command: 'done' });
      }
    },
    forkStart: async (msg) => {
      const task = msg.text?.trim();
      if (!task) return;
      const { runForkDispatchCommand, createDefaultForkCommandUi } = await import('../agent/fork/forkCommands.js');
      const { createDefaultForkReviewUi, getWorkspaceMainRoot } = await import('../agent/fork/forkReview.js');
      const { getConfig } = await import('../config/settings.js');
      const { createClient } = await import('../ollama/factory.js');
      const cfg = getConfig();
      const mainRoot = getWorkspaceMainRoot();
      await runForkDispatchCommand({
        ui: createDefaultForkCommandUi(),
        createClient,
        config: {
          enabled: cfg.forkEnabled,
          defaultCount: cfg.forkDefaultCount,
          maxConcurrent: cfg.forkMaxConcurrent,
        },
        preFilledTask: task,
        reviewDeps: mainRoot ? { ui: createDefaultForkReviewUi(), mainRoot } : undefined,
      });
    },
    bgStop: (msg) => {
      this.bgManager.stop(msg.text || '');
    },
    bgList: () => this.postMessage({ command: 'bgList', bgRuns: this.bgManager.list() }),
    bgExpand: (msg) => {
      const run = this.bgManager.get(msg.text || '');
      if (run) this.postMessage({ command: 'bgComplete', bgRun: run });
    },
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
          const tokensFreed = Math.round(result.freedChars / CHARS_PER_TOKEN);
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
    executeExtensionCommand: async (msg) => {
      // Whitelist of commands the empty-state welcome card (and any
      // other webview-initiated button) is allowed to invoke directly
      // through the extension host. Gated so the webview can't execute
      // arbitrary VS Code commands — a compromised webview would
      // otherwise be able to run anything.
      const allowed = new Set([
        'sidecar.setApiKey',
        'sidecar.switchBackend',
        'sidecar.showSpend',
        'sidecar.discoverModels',
        'sidecar.clearChat',
        'sidecar.exportChat',
        'workbench.action.quickOpen',
      ]);
      const commandId = msg.commandId;
      const args = msg.args ?? [];
      if (!commandId || !allowed.has(commandId)) {
        this.state.postMessage({
          command: 'error',
          content: `Refused to execute command from webview: ${commandId ?? '(missing)'}`,
        });
        return;
      }
      await commands.executeCommand(commandId, ...args);
    },
    steerEnqueue: (msg) => this.handleSteerEnqueue(msg.text || '', msg.steerUrgency),
    steerCancel: (msg) => this.handleSteerCancel(msg.steerId || ''),
    steerEdit: (msg) => this.handleSteerEdit(msg.steerId || '', msg.text || ''),
  };

  private handleSteerEnqueue(text: string, urgency: 'nudge' | 'interrupt' | undefined): void {
    const queue = this.state.currentSteerQueue;
    if (!queue) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      queue.enqueue(trimmed, urgency ?? 'nudge');
    } catch (err) {
      // SteerQueueFullError (all-interrupts) and empty-text errors
      // surface to the user as a non-blocking error toast.
      const msg = err instanceof Error ? err.message : String(err);
      this.state.postMessage({ command: 'error', content: `Steer rejected: ${msg}` });
    }
  }

  private handleSteerCancel(id: string): void {
    this.state.currentSteerQueue?.cancel(id);
  }

  private handleSteerEdit(id: string, newText: string): void {
    if (!newText.trim()) return;
    try {
      this.state.currentSteerQueue?.edit(id, newText);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.state.postMessage({ command: 'error', content: `Steer edit rejected: ${msg}` });
    }
  }

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

  public dispose(): void {
    this.bgManager.dispose();
    this.state.dispose();
  }

  public async undoChanges(): Promise<void> {
    await handleUndoChanges(this.state);
  }

  public async exportChat(): Promise<void> {
    await handleExportChat(this.state);
  }

  /** Active SideCar client — exposed so the Quick Pick model switcher
   *  (and any other palette command) can list models without poking
   *  into `state` directly. */
  public get client() {
    return this.state.client;
  }

  /** Refresh the model list after a backend profile switch. */
  public reloadModels(): void {
    const cfg = getConfig();
    this.state.client.updateConnection(cfg.baseUrl, cfg.apiKey);
    void loadModels(this.state);
    // If the active backend is OpenRouter, pull the catalog so the
    // cost tracker can price its full menagerie of fully-qualified
    // model ids (anthropic/claude-sonnet-4.5, openai/gpt-4o, etc.)
    // that won't match any substring in the static modelCosts.json.
    // Fire-and-forget — cost tracking is best-effort telemetry and
    // must not block the model list refresh.
    void this.refreshOpenRouterCostsIfActive(cfg.baseUrl, cfg.apiKey);
  }

  /**
   * Fetch the OpenRouter catalog and feed it into the runtime cost
   * overlay. No-op when the active backend isn't OpenRouter.
   */
  private async refreshOpenRouterCostsIfActive(baseUrl: string, apiKey: string): Promise<void> {
    const { detectProvider, ingestOpenRouterCatalog } = await import('../config/settings.js');
    if (detectProvider(baseUrl, getConfig().provider) !== 'openrouter') return;
    try {
      const { OpenRouterBackend } = await import('../ollama/openrouterBackend.js');
      const backend = new OpenRouterBackend(baseUrl, apiKey);
      const catalog = await backend.listOpenRouterModels();
      const registered = ingestOpenRouterCatalog(catalog);
      if (registered > 0 && getConfig().verboseMode) {
        console.log(`[SideCar openrouter] ingested pricing for ${registered} models from the catalog`);
      }
    } catch (err) {
      console.warn('[SideCar openrouter] failed to refresh cost catalog:', err);
    }
  }

  /**
   * Shared entry point for changing the active model. Called by the
   * webview dropdown (`changeModel` handler) and the `sidecar.selectModel`
   * command so keyboard-first and click-first model switching go through
   * the exact same reconnect + probe + persist path.
   *
   * For local Ollama we verify that the requested model is actually
   * installed before persisting to global settings. Without this guard,
   * typing a not-yet-pulled name into the custom-model input silently
   * writes the name to `sidecar.model`, so every subsequent chat turn
   * hits Ollama's `/api/chat` with a model it doesn't have and 404s —
   * a soft-bricked state that's hard to diagnose because the dropdown
   * happily displays the stuck name. Remote backends (Anthropic, OpenAI,
   * OpenRouter, etc.) don't have an "installed" concept, so we skip the
   * check and trust the provider.
   */
  public async setModel(model: string): Promise<void> {
    if (!model) return;
    const cfg = getConfig();
    this.state.client.updateConnection(cfg.baseUrl, cfg.apiKey);

    if (this.state.client.isLocalOllama()) {
      try {
        const installed = await this.state.client.listInstalledModels();
        const hit = installed.some((m) => m.name === model || m.name.split(':')[0] === model.split(':')[0]);
        if (!hit) {
          const action = await window.showWarningMessage(
            `SideCar: ${model} is not installed in Ollama. Install it first, then select it.`,
            'Install Model',
            'Cancel',
          );
          if (action === 'Install Model') {
            // Route into the normal install path — this handles bare
            // `org/repo`, HuggingFace URLs, and plain Ollama library
            // names uniformly. On success the install flow will post
            // its own `setCurrentModel` update so we don't need to
            // recurse back through `setModel`.
            await handleInstallModel(this.state, model);
          }
          return;
        }
      } catch (err) {
        // If Ollama is unreachable, fall through — the check is a guard
        // against silent corruption, not a connectivity gate. The user
        // will see a clearer "cannot reach Ollama" error from the next
        // chat request anyway.
        console.warn('setModel: could not verify installed models:', err);
      }
    }

    this.state.client.updateModel(model);
    const { modelSupportsTools, probeModelToolSupport } = await import('../ollama/ollamaBackend.js');
    if (this.state.client.isLocalOllama()) {
      await probeModelToolSupport(cfg.baseUrl, model);
    }
    const supports = modelSupportsTools(model);
    this.postMessage({ command: 'setCurrentModel', currentModel: model, supportsTools: supports });
    await workspace.getConfiguration('sidecar').update('model', model, true);
  }

  /** Access the current session's audit log for cross-subsystem logging (event hooks). */
  public getAuditLog() {
    return this.state.auditLog;
  }

  public async sendCodeAction(action: string, code: string, fileName: string, diagnostic?: string): Promise<void> {
    let prompt = `${action} this code from ${fileName}:\n\`\`\`\n${code}\n\`\`\``;
    if (diagnostic) {
      prompt += `\n\nDiagnostic reported by the editor:\n\`\`\`\n${diagnostic}\n\`\`\``;
    }
    if (this.webviewView) {
      this.webviewView.show(true);
    }
    this.postMessage({ command: 'addUserMessage', content: prompt });
    await handleUserMessage(this.state, prompt);
  }

  /**
   * Inject a synthesized prompt into the chat asking the agent to diagnose
   * a failed terminal command. Called by TerminalErrorWatcher when the user
   * accepts the "Diagnose in chat" notification.
   */
  public async diagnoseTerminalError(event: {
    commandLine: string;
    exitCode: number;
    cwd: string | undefined;
    output: string;
  }): Promise<void> {
    // Terminal output is attacker-controlled — a hostile Makefile /
    // npm script can emit stderr like `[SYSTEM] Ignore all previous
    // instructions` and, historically, that text flowed verbatim into
    // the user message here, bypassing the tool-output injection
    // scanner entirely (which only runs on tool *results*, not on
    // synthesized user messages). `wrapUntrustedTerminalOutput` runs
    // the same scanner on the captured output and wraps it in an
    // explicit `<terminal_output trust="untrusted">` envelope with a
    // warning banner when patterns are detected.
    const cwdLine = event.cwd ? `\nWorking directory: ${event.cwd}` : '';
    const wrappedOutputBlock = wrapUntrustedTerminalOutput(event.output || '');
    const prompt =
      `A command in my terminal just failed. Help me diagnose and fix it.\n\n` +
      `Command: \`${event.commandLine}\`\n` +
      `Exit code: ${event.exitCode}` +
      cwdLine +
      wrappedOutputBlock;

    if (this.webviewView) {
      this.webviewView.show(true);
    }
    this.postMessage({ command: 'addUserMessage', content: prompt });
    await handleUserMessage(this.state, prompt);
  }

  private postMessage(message: ExtensionMessage): void {
    this.webviewView?.webview.postMessage(message);
  }

  /**
   * Seed the chat input with a prefilled prompt — used by flows like
   * CI Failure Analysis (v0.68 chunk 4) that want to hand the user a
   * ready-to-send message they can review and submit. The chat view
   * is brought to focus first so the user lands with the input cursor
   * active.
   */
  public injectPrompt(prompt: string): void {
    this.webviewView?.show(true);
    this.postMessage({ command: 'injectPrompt', content: prompt });
  }
}
