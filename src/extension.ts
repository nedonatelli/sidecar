import { window, workspace, languages, commands, ExtensionContext, Disposable } from 'vscode';
import * as path from 'path';
import { ChatViewProvider } from './webview/chatView.js';
import { TerminalManager } from './terminal/manager.js';
import { SideCarClient } from './ollama/client.js';
import { SideCarCompletionProvider } from './completions/provider.js';
import { getEnableInlineCompletions, getCompletionModel, getCompletionMaxTokens, getCompletionDebounceMs, getModel, getBaseUrl, getApiKey } from './config/settings.js';
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

export function activate(context: ExtensionContext) {
  console.log('SideCar extension activating...');

  const terminalManager = new TerminalManager();
  context.subscriptions.push(terminalManager);

  const proposedContentProvider = new ProposedContentProvider();
  context.subscriptions.push(
    workspace.registerTextDocumentContentProvider('sidecar-proposed', proposedContentProvider)
  );

  const agentLogger = new AgentLogger();
  context.subscriptions.push(agentLogger);

  const mcpManager = new MCPManager();
  const mcpServers = getMCPServers();
  if (Object.keys(mcpServers).length > 0) {
    mcpManager.connect(mcpServers);
  }

  // Reconnect MCP servers when settings change
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.mcpServers')) {
        mcpManager.connect(getMCPServers());
      }
    })
  );

  const provider = new ChatViewProvider(context, terminalManager, proposedContentProvider, agentLogger, mcpManager);
  context.subscriptions.push(
    window.registerWebviewViewProvider('sidecar.chatView', provider, {
      webviewOptions: {
        retainContextWhenHidden: true,
      },
    })
  );

  // Keyboard shortcut
  context.subscriptions.push(
    commands.registerCommand('sidecar.toggleChat', () => {
      commands.executeCommand('sidecar.chatView.focus');
    })
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
      const inlineClient = new SideCarClient(getModel(), getBaseUrl(), getApiKey());
      handleInlineChat(inlineClient);
    })
  );

  // Code review + PR summary
  context.subscriptions.push(
    commands.registerCommand('sidecar.reviewChanges', () => {
      const reviewClient = new SideCarClient(getModel(), getBaseUrl(), getApiKey());
      reviewCurrentChanges(reviewClient);
    }),
    commands.registerCommand('sidecar.summarizePR', () => {
      const prClient = new SideCarClient(getModel(), getBaseUrl(), getApiKey());
      summarizePR(prClient);
    }),
    commands.registerCommand('sidecar.generateCommitMessage', () => {
      const commitClient = new SideCarClient(getModel(), getBaseUrl(), getApiKey());
      generateCommitMessage(commitClient);
    })
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
    })
  );

  // Inline completions
  let completionDisposable: Disposable | null = null;

  function registerCompletions() {
    completionDisposable?.dispose();
    completionDisposable = null;

    if (!getEnableInlineCompletions()) return;

    const completionModel = getCompletionModel() || getModel();
    const client = new SideCarClient(completionModel, getBaseUrl(), getApiKey());
    const completionProvider = new SideCarCompletionProvider(client, getCompletionMaxTokens(), getCompletionDebounceMs());

    completionDisposable = languages.registerInlineCompletionItemProvider(
      { pattern: '**' },
      completionProvider
    );
    context.subscriptions.push(completionDisposable);
  }

  registerCompletions();

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.enableInlineCompletions') ||
          e.affectsConfiguration('sidecar.completionModel') ||
          e.affectsConfiguration('sidecar.completionMaxTokens') ||
          e.affectsConfiguration('sidecar.completionDebounceMs')) {
        registerCompletions();
      }
    })
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
    })
  );

  console.log('SideCar extension activated');
}

export function deactivate() {}
