import { window, workspace, languages, commands, ExtensionContext, Disposable, StatusBarAlignment } from 'vscode';
import * as path from 'path';
import { ChatViewProvider } from './webview/chatView.js';
import { TerminalManager } from './terminal/manager.js';
import { SideCarCompletionProvider } from './completions/provider.js';
import {
  isLocalOllama,
  getEnableInlineCompletions,
  getCompletionModel,
  getCompletionMaxTokens,
  getCompletionDebounceMs,
  getModel,
  getBaseUrl,
} from './config/settings.js';
import { createClient } from './ollama/factory.js';
import { ProposedContentProvider } from './edits/proposedContentProvider.js';
import { AgentLogger } from './agent/logger.js';
import { MCPManager } from './agent/mcpManager.js';
import { Scheduler } from './agent/scheduler.js';
import { getMCPServers, getScheduledTasks } from './config/settings.js';
import { handleInlineChat } from './inline/inlineChatProvider.js';
import { reviewCurrentChanges } from './review/reviewer.js';
import { summarizePR } from './review/prSummary.js';
import { generateCommitMessage } from './review/commitMessage.js';
import { EventHookManager } from './agent/eventHooks.js';
import { getEventHooks } from './config/settings.js';
import { WorkspaceIndex } from './config/workspaceIndex.js';
import { getFilePatterns } from './config/workspace.js';

