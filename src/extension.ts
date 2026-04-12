import { window, workspace, languages, commands, ExtensionContext, Disposable, StatusBarAlignment } from 'vscode';
import * as path from 'path';
import { ChatViewProvider } from './webview/chatView.js';
import { TerminalManager } from './terminal/manager.js';
import { TerminalErrorWatcher } from './terminal/errorWatcher.js';
import { SideCarCompletionProvider } from './completions/provider.js';
import {
  getConfig,
  isLocalOllama,
  isKickstand,
  detectProvider,
  readKickstandToken,
  initSecrets,
  setApiKeySecret,
} from './config/settings.js';
import { checkWorkspaceConfigTrust } from './config/workspaceTrust.js';
import { createClient } from './ollama/factory.js';
import { SideCarClient } from './ollama/client.js';
import { ProposedContentProvider } from './edits/proposedContentProvider.js';
import { AgentLogger } from './agent/logger.js';
import { MCPManager, loadProjectMcpConfig, mergeMcpConfigs } from './agent/mcpManager.js';
import { Scheduler } from './agent/scheduler.js';
import { handleInlineChat } from './inline/inlineChatProvider.js';
import { setGrammarsPath } from './parsing/registry.js';
import { reviewCurrentChanges } from './review/reviewer.js';
import { summarizePR } from './review/prSummary.js';
import { generateCommitMessage } from './review/commitMessage.js';
import { EventHookManager } from './agent/eventHooks.js';
import { WorkspaceIndex } from './config/workspaceIndex.js';
import { SidecarDir } from './config/sidecarDir.js';
import { SymbolIndexer } from './config/symbolIndexer.js';
import { SkillLoader } from './agent/skillLoader.js';
import { getFilePatterns } from './config/workspace.js';
import { runPreCommitScan } from './agent/preCommitScan.js';
import { disposeShellSession, setSymbolGraph } from './agent/tools.js';
import { disposeSidecarMdWatcher } from './webview/handlers/chatHandlers.js';
import { InlineEditProvider } from './edits/inlineEditProvider.js';

let chatProvider: ChatViewProvider | undefined;

