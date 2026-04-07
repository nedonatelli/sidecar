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
  ) {
    this._contentProvider = contentProvider;
    this.state = new ChatState(context, terminalManager, agentLogger, mcpManager, (msg) => this.postMessage(msg));
    if (workspaceIndex) {
      this.state.workspaceIndex = workspaceIndex;
    }
    this.state.contentProvider = contentProvider;
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
    this.postMessage({ command: 'setAgentMode', agentMode: getConfig().agentMode });
  }

  private async dispatch(msg: WebviewMessage): Promise<void> {
    switch (msg.command) {
      case 'userMessage':
        if (msg.images && msg.images.length > 0) {
          handleUserMessageWithImages(this.state, msg.text || '', msg.images);
          await handleUserMessage(this.state, '');
        } else {
          await handleUserMessage(this.state, msg.text || '');
        }
        break;
      case 'abort':
        this.state.abort();
        break;
      case 'changeModel':
        const config = getConfig();
        this.state.client.updateConnection(config.baseUrl, config.apiKey);
        this.state.client.updateModel(msg.model || 'llama3');
        const { modelSupportsTools } = await import('../ollama/ollamaBackend.js');
        const supportsTools = modelSupportsTools(msg.model || '');
        this.postMessage({ command: 'setCurrentModel', currentModel: msg.model, supportsTools });
        workspace.getConfiguration('sidecar').update('model', msg.model, true);
        break;
      case 'changeAgentMode':
        await workspace.getConfiguration('sidecar').update('agentMode', msg.agentMode, true);
        this.postMessage({ command: 'setAgentMode', agentMode: msg.agentMode });
        // Auto-resolve any pending confirmation prompts when switching to autonomous
        if (msg.agentMode === 'autonomous') {
          this.state.resolveAllConfirms('Allow');
        }
        break;
      case 'confirmResponse':
        this.state.resolveConfirm(msg.confirmId || '', msg.confirmed ? msg.text : undefined);
        break;
      case 'installModel':
        await handleInstallModel(this.state, msg.model || '');
        break;
      case 'cancelInstall':
        this.state.cancelInstall();
        break;
      case 'attachFile':
        await handleAttachFile(this.state);
        break;
      case 'saveCodeBlock':
        await handleSaveCodeBlock(msg.code || '', msg.language);
        break;
      case 'createFile':
        await handleCreateFile(this.state, msg.code || '', msg.filePath || '');
        break;
      case 'runCommand': {
        const output = await handleRunCommand(this.state, msg.text || '');
        if (output !== null) {
          this.postMessage({ command: 'commandResult', content: output });
        }
        break;
      }
      case 'moveFile':
        await handleMoveFile(this.state, msg.sourcePath || '', msg.destPath || '');
        break;
      case 'github':
        await handleGitHubCommand(this.state, msg);
        break;
      case 'newChat':
        this.state.clearChat();
        break;
      case 'undoChanges':
        await handleUndoChanges(this.state);
        break;
      case 'exportChat':
        await handleExportChat(this.state);
        break;
      case 'executePlan':
        await handleExecutePlan(this.state);
        break;
      case 'revisePlan':
        await handleRevisePlan(this.state, msg.text || '');
        break;
      case 'batch':
        await handleBatch(this.state, msg.text || '');
        break;
      case 'saveSession':
        handleSaveSession(this.state, msg.text || 'Untitled');
        break;
      case 'loadSession':
        handleLoadSession(this.state, msg.text || '');
        break;
      case 'deleteSession':
        handleDeleteSession(this.state, msg.text || '');
        break;
      case 'listSessions':
        handleListSessions(this.state);
        break;
      case 'insight':
        await handleInsight(this.state);
        break;
      case 'spec':
        await handleSpec(this.state, msg.text || '');
        break;
      case 'generateDoc':
        await handleGenerateDoc(this.state);
        break;
      case 'openExternal':
        if (msg.url) {
          env.openExternal(Uri.parse(msg.url));
        }
        break;
      case 'openSettings':
        commands.executeCommand('workbench.action.openSettings', 'sidecar');
        break;
      case 'scanStaged':
        commands.executeCommand('sidecar.scanStaged');
        break;
      case 'usage':
        await handleUsage(this.state);
        break;
      case 'context':
        await handleContext(this.state);
        break;
      case 'generateTests':
        await handleGenerateTests(this.state);
        break;
      case 'lint':
        await handleLint(this.state, msg.text);
        break;
      case 'deps':
        await handleDeps(this.state);
        break;
      case 'scaffold':
        await handleScaffold(this.state, msg.text || '');
        break;
      case 'generateCommit':
        await handleGenerateCommit(this.state);
        break;
      case 'revertFile':
        await handleRevertFile(this.state, msg.filePath || '');
        break;
      case 'acceptAllChanges':
        handleAcceptAllChanges(this.state);
        break;
      case 'deleteMessage':
        handleDeleteMessage(this.state, msg.index ?? -1);
        break;
      case 'toggleVerbose': {
        const current = getConfig().verboseMode;
        workspace.getConfiguration('sidecar').update('verboseMode', !current, true);
        const label = !current ? 'on' : 'off';
        this.state.postMessage({
          command: 'assistantMessage',
          content: `Verbose mode ${label}. ${!current ? 'Agent reasoning will be shown during runs.' : 'Agent reasoning hidden.'}`,
        });
        this.state.postMessage({ command: 'done' });
        break;
      }
      case 'showSystemPrompt':
        await import('./handlers/chatHandlers.js').then(({ handleShowSystemPrompt }) =>
          handleShowSystemPrompt(this.state),
        );
        break;
    }
  }

  public clearChat(): void {
    this.state.clearChat();
  }

  public autoSave(): void {
    this.state.autoSave();
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
