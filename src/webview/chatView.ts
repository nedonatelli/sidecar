import {
  workspace,
  window,
  commands,
  WebviewView,
  WebviewViewProvider,
  WebviewViewResolveContext,
  ExtensionContext,
  Uri,
  CancellationToken,
  type TextEditor,
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
import type { PlanCheckpoint } from '../agent/plans/planStore.js';
import type { SkillLoader } from '../agent/skillLoader.js';
import type { InlineEditProvider } from '../edits/inlineEditProvider.js';
import type { BackgroundAgentManager } from '../agent/backgroundAgent.js';
import { getConfig, detectActiveProfile } from '../config/settings.js';
import { handleUserMessage } from './handlers/chatHandlers.js';
import { buildCodeActionPrompt, buildTerminalErrorPrompt } from './codeActions.js';
import {
  buildUiSettingsMessage,
  buildAgentModeMessage,
  buildActiveFileMessage,
  UI_CONFIG_KEYS,
} from './chatViewLifecycle.js';
import { handleUndoChanges, handleExportChat } from './handlers/chatHandlers.js';
import { handleLoadSession, handleBranchSession } from './handlers/sessionHandlers.js';
import { loadModels } from './handlers/modelHandlers.js';
import { initializeChatSubsystems } from './chatStateInit.js';
import { setModel, refreshOpenRouterCostsIfActive } from './modelSwitcher.js';
import { buildDispatchHandlers } from './handlers/dispatchHandlers.js';

export class ChatViewProvider implements WebviewViewProvider {
  private webviewView: WebviewView | undefined;
  private _state: ChatState;
  private bgManager: BackgroundAgentManager;
  private handlers: Record<string, (msg: WebviewMessage) => void | Promise<void>>;

  get pendingEditStore(): PendingEditStore {
    return this.state.pendingEdits;
  }

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
    this._state = new ChatState(context, terminalManager, agentLogger, mcpManager, (msg) => this.postMessage(msg));

    if (workspaceIndex) this.state.workspaceIndex = workspaceIndex;
    if (sidecarDir) {
      this.state.sidecarDir = sidecarDir;
      this.state.metricsCollector.init(sidecarDir);
    }
    if (skillLoader) this.state.skillLoader = skillLoader;
    this.state.contentProvider = contentProvider;
    if (inlineEditProvider) this.state.inlineEditProvider = inlineEditProvider;

    this.bgManager = initializeChatSubsystems(this._state, getConfig(), sidecarDir, agentLogger, mcpManager, (msg) =>
      this.postMessage(msg),
    );

    this.handlers = buildDispatchHandlers({
      state: this._state,
      bgManager: this.bgManager,
      globalState: context.globalState,
      postMessage: (msg) => this.postMessage(msg),
      setModel: (model) => this.setModel(model),
    });
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
          this.state.postMessage({ command: 'error', content: err instanceof Error ? err.message : String(err) });
        }
      },
      undefined,
      this.context.subscriptions,
    );

    webviewView.onDidDispose(() => {
      this.state.saveHistory();
      this.state.autoSave();
    });

    if (this.state.messages.length === 0) this.state.messages = this.state.loadHistory();
    if (this.state.messages.length > 0) this.postMessage({ command: 'init', messages: this.state.messages });

    loadModels(this.state);
    const initConfig = getConfig();
    this.postMessage(
      buildAgentModeMessage({
        agentMode: initConfig.agentMode,
        customModes: initConfig.customModes.map((m) => ({ name: m.name, description: m.description })),
      }),
    );
    this.pushUiSettings();

    this.context.subscriptions.push(
      workspace.onDidChangeConfiguration((e) => {
        if (UI_CONFIG_KEYS.some((k) => e.affectsConfiguration(k))) {
          this.pushUiSettings();
        }
        if (e.affectsConfiguration('sidecar.modelRouting')) this.state.refreshModelRouter();
        if (e.affectsConfiguration('sidecar.baseUrl') || e.affectsConfiguration('sidecar.provider')) {
          this.pushActiveBackendProfile();
        }
      }),
    );

    // Keep the active-file bar in sync with the focused editor.
    const pushActiveFile = (editor: TextEditor | undefined): void => {
      const filePath = editor && !editor.document.isUntitled ? editor.document.fileName : undefined;
      this.postMessage(buildActiveFileMessage(filePath));
    };
    pushActiveFile(window.activeTextEditor);
    this.context.subscriptions.push(window.onDidChangeActiveTextEditor(pushActiveFile));
  }

  private pushUiSettings(): void {
    this.postMessage(buildUiSettingsMessage(getConfig()));
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
  public getAuditLog() {
    return this.state.auditLog;
  }
  public get client() {
    return this.state.client;
  }

  public get backgroundAgentManager(): BackgroundAgentManager {
    return this.bgManager;
  }

  public loadSession(id: string): void {
    handleLoadSession(this._state, id);
  }

  public saveCurrentSession(name: string): void {
    this._state.sessionManager.save(name, this._state.messages);
  }

  public branchCurrentSession(name?: string): void {
    void handleBranchSession(this._state, name);
  }

  public pushActiveBackendProfile(): void {
    const cfg = getConfig();
    const activeProfile = detectActiveProfile(cfg.baseUrl);
    this.state.postMessage({ command: 'setActiveBackendProfile', activeBackendProfileId: activeProfile?.id ?? null });
  }

  public reloadModels(): void {
    const cfg = getConfig();
    this.state.client.updateConnection(cfg.baseUrl, cfg.apiKey);
    void loadModels(this.state);
    this.pushActiveBackendProfile();
    void refreshOpenRouterCostsIfActive(cfg.baseUrl, cfg.apiKey);
  }

  public async setModel(model: string): Promise<void> {
    await setModel(this._state, (msg) => this.postMessage(msg), model);
  }

  public async sendCodeAction(action: string, code: string, fileName: string, diagnostic?: string): Promise<void> {
    const prompt = buildCodeActionPrompt(action, code, fileName, diagnostic);
    if (this.webviewView) this.webviewView.show(true);
    this.postMessage({ command: 'addUserMessage', content: prompt });
    await handleUserMessage(this.state, prompt);
  }

  public async resumeFromCheckpoint(checkpoint: PlanCheckpoint): Promise<void> {
    this._state.messages = [...checkpoint.messages];
    this.postMessage({ command: 'init', messages: checkpoint.messages });
    if (this.webviewView) this.webviewView.show(true);
    const resumePrompt = '(Resuming previous task. Continue where you left off.)';
    this.postMessage({ command: 'addUserMessage', content: resumePrompt });
    await handleUserMessage(this.state, resumePrompt);
  }

  public async diagnoseTerminalError(event: {
    commandLine: string;
    exitCode: number;
    cwd: string | undefined;
    output: string;
  }): Promise<void> {
    const prompt = buildTerminalErrorPrompt(event);
    if (this.webviewView) this.webviewView.show(true);
    this.postMessage({ command: 'addUserMessage', content: prompt });
    await handleUserMessage(this.state, prompt);
  }

  private postMessage(message: ExtensionMessage): void {
    this.webviewView?.webview.postMessage(message);
  }

  notify(message: ExtensionMessage): void {
    this.postMessage(message);
  }

  public injectPrompt(prompt: string): void {
    this.webviewView?.show(true);
    this.postMessage({ command: 'injectPrompt', content: prompt });
  }

  /** Expose so `sidecar.stopAutoMode` command handler can stop via command palette. */
  public stopAutoMode(): void {
    void commands.executeCommand('sidecar.stopAutoMode');
  }
}