export function activate(context: ExtensionContext) {
  console.log('SideCar extension activating...');

  // Set grammars path for tree-sitter (lazy-loaded on first parse)
  const grammarsPath = path.join(context.extensionPath, 'grammars');
  setGrammarsPath(grammarsPath);

  // Initialize SecretStorage and migrate any plaintext API keys.
  // Fire-and-forget: subsequent getConfig() calls pick up the cached secrets.
  initSecrets(context).catch((err) => {
    console.warn('[SideCar] Failed to initialize secrets:', err);
  });

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
  context.subscriptions.push(mcpManager);

  // Defer MCP connection — run after activation completes so it doesn't block startup
  // Merge configs from VS Code settings + .mcp.json project file
  // Warn if MCP configs come from workspace settings (supply-chain risk: they spawn processes)
  const connectMcp = async () => {
    try {
      const settingsServers = getConfig().mcpServers;
      const workspaceRoot = workspace.workspaceFolders?.[0]?.uri.fsPath;
      const projectServers = workspaceRoot ? await loadProjectMcpConfig(workspaceRoot) : {};
      const allServers = mergeMcpConfigs(projectServers, settingsServers);

      if (Object.keys(allServers).length === 0) return;

      const trust = await checkWorkspaceConfigTrust(
        'mcpServers',
        'SideCar: This workspace defines MCP server configs that may spawn external processes. Only trust these from repositories you control.',
      );
      if (trust === 'blocked') {
        console.log('[SideCar] Workspace MCP servers blocked by user');
        return;
      }
      await mcpManager.connect(allServers);
    } catch (err) {
      console.error('[SideCar] Failed to connect MCP servers:', err);
    }
  };

  if (Object.keys(config.mcpServers).length > 0 || workspace.workspaceFolders?.length) {
    setImmediate(connectMcp);
  }

  // Reconnect MCP servers when settings change
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidecar.mcpServers')) {
        connectMcp().catch((err) => console.error('[SideCar] Failed to reconnect MCP servers:', err));
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

  // Load built-in + user + project skills
  const skillLoader = new SkillLoader();
  skillLoader.setBuiltinPath(path.join(context.extensionPath, 'skills'));
  skillLoader.initialize().catch((err) => console.warn('[SideCar] Skill loading failed:', err));

  const workspaceIndex = new WorkspaceIndex();
  workspaceIndex.setSidecarDir(sidecarDir);
  context.subscriptions.push(workspaceIndex);

  // Initialize symbol graph indexer
  const symbolIndexer = new SymbolIndexer(sidecarDir);
  context.subscriptions.push(symbolIndexer);

  // Initialize workspace index in the background with progress indicator
  if (workspace.workspaceFolders && workspace.workspaceFolders.length > 0) {
    const indexStatus = window.createStatusBarItem(StatusBarAlignment.Left, 0);
    indexStatus.text = '$(sync~spin) SideCar: Indexing workspace...';
    indexStatus.show();
    context.subscriptions.push(indexStatus);
    workspaceIndex
      .initialize(getFilePatterns())
      .then(async () => {
        const count = workspaceIndex.getFileCount();
        console.log(`[SideCar] Workspace indexed: ${count} files`);
        indexStatus.text = `$(check) SideCar: ${count} files indexed`;
        setTimeout(() => indexStatus.dispose(), 5000);

        // Build symbol graph after workspace index is ready
        symbolIndexer
          .initialize(getFilePatterns())
          .then(() => {
            const symCount = symbolIndexer.getGraph().symbolCount();
            console.log(`[SideCar] Symbol graph built: ${symCount} symbols`);
            workspaceIndex.setSymbolIndexer(symbolIndexer);
            setSymbolGraph(symbolIndexer.getGraph());
          })
          .catch((err) => console.warn('[SideCar] Symbol graph build failed:', err));

        // Build semantic embedding index (background, non-blocking)
        if (config.enableSemanticSearch) {
          const { EmbeddingIndex } = await import('./config/embeddingIndex.js');
          const embeddingIndex = new EmbeddingIndex(sidecarDir);
          context.subscriptions.push(embeddingIndex);
          embeddingIndex
            .initialize()
            .then(() => {
              workspaceIndex.setEmbeddingIndex(embeddingIndex);
              console.log(`[SideCar] Embedding index ready: ${embeddingIndex.getCount()} cached vectors`);
              // Queue initial embedding for all indexed files
              for (const file of workspaceIndex.getFiles()) {
                embeddingIndex.queuePath(file.relativePath, workspace.workspaceFolders![0].uri.fsPath);
              }
            })
            .catch((err) => console.warn('[SideCar] Embedding index failed:', err.message || err));
        }
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

  // Discover available models on startup, but only when using local backends.
  // Remote-only providers (anthropic, openai) don't benefit from probing localhost.
  const provider = detectProvider(config.baseUrl, config.provider);
  if (provider === 'ollama' || provider === 'kickstand') {
    setImmediate(() => {
      const ollamaUrl = isLocalOllama(config.baseUrl) ? config.baseUrl : 'http://localhost:11434';
      const kickstandUrl = isKickstand(config.baseUrl) ? config.baseUrl : 'http://localhost:11435';
      const apiKey = readKickstandToken();
      SideCarClient.discoverAllAvailableModels(ollamaUrl, kickstandUrl, apiKey)
        .then((models) => {
          if (models.length > 0) {
            const modelNames = models.map((m) => m.name).join(', ');
            console.log(`[SideCar] Discovered ${models.length} available models: ${modelNames}`);
          } else {
            console.log('[SideCar] No models discovered from Ollama or Kickstand');
          }
        })
        .catch((err) => {
          console.warn('[SideCar] Model discovery failed:', err.message);
        });
    });
  }

  // Inline edit provider — "tab to apply" ghost text for agent-proposed edits
  const inlineEditProvider = new InlineEditProvider();
  context.subscriptions.push(inlineEditProvider);
  context.subscriptions.push(languages.registerInlineCompletionItemProvider({ pattern: '**' }, inlineEditProvider));

  // Register the accepted callback command (fires after VS Code applies the inline completion)
  context.subscriptions.push(
    commands.registerCommand('sidecar.onInlineEditAccepted', () => {
      inlineEditProvider.accept();
    }),
  );

  chatProvider = new ChatViewProvider(
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

  // Watch the integrated terminal for failed commands and offer to diagnose
  // them in the chat. Skips SideCar's own terminal to avoid feedback loops.
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
        await chatProvider?.diagnoseTerminalError(event);
      }
    },
  });
  context.subscriptions.push(terminalErrorWatcher);

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
    commands.registerCommand('sidecar.setApiKey', async () => {
      const value = await window.showInputBox({
        prompt: 'Enter your API key (stored securely in VS Code SecretStorage)',
        password: true,
        ignoreFocusOut: true,
      });
      if (value !== undefined) {
        await setApiKeySecret(value);
        window.showInformationMessage('SideCar API key saved to SecretStorage.');
      }
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
    commands.registerCommand('sidecar.discoverModels', async () => {
      const message = window.createStatusBarItem(StatusBarAlignment.Left);
      message.text = '$(sync~spin) SideCar: Discovering available models...';
      message.show();

      try {
        const cfg = getConfig();
        const ollamaUrl = isLocalOllama(cfg.baseUrl) ? cfg.baseUrl : 'http://localhost:11434';
        const kickstandUrl = isKickstand(cfg.baseUrl) ? cfg.baseUrl : 'http://localhost:11435';
        const apiKey = readKickstandToken();
        const models = await SideCarClient.discoverAllAvailableModels(ollamaUrl, kickstandUrl, apiKey);

        if (models.length === 0) {
          window.showInformationMessage('SideCar: No models found. Make sure Ollama or Kickstand is running.');
        } else {
          const modelList = models.map((m) => m.name).join(', ');
          window.showInformationMessage(`SideCar: Discovered ${models.length} models: ${modelList}`);
          console.log(`[SideCar] Discovered models: ${modelList}`);
        }
      } catch (error) {
        window.showErrorMessage(
          `SideCar: Failed to discover models: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        message.dispose();
      }
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
  chatProvider?.abort();
  disposeSidecarMdWatcher();
  disposeShellSession();
}