export function activate(context: ExtensionContext) {
  console.log('SideCar extension activating...');

  // Read config once upfront for status bar display
  let cachedModel = getModel();
  let cachedBaseUrl = getBaseUrl();

  const terminalManager = new TerminalManager();
  context.subscriptions.push(terminalManager);

  const proposedContentProvider = new ProposedContentProvider();
  context.subscriptions.push(
    workspace.registerTextDocumentContentProvider('sidecar-proposed', proposedContentProvider),
  );

  const agentLogger = new AgentLogger();
  context.subscriptions.push(agentLogger);

  const mcpManager = new MCPManager();

  // Defer MCP connection — run after activation completes so it doesn't block startup
  const mcpServers = getMCPServers();
  if (Object.keys(mcpServers).length > 0) {
    setImmediate(() => {
      mcpManager.connect(mcpServers).catch((err) => console.error('[SideCar] Failed to connect MCP servers:', err));
    });
  }

  // Reconnect MCP servers when settings change
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.mcpServers')) {
        mcpManager
          .connect(getMCPServers())
          .catch((err) => console.error('[SideCar] Failed to reconnect MCP servers:', err));
      }
    }),
  );

  const workspaceIndex = new WorkspaceIndex();
  context.subscriptions.push(workspaceIndex);

  // Initialize workspace index in the background
  if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
    workspaceIndex
      .initialize(getFilePatterns())
      .then(() => console.log(`[SideCar] Workspace indexed: ${workspaceIndex.getFileCount()} files`))
      .catch((err) => console.error('[SideCar] Workspace indexing failed:', err));
  }

  const provider = new ChatViewProvider(
    context,
    terminalManager,
    proposedContentProvider,
    agentLogger,
    mcpManager,
    workspaceIndex,
  );
  context.subscriptions.push(
    window.registerWebviewViewProvider('sidecar.chatView', provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
  );

  // Keyboard shortcut
  context.subscriptions.push(
    commands.registerCommand('sidecar.toggleChat', () => {
      commands.executeCommand('sidecar.chatView.focus');
    }),
  );

  // Code actions (right-click menu)
  function registerCodeAction(commandId: string, action: string) {
    return commands.registerCommand(commandId, () => {
      const editor = window.activeTextEditor;
      if (!editor) return;
      const selection = editor.document.getText(editor.selection);
      if (!selection) return;
      const fileName = path.basename(editor.document.fileName);
      commands.executeCommand('sidecar.chatView.focus');
      provider.sendCodeAction(action, selection, fileName);
    });
  }

  context.subscriptions.push(
    registerCodeAction('sidecar.explainSelection', 'Explain'),
    registerCodeAction('sidecar.fixSelection', 'Fix'),
    registerCodeAction('sidecar.refactorSelection', 'Refactor'),
  );

  // Inline chat (Cmd+I)
  context.subscriptions.push(
    commands.registerCommand('sidecar.inlineChat', () => {
      handleInlineChat(createClient());
    }),
  );

  // Code review + PR summary
  context.subscriptions.push(
    commands.registerCommand('sidecar.reviewChanges', () => {
      reviewCurrentChanges(createClient());
    }),
    commands.registerCommand('sidecar.summarizePR', () => {
      summarizePR(createClient());
    }),
    commands.registerCommand('sidecar.generateCommitMessage', () => {
      generateCommitMessage(createClient());
    }),
  );

  // Event-based hooks (file save, create, delete)
  const eventHookManager = new EventHookManager(agentLogger);
  const eventHooks = getEventHooks();
  if (eventHooks.onSave || eventHooks.onCreate || eventHooks.onDelete) {
    eventHookManager.start(eventHooks);
  }
  context.subscriptions.push(eventHookManager);

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.eventHooks')) {
        eventHookManager.stop();
        const hooks = getEventHooks();
        if (hooks.onSave || hooks.onCreate || hooks.onDelete) {
          eventHookManager.start(hooks);
        }
      }
    }),
  );

  // Inline completions — only register when enabled (lazy init)
  let completionDisposable: Disposable | null = null;

  function registerCompletions() {
    completionDisposable?.dispose();
    completionDisposable = null;

    if (!getEnableInlineCompletions()) return;

    const completionModel = getCompletionModel() || cachedModel;
    const client = createClient(completionModel);
    const completionProvider = new SideCarCompletionProvider(
      client,
      getCompletionMaxTokens(),
      getCompletionDebounceMs(),
    );

    completionDisposable = languages.registerInlineCompletionItemProvider({ pattern: '**' }, completionProvider);
    context.subscriptions.push(completionDisposable);
  }

  // Only set up completions at startup if actually enabled
  if (getEnableInlineCompletions()) {
    registerCompletions();
  }

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('sidecar.enableInlineCompletions') ||
        e.affectsConfiguration('sidecar.completionModel') ||
        e.affectsConfiguration('sidecar.completionMaxTokens') ||
        e.affectsConfiguration('sidecar.completionDebounceMs')
      ) {
        registerCompletions();
      }
    }),
  );

  // Scheduled tasks
  const scheduler = new Scheduler(agentLogger, mcpManager);
  const scheduledTasks = getScheduledTasks();
  if (scheduledTasks.length > 0) {
    scheduler.start(scheduledTasks);
  }
  context.subscriptions.push(scheduler);

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.scheduledTasks')) {
        scheduler.stop();
        scheduler.start(getScheduledTasks());
      }
    }),
  );

  // Status bar — use cached config values
  const statusBar = window.createStatusBarItem(StatusBarAlignment.Right, 100);
  statusBar.command = 'sidecar.toggleChat';
  statusBar.text = `$(hubot) ${cachedModel.split(':')[0]}`;
  statusBar.tooltip = `SideCar — ${isLocalOllama(cachedBaseUrl) ? 'Ollama' : 'Anthropic'} (${cachedModel})`;
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Invalidate cached config when core settings change
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (
        e.affectsConfiguration('sidecar.model') ||
        e.affectsConfiguration('sidecar.baseUrl') ||
        e.affectsConfiguration('sidecar.apiKey')
      ) {
        cachedModel = getModel();
        cachedBaseUrl = getBaseUrl();
        statusBar.text = `$(hubot) ${cachedModel.split(':')[0]}`;
        statusBar.tooltip = `SideCar — ${isLocalOllama(cachedBaseUrl) ? 'Ollama' : 'Anthropic'} (${cachedModel})`;
      }
    }),
  );

  console.log('SideCar extension activated');
}

export function deactivate() {}
