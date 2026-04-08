import { window, workspace, languages, commands, ExtensionContext, Disposable, StatusBarAlignment } from 'vscode';
import * as path from 'path';
import { ChatViewProvider } from './webview/chatView.js';
import { TerminalManager } from './terminal/manager.js';
import { SideCarCompletionProvider } from './completions/provider.js';
import { getConfig, isLocalOllama } from './config/settings.js';
import { createClient } from './ollama/factory.js';
import { ProposedContentProvider } from './edits/proposedContentProvider.js';
import { AgentLogger } from './agent/logger.js';
import { MCPManager } from './agent/mcpManager.js';
import { Scheduler } from './agent/scheduler.js';
import { handleInlineChat } from './inline/inlineChatProvider.js';
import { reviewCurrentChanges } from './review/reviewer.js';
import { summarizePR } from './review/prSummary.js';
import { generateCommitMessage } from './review/commitMessage.js';
import { EventHookManager } from './agent/eventHooks.js';
import { WorkspaceIndex } from './config/workspaceIndex.js';
import { SidecarDir } from './config/sidecarDir.js';
import { getFilePatterns } from './config/workspace.js';
import { runPreCommitScan } from './agent/preCommitScan.js';
import { disposeShellSession } from './agent/tools.js';

let chatProvider: ChatViewProvider | undefined;

export function activate(context: ExtensionContext) {
  console.log('SideCar extension activating...');

  // Read config once upfront for status bar display
  const config = getConfig();
  let cachedModel = config.model;
  let cachedBaseUrl = config.baseUrl;

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
  const mcpServers = config.mcpServers;
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
          .connect(getConfig().mcpServers)
          .catch((err) => console.error('[SideCar] Failed to reconnect MCP servers:', err));
      }
    }),
  );

  // Initialize .sidecar/ project directory
  const sidecarDir = new SidecarDir();
  if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
    sidecarDir.initialize().then(
      (ok) => ok && console.log('[SideCar] .sidecar/ directory ready'),
      (err) => console.warn('[SideCar] .sidecar/ init failed:', err),
    );
  }

  const workspaceIndex = new WorkspaceIndex();
  context.subscriptions.push(workspaceIndex);

  // Initialize workspace index in the background with progress indicator
  if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
    const indexStatus = window.createStatusBarItem(StatusBarAlignment.Left, 0);
    indexStatus.text = '$(sync~spin) SideCar: Indexing workspace...';
    indexStatus.show();
    context.subscriptions.push(indexStatus);
    workspaceIndex
      .initialize(getFilePatterns())
      .then(() => {
        const count = workspaceIndex.getFileCount();
        console.log(`[SideCar] Workspace indexed: ${count} files`);
        indexStatus.text = `$(check) SideCar: ${count} files indexed`;
        setTimeout(() => indexStatus.dispose(), 5000);
      })
      .catch((err) => {
        console.error('[SideCar] Workspace indexing failed:', err);
        indexStatus.text = '$(warning) SideCar: Indexing failed';
        setTimeout(() => indexStatus.dispose(), 5000);
      });
  }

  // Pre-warm: load the configured model into Ollama's memory so the first
  // chat message doesn't wait for a cold start.  Runs in the background and
  // fails silently — it's a best-effort optimisation.
  if (isLocalOllama(config.baseUrl)) {
    setImmediate(() => {
      const warmUrl = `${config.baseUrl}/api/generate`;
      fetch(warmUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: config.model, prompt: '', keep_alive: '10m' }),
      })
        .then((res) => {
          if (res.ok) {
            console.log(`[SideCar] Pre-warmed model: ${config.model}`);
          } else {
            console.warn(`[SideCar] Pre-warm failed (${res.status}) for ${config.model}`);
          }
        })
        .catch((err) => {
          console.warn('[SideCar] Pre-warm skipped — Ollama may not be running:', err.message);
        });
    });
  }

  chatProvider = new ChatViewProvider(
    context,
    terminalManager,
    proposedContentProvider,
    agentLogger,
    mcpManager,
    workspaceIndex,
    sidecarDir,
  );
  context.subscriptions.push(
    window.registerWebviewViewProvider('sidecar.chatView', chatProvider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    }),
  );

  // Keyboard shortcuts
  context.subscriptions.push(
    commands.registerCommand('sidecar.toggleChat', () => {
      commands.executeCommand('sidecar.chatView.focus');
    }),
    commands.registerCommand('sidecar.clearChat', () => {
      chatProvider?.clearChat();
    }),
    commands.registerCommand('sidecar.undoChanges', () => {
      chatProvider?.undoChanges();
    }),
    commands.registerCommand('sidecar.exportChat', () => {
      chatProvider?.exportChat();
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
      chatProvider?.sendCodeAction(action, selection, fileName);
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
    commands.registerCommand('sidecar.scanStaged', () => {
      runPreCommitScan();
    }),
  );

  // Event-based hooks (file save, create, delete)
  const eventHookManager = new EventHookManager(agentLogger);
  const eventHooks = config.eventHooks;
  if (eventHooks.onSave || eventHooks.onCreate || eventHooks.onDelete) {
    eventHookManager.start(eventHooks);
  }
  context.subscriptions.push(eventHookManager);

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.eventHooks')) {
        eventHookManager.stop();
        const hooks = getConfig().eventHooks;
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

    if (!config.enableInlineCompletions) return;

    const completionModel = config.completionModel || cachedModel;
    const client = createClient(completionModel);
    const completionProvider = new SideCarCompletionProvider(
      client,
      config.completionMaxTokens,
      config.completionDebounceMs,
    );

    completionDisposable = languages.registerInlineCompletionItemProvider({ pattern: '**' }, completionProvider);
    context.subscriptions.push(completionDisposable);
  }

  // Only set up completions at startup if actually enabled
  if (config.enableInlineCompletions) {
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
  const scheduledTasks = config.scheduledTasks;
  if (scheduledTasks.length > 0) {
    scheduler.start(scheduledTasks);
  }
  context.subscriptions.push(scheduler);

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.scheduledTasks')) {
        scheduler.stop();
        scheduler.start(getConfig().scheduledTasks);
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
        const newConfig = getConfig();
        cachedModel = newConfig.model;
        cachedBaseUrl = newConfig.baseUrl;
        statusBar.text = `$(hubot) ${cachedModel.split(':')[0]}`;
        statusBar.tooltip = `SideCar — ${isLocalOllama(cachedBaseUrl) ? 'Ollama' : 'Anthropic'} (${cachedModel})`;
      }
    }),
  );

  console.log('SideCar extension activated');
}

export function deactivate() {
  chatProvider?.autoSave();
  disposeShellSession();
}
