import * as path from 'path';
import { window, workspace, commands, languages, ExtensionContext, Disposable } from 'vscode';
import { getConfig } from '../config/settings.js';
import { checkWorkspaceConfigTrust } from '../config/workspaceTrust.js';
import { handleInlineChat } from '../inline/inlineChatProvider.js';
import { EventHookManager } from '../agent/eventHooks.js';
import { Scheduler } from '../agent/scheduler.js';
import { initCustomToolsTrust } from '../agent/tools.js';
import { SideCarCompletionProvider, NextEditEngine } from '../completions/provider.js';
import { SidecarCodeActionProvider } from '../edits/sidecarCodeActionProvider.js';
import {
  AdaptivePasteTracker,
  AdaptivePasteCodeActionProvider,
  registerAdaptivePasteCommand,
} from '../edits/adaptivePaste.js';
import type { SideCarClient } from '../ollama/client.js';
import type { AgentLogger } from '../agent/logger.js';
import type { MCPManager } from '../agent/mcpManager.js';
import type { SymbolIndexer } from '../config/symbolIndexer.js';
import type { SideCarConfig } from '../config/settings.js';
import type { ChatViewProvider } from '../webview/chatView.js';

export interface EditorFeatureDeps {
  getChatProvider: () => ChatViewProvider | undefined;
  createClient: (modelOverride?: string) => SideCarClient;
  agentLogger: AgentLogger;
  mcpManager: MCPManager;
  symbolIndexer: SymbolIndexer;
}

interface CodeActionArgs {
  code?: string;
  fileName?: string;
  diagnostic?: string;
}

/**
 * Register code actions, inline completions, next-edit engine, event hooks,
 * and the scheduled-task runner.
 * Extracted from extension.ts to keep the entry point under 150 lines.
 */
export function registerEditorFeatures(
  context: ExtensionContext,
  config: SideCarConfig,
  deps: EditorFeatureDeps,
): void {
  const { getChatProvider, createClient, agentLogger, mcpManager, symbolIndexer } = deps;

  // Code actions (right-click menu + lightbulb)
  function registerCodeAction(commandId: string, action: string) {
    return commands.registerCommand(commandId, (args?: CodeActionArgs) => {
      let code = args?.code;
      let fileName = args?.fileName;
      const diagnostic = args?.diagnostic;

      if (!code || !fileName) {
        const editor = window.activeTextEditor;
        if (!editor) return;
        const fallbackCode = editor.document.getText(editor.selection);
        if (!fallbackCode) return;
        code = fallbackCode;
        fileName = path.basename(editor.document.fileName);
      }

      commands.executeCommand('sidecar.chatView.focus');
      getChatProvider()?.sendCodeAction(action, code, fileName, diagnostic);
    });
  }

  context.subscriptions.push(
    registerCodeAction('sidecar.explainSelection', 'Explain'),
    registerCodeAction('sidecar.fixSelection', 'Fix'),
    registerCodeAction('sidecar.refactorSelection', 'Refactor'),
    languages.registerCodeActionsProvider({ scheme: 'file' }, new SidecarCodeActionProvider(), {
      providedCodeActionKinds: SidecarCodeActionProvider.providedCodeActionKinds,
    }),
  );

  if (config.adaptivePasteEnabled) {
    const pasteTracker = new AdaptivePasteTracker();
    context.subscriptions.push(
      pasteTracker,
      registerAdaptivePasteCommand(createClient(), pasteTracker),
      languages.registerCodeActionsProvider({ scheme: 'file' }, new AdaptivePasteCodeActionProvider(pasteTracker), {
        providedCodeActionKinds: AdaptivePasteCodeActionProvider.providedCodeActionKinds,
      }),
    );
  }

  context.subscriptions.push(
    commands.registerCommand('sidecar.inlineChat', () => {
      handleInlineChat(createClient());
    }),
  );

  // Event-based hooks (file save, create, delete)
  const eventHookManager = new EventHookManager(agentLogger, () => getChatProvider()?.getAuditLog() ?? null);
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

  // Inline completions — only register when enabled (lazy re-register on config change)
  let completionDisposable: Disposable | null = null;

  function registerCompletions() {
    completionDisposable?.dispose();
    completionDisposable = null;

    const liveConfig = getConfig();
    if (!liveConfig.enableInlineCompletions) return;

    const completionModel = liveConfig.completionModel || liveConfig.model;
    const client = createClient(completionModel);
    const completionProvider = new SideCarCompletionProvider(
      client,
      liveConfig.completionMaxTokens,
      liveConfig.completionDebounceMs,
    );

    completionDisposable = languages.registerInlineCompletionItemProvider({ pattern: '**' }, completionProvider);
    context.subscriptions.push(completionDisposable);
  }

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

  // Next Edit Suggestions engine
  if (config.nextEditEnabled) {
    const nextEditEngine = new NextEditEngine(symbolIndexer.getGraph());
    context.subscriptions.push(nextEditEngine);
  }

  // Scheduled tasks
  const scheduler = new Scheduler(agentLogger, mcpManager);
  context.subscriptions.push(scheduler);

  const startSchedulerGated = async (tasks: typeof config.scheduledTasks): Promise<void> => {
    if (tasks.length === 0) return;
    const trust = await checkWorkspaceConfigTrust(
      'scheduledTasks',
      'SideCar: This workspace defines scheduled tasks that will run an autonomous agent loop on a timer. Only trust these from repositories you control.',
    );
    if (trust === 'blocked') {
      console.log('[SideCar] Workspace scheduledTasks blocked by user');
      return;
    }
    scheduler.start(tasks);
  };

  if (config.scheduledTasks.length > 0) {
    void startSchedulerGated(config.scheduledTasks);
  }

  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.scheduledTasks')) {
        scheduler.stop();
        void startSchedulerGated(getConfig().scheduledTasks);
      }
      if (e.affectsConfiguration('sidecar.customTools')) {
        void initCustomToolsTrust();
      }
    }),
  );

  void initCustomToolsTrust();
}
